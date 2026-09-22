#include "catalog/watcher.h"

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <filesystem>

#include <sys/eventfd.h>
#include <sys/inotify.h>

namespace latent {

namespace {

using clock = std::chrono::steady_clock;

// IN_CREATE is here for directories only — a file is reported when it is closed, not when
// it is created, because a half-copied JPEG is not a photo yet. IN_MOVED_TO covers the
// other way a finished file appears: written elsewhere and renamed in, which is what every
// careful downloader does.
constexpr uint32_t kEvents = IN_CLOSE_WRITE | IN_MOVED_TO | IN_CREATE | IN_ONLYDIR;

// A card copy is a burst. Wait for it to go quiet before importing, but never hold a file
// longer than the ceiling, or a slow trickle would never arrive at all.
constexpr auto kQuietPeriod = std::chrono::milliseconds(750);
constexpr auto kMaxBatch = std::chrono::seconds(4);

constexpr size_t kBufferSize = size_t{64} * 1024;

int poll_timeout_ms(clock::time_point last_event, clock::time_point first_event) {
  const clock::time_point now = clock::now();
  const auto quiet_left =
      std::chrono::duration_cast<std::chrono::milliseconds>(kQuietPeriod - (now - last_event));
  const auto batch_left =
      std::chrono::duration_cast<std::chrono::milliseconds>(kMaxBatch - (now - first_event));
  const auto left = std::min(quiet_left, batch_left);
  return static_cast<int>(std::max<int64_t>(0, left.count()));
}

}  // namespace

FolderWatcher::FolderWatcher(Callback on_files) : on_files_(std::move(on_files)) {
  inotify_fd_ = inotify_init1(IN_CLOEXEC);
  if (inotify_fd_ < 0) {
    std::fprintf(stderr, "[warn] folder watch unavailable: %s\n", std::strerror(errno));
    return;
  }
  wake_fd_ = eventfd(0, EFD_CLOEXEC);
  if (wake_fd_ < 0) {
    std::fprintf(stderr, "[warn] folder watch unavailable: %s\n", std::strerror(errno));
    ::close(inotify_fd_);
    inotify_fd_ = -1;
    return;
  }
  thread_ = std::thread([this] { run(); });
}

FolderWatcher::~FolderWatcher() {
  stopping_.store(true);
  if (wake_fd_ >= 0) {
    const uint64_t one = 1;
    // A short write here would strand the thread in poll(); there is nothing else to do
    // about it, and eventfd does not do short writes.
    const ssize_t written = ::write(wake_fd_, &one, sizeof(one));
    static_cast<void>(written);
  }
  if (thread_.joinable()) thread_.join();
  if (inotify_fd_ >= 0) ::close(inotify_fd_);
  if (wake_fd_ >= 0) ::close(wake_fd_);
}

void FolderWatcher::watch(const std::string& root, bool recursive) {
  if (!active()) return;
  std::error_code error;
  if (!std::filesystem::is_directory(root, error)) return;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    const auto same = [&root](const WatchedRoot& known) { return known.path == root; };
    auto existing = std::find_if(roots_.begin(), roots_.end(), same);
    if (existing != roots_.end()) {
      // Re-watching recursively widens a root that was added for one directory only.
      if (!recursive || existing->recursive) return;
      existing->recursive = true;
    } else {
      roots_.push_back({root, recursive});
    }
  }
  add_tree(root, recursive);
}

std::vector<WatchedRoot> FolderWatcher::roots() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return roots_;
}

size_t FolderWatcher::watch_count() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return watches_.size();
}

void FolderWatcher::add_one(const std::string& path, bool recursive) {
  const int descriptor = inotify_add_watch(inotify_fd_, path.c_str(), kEvents);
  if (descriptor < 0) {
    // ENOSPC is the per-user watch limit, and it is the one worth saying out loud: the
    // folder stays in the catalog and stays rescannable, it just will not update itself.
    if (errno == ENOSPC) {
      std::fprintf(stderr, "[warn] inotify watch limit reached; %s will not update itself\n",
                   path.c_str());
    }
    return;
  }
  const std::lock_guard<std::mutex> lock(mutex_);
  // inotify hands back the same descriptor for a directory already watched, which is how
  // overlapping roots collapse into one watch. The wider of the two wins, so a directory
  // that is both a flat root and inside a recursive one still follows its subdirectories.
  const auto known = watches_.find(descriptor);
  if (known != watches_.end()) {
    known->second.recursive = known->second.recursive || recursive;
    return;
  }
  watches_.emplace(descriptor, WatchedRoot{path, recursive});
}

void FolderWatcher::add_tree(const std::string& path, bool recursive) {
  add_one(path, recursive);
  if (!recursive) return;
  std::error_code error;
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(path, options, error)) {
    if (entry.is_directory(error)) add_one(entry.path().string(), true);
  }
}

void FolderWatcher::absorb(const std::string& path, std::vector<std::string>& pending) {
  add_tree(path, true);
  std::error_code error;
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(path, options, error)) {
    if (entry.is_regular_file(error)) pending.push_back(entry.path().string());
  }
}

void FolderWatcher::handle(const inotify_event& event, const std::string& name,
                           std::vector<std::string>& pending) {
  if ((event.mask & IN_Q_OVERFLOW) != 0) {
    std::fprintf(stderr, "[warn] inotify queue overflowed; some new files need a rescan\n");
    return;
  }
  WatchedRoot directory;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    if ((event.mask & IN_IGNORED) != 0) {
      watches_.erase(event.wd);
      return;
    }
    const auto known = watches_.find(event.wd);
    if (known == watches_.end()) return;
    directory = known->second;
  }
  if (name.empty()) return;
  const std::string path = directory.path + "/" + name;

  if ((event.mask & IN_ISDIR) != 0) {
    if (directory.recursive) absorb(path, pending);
    return;
  }
  if ((event.mask & (IN_CLOSE_WRITE | IN_MOVED_TO)) != 0) pending.push_back(path);
}

bool FolderWatcher::drain(std::vector<std::string>& pending) {
  alignas(inotify_event) std::array<char, kBufferSize> buffer{};
  const ssize_t got = ::read(inotify_fd_, buffer.data(), buffer.size());
  if (got < 0) return errno == EINTR || errno == EAGAIN;
  if (got == 0) return true;

  size_t offset = 0;
  while (offset + sizeof(inotify_event) <= static_cast<size_t>(got)) {
    // The event is a header followed by a NUL-padded name of `len` bytes; copy the header
    // out rather than reading it through a cast, because the buffer is only char-aligned
    // as far as the type system is concerned.
    inotify_event header{};
    std::memcpy(&header, buffer.data() + offset, sizeof(header));
    const size_t name_at = offset + sizeof(inotify_event);
    std::string name;
    if (header.len > 0 && name_at + header.len <= static_cast<size_t>(got)) {
      name = std::string(buffer.data() + name_at);
    }
    offset = name_at + header.len;
    handle(header, name, pending);
  }
  return true;
}

void FolderWatcher::run() {
  std::vector<std::string> pending;
  clock::time_point first_event;
  clock::time_point last_event;

  while (!stopping_.load()) {
    std::array<pollfd, 2> fds{pollfd{inotify_fd_, POLLIN, 0}, pollfd{wake_fd_, POLLIN, 0}};
    const int timeout = pending.empty() ? -1 : poll_timeout_ms(last_event, first_event);
    const int ready = ::poll(fds.data(), fds.size(), timeout);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return;
    }
    if (stopping_.load() || fds[1].revents != 0) return;

    if (ready > 0 && fds[0].revents != 0) {
      const bool was_empty = pending.empty();
      if (!drain(pending)) return;
      if (!pending.empty()) {
        if (was_empty) first_event = clock::now();
        last_event = clock::now();
      }
      // Never flush straight off a read: the timeout is recomputed on the next turn, and
      // a batch that is already due comes back here through a zero-length poll.
      continue;
    }
    if (pending.empty()) continue;
    // Either the quiet period elapsed or the batch hit its ceiling. Same file twice in one
    // batch is one import.
    std::sort(pending.begin(), pending.end());
    pending.erase(std::unique(pending.begin(), pending.end()), pending.end());
    on_files_(std::move(pending));
    pending.clear();
  }
}

}  // namespace latent

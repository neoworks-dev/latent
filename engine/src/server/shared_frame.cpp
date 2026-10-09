#include "server/shared_frame.h"

#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include <filesystem>
#include <stdexcept>
#include <system_error>
#include <utility>

#include <sys/stat.h>

namespace latent {

namespace {

constexpr const char* kSharedDirectory = "/dev/shm";
constexpr const char* kPrefix = "latent-";

}  // namespace

std::optional<SharedFrameFile> SharedFrameFile::create(std::string path) {
  // Only this user's processes may read a frame: 0600, and O_EXCL so a file someone else
  // put at the name first is never written through.
  const int fd = ::open(path.c_str(), O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) return std::nullopt;
  return SharedFrameFile(std::move(path), fd);
}

SharedFrameFile::SharedFrameFile(SharedFrameFile&& other) noexcept
    : path_(std::move(other.path_)), fd_(std::exchange(other.fd_, -1)), size_(other.size_) {}

SharedFrameFile& SharedFrameFile::operator=(SharedFrameFile&& other) noexcept {
  if (this == &other) return *this;
  release();
  path_ = std::move(other.path_);
  fd_ = std::exchange(other.fd_, -1);
  size_ = other.size_;
  return *this;
}

SharedFrameFile::~SharedFrameFile() {
  release();
}

void SharedFrameFile::release() {
  if (fd_ < 0) return;
  ::close(fd_);
  ::unlink(path_.c_str());
  fd_ = -1;
}

void SharedFrameFile::write(std::span<const uint8_t> bytes) {
  // A smaller frame than the last (a draft after a full one) leaves the tail in place; the
  // client reads exactly the header's width·height·4, so it never sees it.
  if (bytes.size() > size_) {
    if (::ftruncate(fd_, static_cast<off_t>(bytes.size())) != 0) {
      throw std::system_error(errno, std::generic_category(), "ftruncate " + path_);
    }
    size_ = bytes.size();
  }
  size_t written = 0;
  while (written < bytes.size()) {
    const ssize_t chunk =
        ::pwrite(fd_, bytes.data() + written, bytes.size() - written, static_cast<off_t>(written));
    if (chunk < 0 && errno == EINTR) continue;
    if (chunk <= 0) throw std::system_error(errno, std::generic_category(), "pwrite " + path_);
    written += static_cast<size_t>(chunk);
  }
}

std::optional<SharedFrames> SharedFrames::create(uint32_t view_id) {
  std::error_code error;
  if (!std::filesystem::is_directory(kSharedDirectory, error)) return std::nullopt;
  const std::string stem = std::string(kSharedDirectory) + "/" + kPrefix +
                           std::to_string(::getpid()) + "-view-" + std::to_string(view_id) + "-";
  std::optional<SharedFrameFile> first = SharedFrameFile::create(stem + "0");
  if (!first) return std::nullopt;
  std::optional<SharedFrameFile> second = SharedFrameFile::create(stem + "1");
  if (!second) return std::nullopt;
  return SharedFrames{{std::move(*first), std::move(*second)}};
}

void sweep_stale_shared_frames() {
  std::error_code error;
  std::filesystem::directory_iterator entries(kSharedDirectory, error);
  if (error) return;
  for (const auto& entry : entries) {
    const std::string name = entry.path().filename().string();
    if (!name.starts_with(kPrefix)) continue;
    const std::string rest = name.substr(std::char_traits<char>::length(kPrefix));
    const size_t dash = rest.find('-');
    if (dash == std::string::npos || !rest.substr(dash).starts_with("-view-")) continue;
    char* end = nullptr;
    const long pid = std::strtol(rest.c_str(), &end, 10);
    if (pid <= 0 || end != rest.c_str() + dash) continue;
    // ESRCH is the only answer that means gone; EPERM is a live process of someone else.
    if (::kill(static_cast<pid_t>(pid), 0) == 0 || errno != ESRCH) continue;
    std::filesystem::remove(entry.path(), error);
  }
}

}  // namespace latent

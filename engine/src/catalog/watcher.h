// A live watch on the folders the catalog was imported from. A photo that lands in one of
// them while Latent is running shows up in the grid on its own, which is what a card copy,
// a tether or a phone sync looks like from here.
//
// inotify, one fd, one thread. Linux only — the daemon has never shipped anywhere else, and
// the alternative (polling a few hundred directories on a timer) costs a stat storm per tick
// for the same answer. Every method is safe to call from another thread.
#pragma once

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

struct inotify_event;

namespace latent {

struct WatchedRoot {
  std::string path;
  bool recursive = true;
};

class FolderWatcher {
 public:
  // Called on the watcher's own thread with absolute paths of files that have finished
  // landing. Batched over a quiet period, so copying 200 files in is one call and not 200,
  // and never filtered: the watcher does not know what a photo is. Paths can repeat across
  // calls — a file written twice is reported twice.
  using Callback = std::function<void(std::vector<std::string>)>;

  explicit FolderWatcher(Callback on_files);
  ~FolderWatcher();
  FolderWatcher(const FolderWatcher&) = delete;
  FolderWatcher& operator=(const FolderWatcher&) = delete;

  // False when inotify could not be opened at all (a container without it, or the per-user
  // instance limit). Every other method then does nothing and the catalog is rescan-only.
  bool active() const { return inotify_fd_ >= 0; }

  // Watches `root`, and every directory under it when `recursive`. Directories created
  // under a recursive root later are picked up with whatever is already inside them.
  // Watching the same root twice is a no-op; a missing root is ignored.
  void watch(const std::string& root, bool recursive);

  std::vector<WatchedRoot> roots() const;

  // Directories under watch, roots included. Tests assert on this; nothing else needs it.
  size_t watch_count() const;

 private:
  void run();
  // Reads everything queued on the fd into `pending`. Returns false when the fd died.
  bool drain(std::vector<std::string>& pending);
  void handle(const inotify_event& event, const std::string& name,
              std::vector<std::string>& pending);
  // Adds `path` itself, plus every directory under it when `recursive`.
  void add_tree(const std::string& path, bool recursive);
  void add_one(const std::string& path, bool recursive);
  // A directory that appeared under a recursive root: watch it and report the files it
  // already holds, because they may have been copied in before the watch landed.
  void absorb(const std::string& path, std::vector<std::string>& pending);

  Callback on_files_;
  int inotify_fd_ = -1;
  // eventfd the destructor pokes; a blocking poll has no other way out.
  int wake_fd_ = -1;
  mutable std::mutex mutex_;
  // Watch descriptor -> the directory it is on. `recursive` rides along so an event about a
  // new subdirectory knows whether to follow it.
  std::unordered_map<int, WatchedRoot> watches_;
  std::vector<WatchedRoot> roots_;
  std::atomic<bool> stopping_{false};
  std::thread thread_;
};

}  // namespace latent

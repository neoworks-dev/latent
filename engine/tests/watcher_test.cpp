#include "catalog/watcher.h"

#include <chrono>
#include <unistd.h>

#include <algorithm>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>

using namespace latent;

namespace {

// The watcher batches over a quiet period of 750 ms, so every wait here has to outlast it
// by a comfortable margin. A machine under load is the only thing that would fail these.
constexpr auto kWait = std::chrono::seconds(5);

class TemporaryDirectory {
 public:
  TemporaryDirectory()
      : path_(std::filesystem::temp_directory_path() /
              ("latent-watch-" + std::to_string(::getpid()) + "-" + std::to_string(++counter_))) {
    std::filesystem::create_directories(path_);
  }
  ~TemporaryDirectory() {
    std::error_code error;
    std::filesystem::remove_all(path_, error);
  }
  TemporaryDirectory(const TemporaryDirectory&) = delete;
  TemporaryDirectory& operator=(const TemporaryDirectory&) = delete;

  const std::filesystem::path& path() const { return path_; }
  std::string child(const std::string& name) const { return (path_ / name).string(); }

 private:
  static int counter_;
  std::filesystem::path path_;
};

int TemporaryDirectory::counter_ = 0;

void write_file(const std::string& path) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  file << "not really a photo";
}

// Collects what the watcher reports and lets a test block until a file it names shows up.
class Collector {
 public:
  FolderWatcher::Callback callback() {
    return [this](std::vector<std::string> paths) {
      const std::lock_guard<std::mutex> lock(mutex_);
      seen_.insert(seen_.end(), paths.begin(), paths.end());
      arrived_.notify_all();
    };
  }

  bool wait_for(const std::string& path) {
    std::unique_lock<std::mutex> lock(mutex_);
    return arrived_.wait_for(lock, kWait, [this, &path] {
      return std::find(seen_.begin(), seen_.end(), path) != seen_.end();
    });
  }

  std::vector<std::string> seen() {
    const std::lock_guard<std::mutex> lock(mutex_);
    return seen_;
  }

 private:
  std::mutex mutex_;
  std::condition_variable arrived_;
  std::vector<std::string> seen_;
};

}  // namespace

TEST_CASE("a file written into a watched folder is reported") {
  TemporaryDirectory directory;
  Collector collector;
  FolderWatcher watcher(collector.callback());
  if (!watcher.active()) {
    SUCCEED("inotify unavailable on this machine");
    return;
  }

  watcher.watch(directory.path().string(), false);
  write_file(directory.child("tree.jpg"));
  REQUIRE(collector.wait_for(directory.child("tree.jpg")));
}

TEST_CASE("a file moved into a watched folder is reported") {
  TemporaryDirectory source;
  TemporaryDirectory directory;
  Collector collector;
  FolderWatcher watcher(collector.callback());
  if (!watcher.active()) {
    SUCCEED("inotify unavailable on this machine");
    return;
  }

  watcher.watch(directory.path().string(), false);
  // How every careful copy lands: written somewhere else, renamed into place. Creating the
  // file in the target and watching for the close would miss it.
  write_file(source.child("moved.jpg"));
  std::filesystem::rename(source.child("moved.jpg"), directory.child("moved.jpg"));
  REQUIRE(collector.wait_for(directory.child("moved.jpg")));
}

TEST_CASE("a recursive watch follows a folder created after it") {
  TemporaryDirectory directory;
  Collector collector;
  FolderWatcher watcher(collector.callback());
  if (!watcher.active()) {
    SUCCEED("inotify unavailable on this machine");
    return;
  }

  watcher.watch(directory.path().string(), true);
  std::filesystem::create_directories(directory.path() / "day2" / "raw");
  write_file((directory.path() / "day2" / "raw" / "deep.arw").string());
  REQUIRE(collector.wait_for((directory.path() / "day2" / "raw" / "deep.arw").string()));
}

TEST_CASE("a folder dropped in whole is reported with what was already inside it") {
  TemporaryDirectory staging;
  TemporaryDirectory directory;
  Collector collector;
  FolderWatcher watcher(collector.callback());
  if (!watcher.active()) {
    SUCCEED("inotify unavailable on this machine");
    return;
  }

  // The race the watch alone cannot win: the files exist before the directory is visible,
  // so nothing is ever created inside a watched folder. Only walking it finds them.
  std::filesystem::create_directories(staging.path() / "card");
  write_file((staging.path() / "card" / "a.arw").string());
  watcher.watch(directory.path().string(), true);
  std::filesystem::rename(staging.path() / "card", directory.path() / "card");
  REQUIRE(collector.wait_for((directory.path() / "card" / "a.arw").string()));
}

TEST_CASE("a non-recursive watch ignores subfolders") {
  TemporaryDirectory directory;
  Collector collector;
  FolderWatcher watcher(collector.callback());
  if (!watcher.active()) {
    SUCCEED("inotify unavailable on this machine");
    return;
  }

  watcher.watch(directory.path().string(), false);
  std::filesystem::create_directories(directory.path() / "sub");
  write_file((directory.path() / "sub" / "ignored.jpg").string());
  write_file(directory.child("kept.jpg"));
  REQUIRE(collector.wait_for(directory.child("kept.jpg")));
  // The flat file and the nested one land in the same batch if the nested one lands at
  // all, so by the time the first has arrived the second has had its chance.
  const std::vector<std::string> seen = collector.seen();
  REQUIRE(std::find(seen.begin(), seen.end(),
                    (directory.path() / "sub" / "ignored.jpg").string()) == seen.end());
}

TEST_CASE("roots are remembered once and widen to recursive") {
  TemporaryDirectory directory;
  Collector collector;
  FolderWatcher watcher(collector.callback());
  if (!watcher.active()) {
    SUCCEED("inotify unavailable on this machine");
    return;
  }

  std::filesystem::create_directories(directory.path() / "sub");
  watcher.watch(directory.path().string(), false);
  REQUIRE(watcher.watch_count() == 1);
  watcher.watch(directory.path().string(), true);
  REQUIRE(watcher.roots().size() == 1);
  REQUIRE(watcher.roots().at(0).recursive);
  REQUIRE(watcher.watch_count() == 2);

  // A path that is not a directory is not a root.
  watcher.watch(directory.child("nothing-here"), true);
  REQUIRE(watcher.roots().size() == 1);
}

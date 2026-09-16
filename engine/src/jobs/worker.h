// One background thread for everything that must not stall the server loop: raw decodes,
// catalog imports, thumbnail generation. Tasks run in submission order, so an import and
// the thumbnail job it queues cannot overtake each other.
#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace latent {

class Worker {
 public:
  Worker();
  ~Worker();
  Worker(const Worker&) = delete;
  Worker& operator=(const Worker&) = delete;

  void submit(std::function<void()> task);

  // A long task polls this and gives up early when the daemon is shutting down.
  bool stopping() const { return !running_; }

  // Blocks until the queue is empty and the running task has returned. Tests only.
  void drain();

 private:
  void loop();

  std::mutex mutex_;
  std::condition_variable wakeup_;
  std::condition_variable idle_;
  std::deque<std::function<void()>> queue_;
  std::atomic<bool> running_{true};
  bool busy_ = false;
  std::thread thread_;
};

}  // namespace latent

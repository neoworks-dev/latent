#include "jobs/worker.h"

#include <cstdio>

#include <exception>
#include <utility>

namespace latent {

Worker::Worker() : thread_([this] { loop(); }) {}

Worker::~Worker() {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
  }
  wakeup_.notify_all();
  thread_.join();
}

void Worker::submit(std::function<void()> task) {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    queue_.push_back(std::move(task));
  }
  wakeup_.notify_one();
}

void Worker::drain() {
  std::unique_lock<std::mutex> lock(mutex_);
  idle_.wait(lock, [this] { return queue_.empty() && !busy_; });
}

void Worker::loop() {
  while (true) {
    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      wakeup_.wait(lock, [this] { return !queue_.empty() || !running_; });
      // Shutdown drops whatever is still queued; a half-done import is re-runnable.
      if (!running_) return;
      task = std::move(queue_.front());
      queue_.pop_front();
      busy_ = true;
    }
    try {
      task();
    } catch (const std::exception& error) {
      std::fprintf(stderr, "[worker] task failed: %s\n", error.what());
    }
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      busy_ = false;
    }
    idle_.notify_all();
  }
}

}  // namespace latent

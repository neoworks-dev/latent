#pragma once

// A view's frames through shared memory instead of the socket (protocol view.open
// `sharedMemory`). The engine and the desktop app always run on one machine, and the bytes
// of a 6 MB frame through Chromium's WebSocket were most of a slider tick; a file on tmpfs
// is the same pages for both processes. Linux only: elsewhere there is no /dev/shm, the
// view says so by leaving `sharedMemory` out of its result, and frames stay on the socket.

#include <cstdint>

#include <array>
#include <optional>
#include <span>
#include <string>

namespace latent {

// One slot: a file under /dev/shm that is removed when this goes, so every path that drops
// a view — view.close, the photo closing, the socket going away — also frees its memory.
class SharedFrameFile {
 public:
  // Creates `path` for writing, or nothing when the file cannot be made.
  static std::optional<SharedFrameFile> create(std::string path);

  SharedFrameFile(SharedFrameFile&& other) noexcept;
  SharedFrameFile& operator=(SharedFrameFile&& other) noexcept;
  SharedFrameFile(const SharedFrameFile&) = delete;
  SharedFrameFile& operator=(const SharedFrameFile&) = delete;
  ~SharedFrameFile();

  // The whole frame, from offset 0. Throws when the write is short, so a client is never
  // told about pixels that are not there.
  void write(std::span<const uint8_t> bytes);

  const std::string& path() const { return path_; }

 private:
  SharedFrameFile(std::string path, int fd) : path_(std::move(path)), fd_(fd) {}
  void release();

  std::string path_;
  int fd_ = -1;
  size_t size_ = 0;
};

// Two slots, written alternately by `seq`: the frame being read and the one being written
// never share a file. The client reads a frame in the message that announces it and asks
// for the next render only after that, so two slots are enough.
struct SharedFrames {
  std::array<SharedFrameFile, 2> slots;

  // Both slots for one view of this process, or nothing when shared memory is unavailable.
  static std::optional<SharedFrames> create(uint32_t view_id);
  SharedFrameFile& slot_for(uint32_t seq) { return slots.at(seq % 2); }
};

// Removes slot files left by an engine that died without cleaning up: their process id is
// in the name, and a process that is gone no longer needs them.
void sweep_stale_shared_frames();

}  // namespace latent

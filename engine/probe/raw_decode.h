// LibRaw decode to 16-bit linear RGBA, ready for an rgba16uint texture upload.
#pragma once

#include <cstdint>

#include <string>
#include <vector>

namespace probe {

struct DecodedRaw {
  uint32_t width = 0;
  uint32_t height = 0;
  // Interleaved RGBA, 16 bits per channel, alpha = 65535. Linear, camera white balance,
  // no auto-brightening, no gamma. Row-major, tightly packed.
  std::vector<uint16_t> rgba;
  std::string camera;
  double decode_ms = 0;
  double expand_ms = 0;
};

// Throws std::runtime_error with LibRaw's message on failure.
DecodedRaw decode_raw(const std::string& path);

}  // namespace probe

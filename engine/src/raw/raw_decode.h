// LibRaw decode to 16-bit linear RGBA, ready for an rgba16uint texture upload.
#pragma once

#include <cstdint>

#include <string>
#include <vector>

namespace latent {

struct DecodedRaw {
  uint32_t width = 0;
  uint32_t height = 0;
  // Interleaved RGBA, 16 bits per channel, alpha = 65535. Linear, camera white balance
  // applied, no auto-brightening, no gamma. Row-major, tightly packed.
  std::vector<uint16_t> rgba;
  std::string camera;
  double decode_ms = 0;
};

// Throws std::runtime_error with LibRaw's message on failure.
//
// `min_long_edge` lets a caller that only wants a proxy skip the demosaic: when halving the
// photo still leaves its long edge at or above the value, LibRaw bins each Bayer quad into
// one pixel instead of interpolating, which is ~150 ms rather than ~460 ms for 24 MP. Zero
// (the default) always decodes at full resolution. The result is whatever resolution was
// cheapest, so a caller passing this has to read `width`/`height` back.
DecodedRaw decode_raw(const std::string& path, uint32_t min_long_edge = 0);

}  // namespace latent

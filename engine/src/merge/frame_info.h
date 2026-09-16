// The exposure numbers a merge needs, straight from LibRaw. `raw_metadata.h` reports the
// shutter as a display string ("1/400") and stops at the nominal focal length, and a merge
// needs a number for the first and the 35 mm equivalent for the second, so this opens the
// file itself. It is a header read: no unpack, no demosaic.
#pragma once

#include <cstdint>

#include <array>
#include <string>

namespace latent {

struct FrameInfo {
  std::string camera;
  std::string captured_at;
  double shutter = 0;   // seconds
  double aperture = 0;  // f-number
  double iso = 0;
  double focal_length = 0;  // mm, as marked on the lens
  // 35 mm equivalent. 0 when the file does not carry one, which is what makes a
  // cylindrical or spherical projection fall back to a flat compose.
  double focal_length_35 = 0;
  // LibRaw's as-shot multipliers, recorded into the merged file's sidecar.
  std::array<double, 3> white_balance = {1.0, 1.0, 1.0};
  uint32_t width = 0;
  uint32_t height = 0;
};

// Throws std::runtime_error with LibRaw's message when the file will not open.
FrameInfo read_frame_info(const std::string& path);

// log2(N^2 / t) - log2(ISO / 100): the exposure value the frame was shot at, so a larger
// number is a darker frame. Returns 0 when the metadata is incomplete, which collapses a
// bracket to an average — wrong, but never a divide by zero.
double exposure_value(const FrameInfo& info);

// Horizontal focal length in pixels for a frame `width` px wide, from the 35 mm
// equivalent (36 mm frame width). 0 when the file did not say.
double focal_pixels(const FrameInfo& info, uint32_t width);

}  // namespace latent

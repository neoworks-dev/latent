// Merge to HDR (reference/lightroom/hdr-panorama.md). Debevec-style weighted average of
// exposure-scaled frames: a raw sensor is linear, so there is no camera response curve to
// recover and the estimate is just
//
//     L(p) = sum_i w(v_i) * v_i * 2^(ev_i - ev_ref) / sum_i w(v_i)
//
// with `w` a hat over the usable range. The result is divided by its own maximum so the
// 16-bit carrier holds it (source_image.h), and that divisor is reported back as `scale`.
#pragma once

#include "merge/merge_image.h"

#include <cstddef>

#include <functional>
#include <string>
#include <vector>

namespace latent {

// Lightroom's Deghost Amount.
enum class Deghost { None, Low, Medium, High };

Deghost deghost_from_name(const std::string& name);
const char* deghost_name(Deghost level);

struct HdrOptions {
  Deghost deghost = Deghost::None;
  bool auto_align = true;
};

struct HdrFrame {
  LinearImage image;
  // Exposure value the frame was shot at: larger is darker. Only differences matter.
  double ev = 0;
};

struct HdrOutcome {
  LinearImage image;
  // Stored value * scale = radiance relative to the brightest frame's white level.
  double scale = 1;
  // EV of headroom the merge won above a single frame's white level — log2(scale). The
  // carrier is still 16 bits, so the same number is what the shadows lose.
  double dynamic_range_ev = 0;
  // Fraction of pixels the deghost dropped at least one frame for, 0..1.
  double ghosted = 0;
  // Per frame, the alignment that was applied (all zero with auto_align off).
  std::vector<double> shift_x;
  std::vector<double> shift_y;
};

// Reports stage and progress; returning false from `cancelled` abandons the merge and
// throws std::runtime_error("cancelled").
struct MergeProgress {
  std::function<void(int done, int total, const std::string& stage)> tick;
  std::function<bool()> cancelled;
};

// `frames` must hold 2..7 images of the same size. Throws std::runtime_error otherwise.
HdrOutcome merge_hdr(std::vector<HdrFrame> frames, const HdrOptions& options,
                     const MergeProgress& progress);

}  // namespace latent

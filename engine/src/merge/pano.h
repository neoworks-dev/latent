// Merge to Panorama (reference/lightroom/hdr-panorama.md).
//
// ALGORITHM AND ITS LIMITS. This is translation-only stitching by multi-scale normalised
// cross-correlation, not feature matching with RANSAC homographies. Each consecutive pair
// is aligned with `align_overlap`, the shifts chain from the first frame, and the frames
// are composed into one canvas with a feathered blend. What that buys and what it costs:
//
//   + No descriptor, no matcher, no RANSAC, no bundle adjustment: a few hundred lines
//     instead of a few thousand, and nothing to tune.
//   + A rotational pan is a translation once the frames are on a cylinder, so the
//     `cylindrical` and `spherical` projections pre-warp each frame around the focal
//     length from EXIF and then the translation model is the right one.
//   - Without a 35 mm equivalent focal length in the file there is no cylinder to warp
//     onto, so the merge falls back to `perspective` (a flat compose) and says so.
//   - No rotation between frames, no scale, no parallax: a hand-held pan with roll, a
//     zoom between frames, or a close foreground will not close. Lightroom's does.
//   - A multi-row panorama chains along the given order only; it is a strip, not a grid.
//   - Blending is a feathered linear cross-fade with a per-frame gain match, not multiband.
//     A seam through a hard edge under changing exposure can still show as a soft band.
#pragma once

#include "merge/hdr.h"
#include "merge/merge_image.h"

#include <cstdint>

#include <string>
#include <vector>

namespace latent {

enum class Projection { Spherical, Cylindrical, Perspective };

Projection projection_from_name(const std::string& name);
const char* projection_name(Projection projection);

struct PanoOptions {
  Projection projection = Projection::Cylindrical;
  // 0..100. Warps the mosaic toward the crop rectangle instead of throwing the uneven
  // edges away; 0 is Lightroom's "off" and 100 stretches the valid content to the frame.
  int boundary_warp = 0;
  bool auto_crop = true;
};

struct PanoFrame {
  LinearImage image;
  // Horizontal focal length in pixels (frame_info.h). 0 = unknown, which forces a flat
  // compose whatever `projection` says.
  double focal_px = 0;
};

struct PanoOutcome {
  LinearImage image;
  // What was actually used: `perspective` when no frame carried a focal length.
  Projection projection = Projection::Perspective;
  // Per pair, the chained offset in canvas pixels and the correlation that produced it.
  std::vector<double> offset_x;
  std::vector<double> offset_y;
  std::vector<double> match_score;
  // Share of the crop that held real pixels before the crop, 0..1.
  double coverage = 0;
};

// `frames` must hold 2..12 images. Throws std::runtime_error otherwise, or when a pair
// fails to correlate at all.
PanoOutcome merge_panorama(std::vector<PanoFrame> frames, const PanoOptions& options,
                           const MergeProgress& progress);

}  // namespace latent

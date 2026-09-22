// Merge to Star Trails. Lightroom has no such merge; the reference is what a night
// sequence needs: a few hundred frames of the same tripod framing, combined so the stars
// draw arcs.
//
// ALGORITHM. Per pixel, the brightest value any frame holds ("lighten"), or their mean
// ("average", a noise-reduced single exposure). A star moves between frames, so the
// maximum keeps it everywhere it has been; the ground does not move, so it stays as it
// was. There is no registration and no deghosting: a star trail merge assumes a tripod,
// and aligning the frames would straighten the trails, which is the opposite of the point.
//
// STREAMING. 300 frames of 24 MP is 86 GB as floats, so this never holds the sequence:
// `StarTrailStack::add` folds one frame into the accumulator and drops it. Peak is the
// accumulator plus, with gap fill on, the previous frame and one warp of it — four buffers
// rather than N (merge_image.h has the per-pixel budget).
//
// LIMITS.
//   - No alignment, so a bumped tripod or a drifting mount doubles the landscape.
//   - Gap fill models the sky's motion between two frames as a *translation* measured by
//     cross-correlation over the high-passed luminance. That is right near the celestial
//     equator and over short intervals; near the pole the motion is a rotation and the
//     fill closes the gaps only in the middle of the frame. A frame whose landscape
//     outweighs its stars correlates at zero shift and the fill does nothing — the outcome
//     reports the measured shift so a caller can say so.
//   - The output is bounded by the brightest frame's white level, so `scale` is 1: a
//     lighten merge wins no dynamic range, it only wins time.
#pragma once

#include "merge/hdr.h"
#include "merge/merge_image.h"

#include <cstddef>
#include <cstdint>

#include <string>
#include <vector>

namespace latent {

// Lighten: the brightest frame per pixel — trails. Average: the mean — one long exposure
// with sqrt(N) less noise, and no trails unless the frames are minutes apart.
enum class TrailBlend { Lighten, Average };

// Where the still half of the picture comes from. Lighten takes it from the brightest
// frame like everything else, which also accumulates every frame's hot pixels and any
// headlight that swept the foreground. FirstFrame keeps frame one and lets a later frame
// through only where it is `foreground_threshold` brighter, which is the trails and not
// the noise.
enum class TrailForeground { Lighten, FirstFrame };

TrailBlend trail_blend_from_name(const std::string& name);
const char* trail_blend_name(TrailBlend blend);
TrailForeground trail_foreground_from_name(const std::string& name);
const char* trail_foreground_name(TrailForeground foreground);

struct StarTrailOptions {
  TrailBlend blend = TrailBlend::Lighten;
  // Synthetic sub-frames inserted between each pair, 0 (off) to 8. Each one is the later
  // frame pulled back a fraction of the measured inter-frame shift, so a star that jumped
  // during the camera's write time is drawn along the jump instead of twice.
  int gap_fill = 0;
  TrailForeground foreground = TrailForeground::Lighten;
  // 0..100, as a percentage of the white level: how far above frame one a pixel must be
  // before FirstFrame lets it through. Ignored by Lighten and by Average.
  double foreground_threshold = 2;
  // Comet tails, 0..100. 0 weights every frame equally; 100 fades the oldest frame 6 EV
  // down, so each trail brightens toward the star's last position.
  double decay = 0;
};

struct StarTrailOutcome {
  LinearImage image;
  size_t frames = 0;
  // Mean length in pixels of the inter-frame shift the gap fill measured, and the mean
  // correlation that produced it. Both 0 with gap fill off.
  double drift_px = 0;
  double match_score = 0;
};

// One merge, fed a frame at a time in shooting order. `frame_count` is what the caller
// will add: the comet weights need to know which frame is the newest before the last one
// arrives. Throws std::runtime_error on a frame whose size does not match the first.
class StarTrailStack {
 public:
  StarTrailStack(const StarTrailOptions& options, size_t frame_count,
                 const MergeProgress& progress);

  void add(LinearImage frame);
  // Consumes the accumulator. Adding after this is a std::runtime_error.
  StarTrailOutcome finish();

 private:
  void start(const LinearImage& frame, double weight);
  // Folds one frame in at `weight`, honouring the blend and the foreground rule.
  void fold(const LinearImage& frame, double weight);
  void fill_gap(const LinearImage& frame, double weight);

  StarTrailOptions options_;
  size_t frame_count_ = 0;
  size_t added_ = 0;
  bool finished_ = false;
  // Held by value: a stack outlives the expression that built it, and the caller's
  // callbacks are two std::functions.
  MergeProgress progress_;

  LinearImage accumulator_;
  // Average only: the weights each pixel's sum was built from. One number, not a plane —
  // every pixel of a frame carries the same weight.
  double weight_sum_ = 0;
  // FirstFrame only: the luminance of frame one, the threshold compares against it.
  GrayF base_luminance_;
  // Gap fill only: the previous frame, and its high-passed luminance for the correlation.
  LinearImage previous_;
  GrayF previous_stars_;
  double previous_weight_ = 1;
  double drift_total_ = 0;
  double score_total_ = 0;
  size_t pairs_ = 0;
};

// The whole sequence at once, for callers that already hold it (the tests, and a preview
// whose frames are embedded JPEGs). `frames` must hold at least two images of one size.
StarTrailOutcome merge_star_trail(std::vector<LinearImage> frames, const StarTrailOptions& options,
                                  const MergeProgress& progress);

}  // namespace latent

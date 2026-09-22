// The `trails` mask kind: box one aircraft trail in a night sky and get every other one
// in the frame.
//
// WHY NOT A MODEL. An aircraft trail is a thin, straight, brighter-than-the-sky streak,
// often dashed where the strobe blinked. That is a line detector's job, not a segmentation
// network's: there is no checkpoint to fetch, it runs in tens of milliseconds, it is
// deterministic, and — the reason this feature exists — the same params detect the trails
// in the *next* frame of the sequence without anything being copied between photos. A
// component carries the seed and the thresholds; every photo runs its own detection.
//
// HOW. Luminance minus its own local average is the sky's high-pass: stars and trails
// stand in it and the gradient of the sky does not. Every pixel of that residual gets a
// ridge orientation and a coherence out of the structure tensor, so a round star votes for
// nothing and a streak votes only for lines along itself. The votes go into a Hough
// accumulator; each peak is walked back along the line, the bright spans on it are merged
// across the strobe's gaps, and a run long enough and covered enough becomes a segment.
// The seed's own streak is measured first — from the pixels near the stroke the user drew
// along it — and sets the brightness, the width and the length everything else is judged
// against.
//
// LIMITS. Straight lines only: a satellite flare or a meteor reads as a trail too (which
// is usually what you want) but a curved trail near a long lens's edge does not. A star
// trail merge's arcs are not straight either, so this belongs on the single frames, before
// the stack. Nothing here knows about aircraft; it knows about streaks.
#pragma once

#include "ai/mask_detect.h"
#include "image/gray.h"
#include "image/jpeg.h"

#include <cstdint>

#include <array>
#include <string>
#include <vector>

namespace latent {

// One detected streak, in pixels of the image it was found in.
struct TrailSegment {
  double x0 = 0;
  double y0 = 0;
  double x1 = 0;
  double y1 = 0;
  // Half-width of the streak itself, before `grow`.
  double half_width = 1;
  // Peak residual along it, on the 0..1 scale of the luminance it came from.
  double brightness = 0;
  // True for the one the seed stroke was drawn along.
  bool seed = false;
};

struct TrailParams {
  // The stroke the user drew along one streak, normalised 0..1 over the image. A path and
  // not a box: a trail is a line, a box around a diagonal one is mostly sky, and drawing
  // along the thing you mean is the gesture. Two points is a straight swipe, which is all a
  // short trail needs. Without it there is nothing to match against and detection fails.
  std::vector<std::array<double, 2>> seed;
  // 0..100. How much dimmer than the seed's own streak a candidate may be: 0 takes only
  // streaks as bright as the seed, 100 takes anything that stands out of the sky at all.
  double sensitivity = 50;
  // Shortest streak kept, as a percentage of the image's long edge.
  double min_length = 10;
  // 0..100. How far past the streak's own edge the mask is drawn, as a percentage of a
  // fiftieth of the long edge. A removal wants margin; a selection usually does not.
  double grow = 25;
};

struct TrailDetection {
  bool ok = false;
  std::string message;
  std::vector<TrailSegment> segments;
  GrayImage raster;
};

TrailParams trail_params_from_json(const nlohmann::json& params);

// Detection on one rendered frame. Never throws for a picture it cannot find a streak in —
// that is an `ok == false` with a message, which is what the component shows.
TrailDetection find_trails(const Rgb8Image& image, const TrailParams& params);

// The mask.detect seam (ai/mask_detect.h). Runs with or without a model store: this is the
// one AI kind that needs neither.
MaskDetectResult run_trails(const MaskDetectRequest& request);

}  // namespace latent

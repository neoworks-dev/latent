// Global frame alignment. Two searches, because the two merges see different inputs.
//
// HDR brackets differ in exposure, so the score has to be exposure-invariant: this is
// Ward's median-threshold bitmap (MTB). Each level of a luminance pyramid becomes a
// bitmap of "brighter than this frame's own median" plus an exclusion mask around the
// median; the score is the population count of the XOR. A gain change moves every pixel
// the same way across the median, so the bitmap does not move. Feature matching is out of
// scope and MTB is the standard cheap answer for hand-held brackets.
//
// Panorama frames share an exposure but overlap by an unknown amount, so the score is
// normalised cross-correlation over whatever the two frames have in common, searched over
// the whole plausible shift range at the coarsest pyramid level and refined down.
//
// Both return a *similarity*: translation plus a small rotation. Neither recovers scale,
// perspective or parallax — see `merge.h` for what that costs.
#pragma once

#include "merge/merge_image.h"

namespace latent {

// Maps a point of the moving frame onto the reference: reference = R(angle) * moving + t.
struct Alignment {
  double dx = 0;
  double dy = 0;
  double angle = 0;  // radians, positive counter-clockwise
  // NCC of the winning offset, 0..1. `align_overlap` reports it so a caller can tell a
  // real match from the best of a set of bad ones; `align_mtb` leaves it at 1.
  double score = 1;
};

struct AlignOptions {
  // Search ±1.5 degrees in quarter-degree steps once the translation has converged.
  bool rotation = true;
  // Levels of the pyramid; each one doubles the shift the search can recover.
  int max_levels = 8;
};

// Hand-held bracket alignment. `reference` and `frame` must be the same size.
Alignment align_mtb(const GrayF& reference, const GrayF& frame, const AlignOptions& options);

// Panorama pair alignment. Searches every shift that leaves at least `min_overlap` of the
// frame area in common; `score` says how good the winner was.
Alignment align_overlap(const GrayF& reference, const GrayF& frame, double min_overlap);

// Resamples `source` through `alignment` into an image the size of `width` x `height`,
// writing 255 into `coverage` where a sample landed inside the source and 0 elsewhere.
void warp_frame(const LinearImage& source, const Alignment& alignment, LinearImage& target,
                std::vector<uint8_t>& coverage);

}  // namespace latent

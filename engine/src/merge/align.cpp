#include "merge/align.h"

#include <cmath>
#include <cstdint>

#include <algorithm>
#include <numbers>
#include <vector>

namespace latent {

namespace {

constexpr double kRotationLimit = 1.5 * std::numbers::pi_v<double> / 180.0;
constexpr int kRotationSteps = 12;  // quarter-degree steps over ±1.5 degrees
// Ward searches ±1 per level; ±2 at the top buys range for a long lens without costing
// anything measurable, because the coarsest level is a few hundred pixels.
constexpr int kCoarseRadius = 2;
constexpr int kRefineRadius = 1;
// Pixels whose luminance sits inside this percentile band around the median carry no
// information about the shift and are excluded, exactly as Ward's paper prescribes.
constexpr double kExclusionBand = 0.02;
// Clipped and black pixels are excluded before the median is taken, not after. Ward's
// paper assumes a well-exposed frame; the brightest bracket of a real HDR set can be
// saturated over half its area, and a median computed over that is the white level, which
// makes the bitmap constant and the search meaningless.
constexpr float kAlignFloor = 0.005F;
constexpr float kAlignCeiling = 0.97F;
// A rotation has to beat the un-rotated score by this much before it is believed. The
// search resamples the whole frame, so a spurious quarter-degree costs more in blur than
// the misalignment it claims to fix.
constexpr double kRotationGain = 0.97;

struct Bitmap {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> above;   // 1 where the pixel is brighter than the median
  std::vector<uint8_t> usable;  // 0 in the exclusion band around the median
};

double percentile(std::vector<float> values, double fraction) {
  if (values.empty()) return 0;
  const auto index = static_cast<size_t>(fraction * static_cast<double>(values.size() - 1));
  std::nth_element(values.begin(), values.begin() + static_cast<long>(index), values.end());
  return values[index];
}

Bitmap make_bitmap(const GrayF& gray) {
  Bitmap bitmap;
  bitmap.width = gray.width;
  bitmap.height = gray.height;
  bitmap.above.resize(gray.v.size());
  bitmap.usable.resize(gray.v.size());

  std::vector<float> exposed;
  exposed.reserve(gray.v.size());
  for (float value : gray.v) {
    if (value <= kAlignFloor || value >= kAlignCeiling) continue;
    exposed.push_back(value);
  }
  // A frame with almost nothing between black and white has no threshold worth finding;
  // fall back to the whole histogram rather than to an empty one.
  const std::vector<float>& sample = exposed.size() * 8 > gray.v.size() ? exposed : gray.v;
  const double median = percentile(sample, 0.5);
  const double low = percentile(sample, 0.5 - kExclusionBand);
  const double high = percentile(sample, 0.5 + kExclusionBand);
  for (size_t i = 0; i < gray.v.size(); ++i) {
    const float value = gray.v[i];
    bitmap.above[i] = value > median ? 1 : 0;
    const bool in_range = value > kAlignFloor && value < kAlignCeiling;
    bitmap.usable[i] = (in_range && (value < low || value > high)) ? 1 : 0;
  }
  return bitmap;
}

// Disagreeing pixels per usable pixel, so shifts with different overlaps compare fairly.
double bitmap_error(const Bitmap& reference, const Bitmap& moving, int dx, int dy) {
  int64_t mismatches = 0;
  int64_t counted = 0;
  const auto width = static_cast<int>(reference.width);
  const auto height = static_cast<int>(reference.height);
  for (int y = 0; y < height; ++y) {
    const int source_y = y - dy;
    if (source_y < 0 || source_y >= height) continue;
    for (int x = 0; x < width; ++x) {
      const int source_x = x - dx;
      if (source_x < 0 || source_x >= width) continue;
      const size_t target = static_cast<size_t>(y) * reference.width + x;
      const size_t source = static_cast<size_t>(source_y) * moving.width + source_x;
      if (reference.usable[target] == 0 || moving.usable[source] == 0) continue;
      ++counted;
      if (reference.above[target] != moving.above[source]) ++mismatches;
    }
  }
  if (counted < 64) return 1.0;
  return static_cast<double>(mismatches) / static_cast<double>(counted);
}

std::vector<GrayF> pyramid(const GrayF& gray, int max_levels) {
  std::vector<GrayF> levels;
  levels.push_back(gray);
  while (static_cast<int>(levels.size()) < max_levels && levels.back().width > 32 &&
         levels.back().height > 32) {
    levels.push_back(halve(levels.back()));
  }
  return levels;
}

GrayF rotate_gray(const GrayF& gray, double angle) {
  GrayF out;
  out.width = gray.width;
  out.height = gray.height;
  out.v.assign(gray.v.size(), 0.0F);
  const double centre_x = (gray.width - 1) * 0.5;
  const double centre_y = (gray.height - 1) * 0.5;
  const double cosine = std::cos(-angle);
  const double sine = std::sin(-angle);
  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      const double ox = x - centre_x;
      const double oy = y - centre_y;
      const double sx = centre_x + ox * cosine - oy * sine;
      const double sy = centre_y + ox * sine + oy * cosine;
      if (sx < 0 || sy < 0 || sx > gray.width - 1.0 || sy > gray.height - 1.0) continue;
      out.v[static_cast<size_t>(y) * out.width + x] =
          gray.at(static_cast<uint32_t>(sx), static_cast<uint32_t>(sy));
    }
  }
  return out;
}

struct Correlation {
  double score = -1;
  int dx = 0;
  int dy = 0;
};

// Normalised cross-correlation of the overlap. Invariant to a gain and an offset, which
// is what makes it usable across frames the camera metered separately.
double overlap_ncc(const GrayF& reference, const GrayF& moving, int dx, int dy,
                   int64_t min_pixels) {
  double sum_a = 0;
  double sum_b = 0;
  double sum_aa = 0;
  double sum_bb = 0;
  double sum_ab = 0;
  int64_t counted = 0;
  const auto width = static_cast<int>(reference.width);
  const auto height = static_cast<int>(reference.height);
  for (int y = 0; y < height; ++y) {
    const int source_y = y - dy;
    if (source_y < 0 || source_y >= static_cast<int>(moving.height)) continue;
    for (int x = 0; x < width; ++x) {
      const int source_x = x - dx;
      if (source_x < 0 || source_x >= static_cast<int>(moving.width)) continue;
      const double a = reference.at(static_cast<uint32_t>(x), static_cast<uint32_t>(y));
      const double b = moving.at(static_cast<uint32_t>(source_x), static_cast<uint32_t>(source_y));
      sum_a += a;
      sum_b += b;
      sum_aa += a * a;
      sum_bb += b * b;
      sum_ab += a * b;
      ++counted;
    }
  }
  if (counted < min_pixels) return -1;
  const auto n = static_cast<double>(counted);
  const double covariance = sum_ab - sum_a * sum_b / n;
  const double variance_a = sum_aa - sum_a * sum_a / n;
  const double variance_b = sum_bb - sum_b * sum_b / n;
  if (variance_a <= 1e-12 || variance_b <= 1e-12) return -1;
  return covariance / std::sqrt(variance_a * variance_b);
}

Correlation search_ncc(const GrayF& reference, const GrayF& moving, int x_min, int x_max, int y_min,
                       int y_max, int64_t min_pixels) {
  Correlation best;
  for (int dy = y_min; dy <= y_max; ++dy) {
    for (int dx = x_min; dx <= x_max; ++dx) {
      const double score = overlap_ncc(reference, moving, dx, dy, min_pixels);
      if (score <= best.score) continue;
      best.score = score;
      best.dx = dx;
      best.dy = dy;
    }
  }
  return best;
}

}  // namespace

Alignment align_mtb(const GrayF& reference, const GrayF& frame, const AlignOptions& options) {
  Alignment alignment;
  if (reference.width != frame.width || reference.height != frame.height) return alignment;

  const std::vector<GrayF> reference_levels = pyramid(reference, options.max_levels);
  const std::vector<GrayF> frame_levels = pyramid(frame, options.max_levels);
  int dx = 0;
  int dy = 0;
  for (int level = static_cast<int>(reference_levels.size()) - 1; level >= 0; --level) {
    const Bitmap target = make_bitmap(reference_levels[static_cast<size_t>(level)]);
    const Bitmap moving = make_bitmap(frame_levels[static_cast<size_t>(level)]);
    const int radius =
        level == static_cast<int>(reference_levels.size()) - 1 ? kCoarseRadius : kRefineRadius;
    double best = bitmap_error(target, moving, dx, dy);
    int best_dx = dx;
    int best_dy = dy;
    for (int oy = -radius; oy <= radius; ++oy) {
      for (int ox = -radius; ox <= radius; ++ox) {
        const double error = bitmap_error(target, moving, dx + ox, dy + oy);
        if (error >= best) continue;
        best = error;
        best_dx = dx + ox;
        best_dy = dy + oy;
      }
    }
    dx = best_dx;
    dy = best_dy;
    if (level > 0) {
      dx *= 2;
      dy *= 2;
    }
  }
  alignment.dx = dx;
  alignment.dy = dy;
  if (!options.rotation || reference_levels.size() < 3) return alignment;

  // Rotation last and at quarter resolution: a whole-frame roll of a degree is tens of
  // pixels at the corners and invisible at the centre, so the translation above found it
  // as a compromise and this only has to take the compromise back out.
  const size_t level = 2;
  const int scale = 1 << level;
  const GrayF& coarse_reference = reference_levels[level];
  const Bitmap target = make_bitmap(coarse_reference);
  const int coarse_dx = static_cast<int>(alignment.dx) / scale;
  const int coarse_dy = static_cast<int>(alignment.dy) / scale;
  const double flat_error =
      bitmap_error(target, make_bitmap(frame_levels[level]), coarse_dx, coarse_dy);
  double best_error = flat_error * kRotationGain;
  for (int step = -kRotationSteps; step <= kRotationSteps; ++step) {
    if (step == 0) continue;
    const double angle = kRotationLimit * step / kRotationSteps;
    const Bitmap rotated = make_bitmap(rotate_gray(frame_levels[level], angle));
    const double error = bitmap_error(target, rotated, coarse_dx, coarse_dy);
    if (error >= best_error) continue;
    best_error = error;
    alignment.angle = angle;
  }
  return alignment;
}

Alignment align_overlap(const GrayF& reference, const GrayF& frame, double min_overlap) {
  Alignment alignment;
  const std::vector<GrayF> reference_levels = pyramid(reference, 8);
  const std::vector<GrayF> frame_levels = pyramid(frame, 8);
  const auto top = static_cast<int>(reference_levels.size()) - 1;

  // The coarsest level is a few dozen pixels on a side, so the first search can afford to
  // cover every shift that still leaves `min_overlap` of the frame in common.
  const GrayF& coarse = reference_levels[static_cast<size_t>(top)];
  const auto span_x = static_cast<int>(coarse.width * (1.0 - min_overlap));
  const auto span_y = static_cast<int>(coarse.height * (1.0 - min_overlap));
  const auto min_pixels = static_cast<int64_t>(min_overlap * coarse.width * coarse.height * 0.5);
  Correlation best = search_ncc(coarse, frame_levels[static_cast<size_t>(top)], -span_x, span_x,
                                -span_y, span_y, min_pixels);
  int dx = best.dx;
  int dy = best.dy;
  double score = best.score;
  for (int level = top - 1; level >= 0; --level) {
    dx *= 2;
    dy *= 2;
    const GrayF& fine = reference_levels[static_cast<size_t>(level)];
    const auto floor_pixels = static_cast<int64_t>(min_overlap * fine.width * fine.height * 0.5);
    const Correlation refined =
        search_ncc(fine, frame_levels[static_cast<size_t>(level)], dx - kRefineRadius,
                   dx + kRefineRadius, dy - kRefineRadius, dy + kRefineRadius, floor_pixels);
    if (refined.score < 0) continue;
    dx = refined.dx;
    dy = refined.dy;
    score = refined.score;
  }
  alignment.dx = dx;
  alignment.dy = dy;
  alignment.score = score;
  return alignment;
}

void warp_frame(const LinearImage& source, const Alignment& alignment, LinearImage& target,
                std::vector<uint8_t>& coverage) {
  coverage.assign(target.pixel_count(), 0);
  const double centre_x = (source.width - 1) * 0.5;
  const double centre_y = (source.height - 1) * 0.5;
  const double cosine = std::cos(-alignment.angle);
  const double sine = std::sin(-alignment.angle);
  for (uint32_t y = 0; y < target.height; ++y) {
    for (uint32_t x = 0; x < target.width; ++x) {
      const double ox = x - alignment.dx - centre_x;
      const double oy = y - alignment.dy - centre_y;
      const double sx = centre_x + ox * cosine - oy * sine;
      const double sy = centre_y + ox * sine + oy * cosine;
      float* pixel = target.at(x, y);
      if (!sample_bilinear(source, sx, sy, pixel)) continue;
      coverage[static_cast<size_t>(y) * target.width + x] = 255;
    }
  }
}

}  // namespace latent

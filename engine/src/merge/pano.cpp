#include "merge/pano.h"

#include "merge/align.h"

#include <cmath>

#include <algorithm>
#include <numeric>
#include <stdexcept>

namespace latent {

namespace {

constexpr size_t kMinFrames = 2;
constexpr size_t kMaxFrames = 12;
// Frames have to share at least this much for the correlation to mean anything, and it is
// also what bounds the search range at the coarsest pyramid level.
constexpr double kMinOverlap = 0.15;
// Below this the pair did not match; chaining a bad pair ruins every frame after it.
constexpr double kMinScore = 0.25;
// The canvas is float RGB plus a float weight: 16 bytes a pixel. Refuse rather than swap.
constexpr size_t kMaxCanvasPixels = 300'000'000;
// Feather width as a fraction of the shorter frame edge.
constexpr double kFeather = 0.15;

void report(const MergeProgress& progress, int done, int total, const std::string& stage) {
  if (progress.cancelled && progress.cancelled()) throw std::runtime_error("cancelled");
  if (progress.tick) progress.tick(done, total, stage);
}

// Maps the flat frame onto a cylinder or a sphere of radius `focal_px`, so that a pure
// pan becomes a pure translation. Output keeps the input's size; the edges compress.
LinearImage project(const LinearImage& source, double focal_px, Projection projection) {
  LinearImage out = make_linear(source.width, source.height);
  const double centre_x = (source.width - 1) * 0.5;
  const double centre_y = (source.height - 1) * 0.5;
  for (uint32_t y = 0; y < out.height; ++y) {
    const double v = (y - centre_y) / focal_px;
    for (uint32_t x = 0; x < out.width; ++x) {
      const double u = (x - centre_x) / focal_px;
      double source_x = 0;
      double source_y = 0;
      if (projection == Projection::Spherical) {
        const double cos_v = std::cos(v);
        const double z = std::cos(u) * cos_v;
        if (z <= 1e-6) continue;
        source_x = centre_x + focal_px * std::sin(u) * cos_v / z;
        source_y = centre_y + focal_px * std::sin(v) / z;
      } else {
        const double z = std::cos(u);
        if (z <= 1e-6) continue;
        source_x = centre_x + focal_px * std::sin(u) / z;
        source_y = centre_y + focal_px * v / z;
      }
      sample_bilinear(source, source_x, source_y, out.at(x, y));
    }
  }
  return out;
}

// Mean luminance of the two frames over the pixels they share, so the second can be
// brought onto the first's exposure before blending.
double overlap_gain(const LinearImage& base, const LinearImage& next, int dx, int dy) {
  double base_sum = 0;
  double next_sum = 0;
  int64_t counted = 0;
  for (uint32_t y = 0; y < next.height; ++y) {
    const auto target_y = static_cast<int64_t>(y) + dy;
    if (target_y < 0 || target_y >= base.height) continue;
    for (uint32_t x = 0; x < next.width; ++x) {
      const auto target_x = static_cast<int64_t>(x) + dx;
      if (target_x < 0 || target_x >= base.width) continue;
      const float* a = base.at(static_cast<uint32_t>(target_x), static_cast<uint32_t>(target_y));
      const float* b = next.at(x, y);
      base_sum += a[0] + a[1] + a[2];
      next_sum += b[0] + b[1] + b[2];
      ++counted;
    }
  }
  if (counted < 1024 || next_sum <= 1e-9) return 1.0;
  return base_sum / next_sum;
}

// Linear ramp in from every edge: a pixel at the border weighs nothing, one a feather
// width in weighs everything. The product of the two axes keeps the corners honest.
std::vector<float> feather_weights(uint32_t width, uint32_t height) {
  const double band = std::max(1.0, kFeather * std::min(width, height));
  std::vector<float> rows(height);
  std::vector<float> columns(width);
  for (uint32_t y = 0; y < height; ++y) {
    const double distance = std::min<double>(y, height - 1 - y);
    rows[y] = static_cast<float>(std::clamp(distance / band, 0.02, 1.0));
  }
  for (uint32_t x = 0; x < width; ++x) {
    const double distance = std::min<double>(x, width - 1 - x);
    columns[x] = static_cast<float>(std::clamp(distance / band, 0.02, 1.0));
  }
  std::vector<float> weights(static_cast<size_t>(width) * height);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      weights[static_cast<size_t>(y) * width + x] = rows[y] * columns[x];
    }
  }
  return weights;
}

struct Rect {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

// Largest all-valid axis-aligned rectangle, by the usual histogram-and-stack sweep.
Rect largest_valid_rect(const std::vector<uint8_t>& valid, uint32_t width, uint32_t height) {
  std::vector<uint32_t> heights(width, 0);
  Rect best;
  size_t best_area = 0;
  std::vector<uint32_t> stack;
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      heights[x] = valid[static_cast<size_t>(y) * width + x] != 0 ? heights[x] + 1 : 0;
    }
    stack.clear();
    for (uint32_t x = 0; x <= width; ++x) {
      const uint32_t current = x == width ? 0 : heights[x];
      while (!stack.empty() && heights[stack.back()] >= current) {
        const uint32_t top = stack.back();
        stack.pop_back();
        const uint32_t left = stack.empty() ? 0 : stack.back() + 1;
        const uint32_t span = x - left;
        const size_t area = static_cast<size_t>(span) * heights[top];
        if (area <= best_area || span == 0 || heights[top] == 0) continue;
        best_area = area;
        best = {left, y + 1 - heights[top], span, heights[top]};
      }
      stack.push_back(x);
    }
  }
  return best;
}

// Boundary Warp: stretch the valid content out to the bounding rectangle instead of
// cropping it away. Per column vertically, then per row horizontally, blended toward
// identity by `amount`. An approximation of Lightroom's mesh warp, not a port of it: it
// straightens the ragged edge without a solver, and bends straight lines near the border.
void boundary_warp(LinearImage& image, std::vector<uint8_t>& valid, double amount) {
  const uint32_t width = image.width;
  const uint32_t height = image.height;
  std::vector<uint32_t> top(width, 0);
  std::vector<uint32_t> bottom(width, 0);
  for (uint32_t x = 0; x < width; ++x) {
    uint32_t first = height;
    uint32_t last = 0;
    for (uint32_t y = 0; y < height; ++y) {
      if (valid[static_cast<size_t>(y) * width + x] == 0) continue;
      first = std::min(first, y);
      last = y;
    }
    top[x] = first == height ? 0 : first;
    bottom[x] = first == height ? height - 1 : last;
  }

  LinearImage warped = make_linear(width, height);
  std::vector<uint8_t> warped_valid(valid.size(), 0);
  for (uint32_t x = 0; x < width; ++x) {
    const double span = std::max(1.0, static_cast<double>(bottom[x]) - top[x]);
    for (uint32_t y = 0; y < height; ++y) {
      const double stretched = top[x] + y * span / std::max(1U, height - 1);
      const double source_y = y + amount * (stretched - y);
      if (!sample_bilinear(image, x, source_y, warped.at(x, y))) continue;
      const auto sample_row = static_cast<uint32_t>(std::lround(source_y));
      if (sample_row >= height) continue;
      warped_valid[static_cast<size_t>(y) * width + x] =
          valid[static_cast<size_t>(sample_row) * width + x];
    }
  }
  image = std::move(warped);
  valid = std::move(warped_valid);
}

}  // namespace

Projection projection_from_name(const std::string& name) {
  if (name == "spherical") return Projection::Spherical;
  if (name == "perspective") return Projection::Perspective;
  return Projection::Cylindrical;
}

const char* projection_name(Projection projection) {
  switch (projection) {
    case Projection::Spherical:
      return "spherical";
    case Projection::Perspective:
      return "perspective";
    case Projection::Cylindrical:
      break;
  }
  return "cylindrical";
}

PanoOutcome merge_panorama(std::vector<PanoFrame> frames, const PanoOptions& options,
                           const MergeProgress& progress) {
  if (frames.size() < kMinFrames || frames.size() > kMaxFrames) {
    throw std::runtime_error("merge to panorama takes 2 to 12 frames, got " +
                             std::to_string(frames.size()));
  }
  const uint32_t frame_width = frames.front().image.width;
  const uint32_t frame_height = frames.front().image.height;
  for (const PanoFrame& frame : frames) {
    if (frame.image.width != frame_width || frame.image.height != frame_height) {
      throw std::runtime_error("every panorama frame must have the same size");
    }
  }

  PanoOutcome outcome;
  outcome.projection = options.projection;
  const bool has_focal = std::all_of(frames.begin(), frames.end(),
                                     [](const PanoFrame& frame) { return frame.focal_px > 0; });
  if (!has_focal) outcome.projection = Projection::Perspective;

  const int total_steps = static_cast<int>(frames.size()) * 2 + 1;
  int step = 0;
  if (outcome.projection != Projection::Perspective) {
    for (PanoFrame& frame : frames) {
      report(progress, step++, total_steps, "projecting");
      frame.image = project(frame.image, frame.focal_px, outcome.projection);
    }
  } else {
    step = static_cast<int>(frames.size());
  }

  // Chain the pairwise shifts from the first frame. Each pair is aligned on its own; there
  // is no bundle adjustment, so drift accumulates along the strip.
  std::vector<int64_t> origin_x(frames.size(), 0);
  std::vector<int64_t> origin_y(frames.size(), 0);
  std::vector<double> gains(frames.size(), 1.0);
  outcome.match_score.assign(frames.size(), 1.0);
  for (size_t i = 1; i < frames.size(); ++i) {
    report(progress, step++, total_steps, "matching");
    const Alignment pair =
        align_overlap(luminance(frames[i - 1].image), luminance(frames[i].image), kMinOverlap);
    if (pair.score < kMinScore) {
      throw std::runtime_error("frames " + std::to_string(i) + " and " + std::to_string(i + 1) +
                               " do not overlap enough to match (score " +
                               std::to_string(pair.score) + ")");
    }
    origin_x[i] = origin_x[i - 1] + static_cast<int64_t>(pair.dx);
    origin_y[i] = origin_y[i - 1] + static_cast<int64_t>(pair.dy);
    outcome.match_score[i] = pair.score;
    gains[i] = gains[i - 1] * overlap_gain(frames[i - 1].image, frames[i].image,
                                           static_cast<int>(pair.dx), static_cast<int>(pair.dy));
  }
  outcome.offset_x.assign(origin_x.begin(), origin_x.end());
  outcome.offset_y.assign(origin_y.begin(), origin_y.end());

  const int64_t min_x = *std::min_element(origin_x.begin(), origin_x.end());
  const int64_t min_y = *std::min_element(origin_y.begin(), origin_y.end());
  const int64_t max_x = *std::max_element(origin_x.begin(), origin_x.end()) + frame_width;
  const int64_t max_y = *std::max_element(origin_y.begin(), origin_y.end()) + frame_height;
  const auto canvas_width = static_cast<uint32_t>(max_x - min_x);
  const auto canvas_height = static_cast<uint32_t>(max_y - min_y);
  if (static_cast<size_t>(canvas_width) * canvas_height > kMaxCanvasPixels) {
    throw std::runtime_error("panorama canvas would be " + std::to_string(canvas_width) + "x" +
                             std::to_string(canvas_height) + ", too large to compose in memory");
  }

  LinearImage canvas = make_linear(canvas_width, canvas_height);
  std::vector<float> weight_sum(canvas.pixel_count(), 0.0F);
  const std::vector<float> feather = feather_weights(frame_width, frame_height);
  for (size_t i = 0; i < frames.size(); ++i) {
    report(progress, step++, total_steps, "blending");
    const auto offset_x = static_cast<uint32_t>(origin_x[i] - min_x);
    const auto offset_y = static_cast<uint32_t>(origin_y[i] - min_y);
    const auto gain = static_cast<float>(gains[i]);
    for (uint32_t y = 0; y < frame_height; ++y) {
      for (uint32_t x = 0; x < frame_width; ++x) {
        const float weight = feather[static_cast<size_t>(y) * frame_width + x];
        const size_t index = static_cast<size_t>(y + offset_y) * canvas_width + (x + offset_x);
        const float* pixel = frames[i].image.at(x, y);
        float* target = canvas.rgb.data() + index * 3;
        for (int channel = 0; channel < 3; ++channel) {
          target[channel] += weight * pixel[channel] * gain;
        }
        weight_sum[index] += weight;
      }
    }
  }

  std::vector<uint8_t> valid(canvas.pixel_count(), 0);
  for (size_t i = 0; i < weight_sum.size(); ++i) {
    if (weight_sum[i] <= 0) continue;
    valid[i] = 255;
    const float inverse = 1.0F / weight_sum[i];
    canvas.rgb[i * 3 + 0] *= inverse;
    canvas.rgb[i * 3 + 1] *= inverse;
    canvas.rgb[i * 3 + 2] *= inverse;
  }
  outcome.coverage =
      static_cast<double>(std::count(valid.begin(), valid.end(), 255)) / valid.size();

  if (options.boundary_warp > 0) {
    boundary_warp(canvas, valid, std::clamp(options.boundary_warp, 0, 100) / 100.0);
  }
  if (options.auto_crop) {
    const Rect crop = largest_valid_rect(valid, canvas_width, canvas_height);
    if (crop.width > 0 && crop.height > 0) {
      LinearImage cropped = make_linear(crop.width, crop.height);
      for (uint32_t y = 0; y < crop.height; ++y) {
        const float* source = canvas.at(crop.x, crop.y + y);
        std::copy_n(source, static_cast<size_t>(crop.width) * 3, cropped.at(0, y));
      }
      canvas = std::move(cropped);
    }
  }

  // Blending can push a pixel above the source white level where two bright frames meet;
  // the carrier is [0,1], so bring the peak back down and keep the ratio.
  const float peak = *std::max_element(canvas.rgb.begin(), canvas.rgb.end());
  if (peak > 1.0F) {
    for (float& value : canvas.rgb)
      value /= peak;
  }
  outcome.image = std::move(canvas);
  report(progress, total_steps, total_steps, "stitched");
  return outcome;
}

}  // namespace latent

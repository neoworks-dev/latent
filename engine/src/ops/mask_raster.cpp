#include "ops/mask_raster.h"

#include <cmath>

#include <algorithm>

namespace latent {

namespace {

// Stamps closer together than a quarter of the radius only cost time; further apart and a
// fast drag leaves a dotted line.
constexpr double kStampSpacing = 0.25;
constexpr double kMinimumRadiusPx = 0.75;

struct Bounds {
  int32_t x0 = 0;
  int32_t y0 = 0;
  int32_t x1 = -1;
  int32_t y1 = -1;

  bool empty() const { return x1 < x0 || y1 < y0; }
  void add(int32_t left, int32_t top, int32_t right, int32_t bottom) {
    if (empty()) {
      x0 = left;
      y0 = top;
      x1 = right;
      y1 = bottom;
      return;
    }
    x0 = std::min(x0, left);
    y0 = std::min(y0, top);
    x1 = std::max(x1, right);
    y1 = std::max(y1, bottom);
  }
};

// One disc, max-blended into the stroke's own buffer: overlapping stamps inside a single
// stroke hold the stroke's opacity instead of stacking up to opaque.
void stamp(std::vector<float>& buffer, uint32_t width, uint32_t height, double centre_x,
           double centre_y, double radius, double inner, double alpha, Bounds& touched) {
  const auto left = static_cast<int32_t>(std::floor(centre_x - radius));
  const auto top = static_cast<int32_t>(std::floor(centre_y - radius));
  const auto right = static_cast<int32_t>(std::ceil(centre_x + radius));
  const auto bottom = static_cast<int32_t>(std::ceil(centre_y + radius));
  const int32_t x0 = std::max<int32_t>(left, 0);
  const int32_t y0 = std::max<int32_t>(top, 0);
  const int32_t x1 = std::min<int32_t>(right, static_cast<int32_t>(width) - 1);
  const int32_t y1 = std::min<int32_t>(bottom, static_cast<int32_t>(height) - 1);
  if (x1 < x0 || y1 < y0) return;
  touched.add(x0, y0, x1, y1);

  for (int32_t y = y0; y <= y1; ++y) {
    const double dy = (y + 0.5) - centre_y;
    for (int32_t x = x0; x <= x1; ++x) {
      const double dx = (x + 0.5) - centre_x;
      const double distance = std::sqrt((dx * dx) + (dy * dy));
      if (distance >= radius) continue;
      // Smoothstep from the feathered inner edge to the rim.
      double falloff = 1.0;
      if (distance > inner) {
        const double t = std::clamp((radius - distance) / std::max(radius - inner, 1e-6), 0.0, 1.0);
        falloff = t * t * (3.0 - (2.0 * t));
      }
      const auto index = (static_cast<size_t>(y) * width) + static_cast<size_t>(x);
      buffer[index] = std::max(buffer[index], static_cast<float>(alpha * falloff));
    }
  }
}

}  // namespace

GrayImage rasterize_brush(const std::vector<BrushStroke>& strokes, double feather, uint32_t width,
                          uint32_t height) {
  GrayImage out;
  out.width = width;
  out.height = height;
  out.pixels.assign(static_cast<size_t>(width) * height, 0);
  if (width == 0 || height == 0 || strokes.empty()) return out;

  const double long_edge = std::max(width, height);
  const double softness = std::clamp(feather, 0.0, 100.0) / 100.0;
  std::vector<float> accumulated(out.pixels.size(), 0.0F);
  std::vector<float> stroke_buffer(out.pixels.size(), 0.0F);

  for (const BrushStroke& stroke : strokes) {
    const double radius = std::max(stroke.size * 0.5 * long_edge, kMinimumRadiusPx);
    const double inner = radius * (1.0 - softness);
    const double spacing = std::max(radius * kStampSpacing, 1.0);
    Bounds touched;

    for (size_t i = 0; i < stroke.points.size(); ++i) {
      const StrokePoint& point = stroke.points[i];
      const double alpha =
          std::clamp(stroke.flow / 100.0, 0.0, 1.0) * std::clamp(point.pressure, 0.0, 1.0);
      const double x = point.x * width;
      const double y = point.y * height;
      stamp(stroke_buffer, width, height, x, y, radius, inner, alpha, touched);
      if (i == 0) continue;
      // Fill the gap to the previous point so a fast drag is a line, not two dots.
      const StrokePoint& previous = stroke.points[i - 1];
      const double previous_x = previous.x * width;
      const double previous_y = previous.y * height;
      const double span = std::hypot(x - previous_x, y - previous_y);
      const auto steps = static_cast<int>(span / spacing);
      for (int step = 1; step < steps; ++step) {
        const double t = static_cast<double>(step) / steps;
        const double blended_alpha =
            std::clamp(stroke.flow / 100.0, 0.0, 1.0) *
            std::clamp(previous.pressure + ((point.pressure - previous.pressure) * t), 0.0, 1.0);
        stamp(stroke_buffer, width, height, previous_x + ((x - previous_x) * t),
              previous_y + ((y - previous_y) * t), radius, inner, blended_alpha, touched);
      }
    }
    if (touched.empty()) continue;

    // Paint screens onto what is there (so a second pass builds up at low flow); erase
    // takes the same share away.
    for (int32_t y = touched.y0; y <= touched.y1; ++y) {
      for (int32_t x = touched.x0; x <= touched.x1; ++x) {
        const auto index = (static_cast<size_t>(y) * width) + static_cast<size_t>(x);
        const float value = stroke_buffer[index];
        stroke_buffer[index] = 0.0F;
        if (value <= 0.0F) continue;
        accumulated[index] = stroke.erase
                                 ? accumulated[index] * (1.0F - value)
                                 : accumulated[index] + (value * (1.0F - accumulated[index]));
      }
    }
  }

  for (size_t i = 0; i < out.pixels.size(); ++i) {
    out.pixels[i] = static_cast<uint8_t>(std::lround(std::clamp(accumulated[i], 0.0F, 1.0F) * 255));
  }
  return out;
}

}  // namespace latent

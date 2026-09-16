#include "ops/curve.h"

#include <cmath>

#include <algorithm>

namespace latent {

namespace {

double clamp01(double value) {
  return std::clamp(value, 0.0, 1.0);
}

double smoothstep(double edge0, double edge1, double x) {
  if (edge1 <= edge0) return x < edge0 ? 0.0 : 1.0;
  const double t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

// A curve that ever descends would invert tones; the sliders can add up to that, so the
// table is walked once and every entry pinned to at least its predecessor.
void monotonize(CurveLut& lut) {
  for (size_t i = 1; i < lut.size(); ++i) {
    lut[i] = std::max(lut[i], lut[i - 1]);
  }
}

}  // namespace

std::vector<CurvePoint> curve_points_from_json(const nlohmann::json& value) {
  std::vector<CurvePoint> points;
  if (!value.is_array()) return points;
  for (const nlohmann::json& entry : value) {
    if (!entry.is_object()) continue;
    const auto x = entry.find("x");
    const auto y = entry.find("y");
    if (x == entry.end() || y == entry.end() || !x->is_number() || !y->is_number()) continue;
    points.push_back(CurvePoint{clamp01(x->get<double>()), clamp01(y->get<double>())});
  }
  std::stable_sort(points.begin(), points.end(),
                   [](const CurvePoint& a, const CurvePoint& b) { return a.x < b.x; });
  points.erase(std::unique(points.begin(), points.end(),
                           [](const CurvePoint& a, const CurvePoint& b) { return a.x == b.x; }),
               points.end());
  return points;
}

nlohmann::json curve_points_to_json(const std::vector<CurvePoint>& points) {
  nlohmann::json value = nlohmann::json::array();
  for (const CurvePoint& point : points) {
    value.push_back({{"x", point.x}, {"y", point.y}});
  }
  return value;
}

CurveLut identity_lut() {
  CurveLut lut{};
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    lut[i] = static_cast<float>(i) / static_cast<float>(kCurveLutSize - 1);
  }
  return lut;
}

CurveLut point_curve_lut(const std::vector<CurvePoint>& points) {
  if (points.size() < 2) return identity_lut();

  const size_t count = points.size();
  std::vector<double> slope(count - 1, 0.0);
  std::vector<double> tangent(count, 0.0);
  for (size_t i = 0; i + 1 < count; ++i) {
    const double dx = points[i + 1].x - points[i].x;
    slope[i] = dx > 0 ? (points[i + 1].y - points[i].y) / dx : 0.0;
  }
  tangent[0] = slope.front();
  tangent[count - 1] = slope.back();
  for (size_t i = 1; i + 1 < count; ++i) {
    // Fritsch-Carlson: a flat or reversing neighbour pins the tangent to zero, which is
    // what stops the spline from bulging past the control points.
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0.0;
      continue;
    }
    tangent[i] = (slope[i - 1] + slope[i]) / 2.0;
    const double limit = 3.0 * std::min(std::abs(slope[i - 1]), std::abs(slope[i]));
    tangent[i] = std::clamp(tangent[i], -limit, limit);
  }

  CurveLut lut{};
  size_t segment = 0;
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    const double x = static_cast<double>(i) / static_cast<double>(kCurveLutSize - 1);
    if (x <= points.front().x) {
      lut[i] = static_cast<float>(points.front().y);
      continue;
    }
    if (x >= points.back().x) {
      lut[i] = static_cast<float>(points.back().y);
      continue;
    }
    while (segment + 2 < count && x > points[segment + 1].x) {
      ++segment;
    }
    const double dx = points[segment + 1].x - points[segment].x;
    const double t = dx > 0 ? (x - points[segment].x) / dx : 0.0;
    const double t2 = t * t;
    const double t3 = t2 * t;
    const double h00 = 2 * t3 - 3 * t2 + 1;
    const double h10 = t3 - 2 * t2 + t;
    const double h01 = -2 * t3 + 3 * t2;
    const double h11 = t3 - t2;
    const double y = h00 * points[segment].y + h10 * dx * tangent[segment] +
                     h01 * points[segment + 1].y + h11 * dx * tangent[segment + 1];
    lut[i] = static_cast<float>(clamp01(y));
  }
  monotonize(lut);
  return lut;
}

CurveLut parametric_curve_lut(const ParametricCurve& regions) {
  const double shadow_split = clamp01(regions.shadow_split / 100.0);
  const double midtone_split = std::max(clamp01(regions.midtone_split / 100.0), shadow_split);
  const double highlight_split = std::max(clamp01(regions.highlight_split / 100.0), midtone_split);

  // A region slider at +-100 moves its part of the curve by a quarter of the range, which
  // is roughly what Lightroom's does before its own clamping.
  constexpr double kRegionLift = 0.25;
  CurveLut lut{};
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    const double x = static_cast<double>(i) / static_cast<double>(kCurveLutSize - 1);
    const double shadows = 1.0 - smoothstep(0.0, midtone_split, x);
    const double darks =
        smoothstep(0.0, shadow_split, x) * (1.0 - smoothstep(shadow_split, highlight_split, x));
    const double lights =
        smoothstep(shadow_split, highlight_split, x) * (1.0 - smoothstep(highlight_split, 1.0, x));
    const double highlights = smoothstep(midtone_split, 1.0, x);
    const double lift = kRegionLift *
                        (regions.shadows * shadows + regions.darks * darks +
                         regions.lights * lights + regions.highlights * highlights) /
                        100.0;
    lut[i] = static_cast<float>(clamp01(x + lift));
  }
  monotonize(lut);
  return lut;
}

CurveLut compose_lut(const CurveLut& first, const CurveLut& second) {
  CurveLut lut{};
  const double last = static_cast<double>(kCurveLutSize - 1);
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    const double position = clamp01(first[i]) * last;
    const auto low = static_cast<size_t>(position);
    const size_t high = std::min(low + 1, kCurveLutSize - 1);
    const double fraction = position - static_cast<double>(low);
    lut[i] = static_cast<float>(second[low] * (1.0 - fraction) + second[high] * fraction);
  }
  return lut;
}

bool is_identity_lut(const CurveLut& lut) {
  const CurveLut identity = identity_lut();
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    if (lut[i] != identity[i]) return false;
  }
  return true;
}

}  // namespace latent

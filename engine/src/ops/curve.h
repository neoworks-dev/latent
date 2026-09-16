// Tone curves, as data: control points and the 256-entry lookup tables the renderer
// uploads. Pure CPU maths so it is testable without a GPU (engine/tests/curve_test.cpp).
//
// Both axes are the display-referred 0..1 domain the curve editor draws, not the linear
// working space; engine/shaders/ops.wgsl encodes and decodes around the lookup.
#pragma once

#include <cstddef>

#include <array>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

struct CurvePoint {
  double x = 0;
  double y = 0;
};

inline constexpr size_t kCurveLutSize = 256;
using CurveLut = std::array<float, kCurveLutSize>;

// Control points from an op param: objects with numeric x/y, clamped to 0..1, sorted by
// x, points sharing an x dropped. Anything else in the array is ignored.
std::vector<CurvePoint> curve_points_from_json(const nlohmann::json& value);
nlohmann::json curve_points_to_json(const std::vector<CurvePoint>& points);

CurveLut identity_lut();

// Fritsch-Carlson monotone cubic through `points`: no overshoot between control points,
// which is what keeps a curve from inverting. Fewer than two points = identity.
CurveLut point_curve_lut(const std::vector<CurvePoint>& points);

// Lightroom's parametric curve: four region amounts in -100..100 and the three split
// points in 0..100 that set where the regions meet.
struct ParametricCurve {
  double highlights = 0;
  double lights = 0;
  double darks = 0;
  double shadows = 0;
  double shadow_split = 25;
  double midtone_split = 50;
  double highlight_split = 75;
};

CurveLut parametric_curve_lut(const ParametricCurve& regions);

// `second` applied to the output of `first`, with linear interpolation between entries.
CurveLut compose_lut(const CurveLut& first, const CurveLut& second);

// True when the table maps every entry to itself, i.e. the pass can be skipped.
bool is_identity_lut(const CurveLut& lut);

}  // namespace latent

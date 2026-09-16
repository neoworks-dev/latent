#include "ops/curve.h"

#include "ops/registry.h"

#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

TEST_CASE("an empty or two-point diagonal curve is the identity") {
  REQUIRE(is_identity_lut(point_curve_lut({})));
  REQUIRE(is_identity_lut(parametric_curve_lut(ParametricCurve{})));

  const std::vector<CurvePoint> diagonal = {{0.0, 0.0}, {1.0, 1.0}};
  const CurveLut lut = point_curve_lut(diagonal);
  REQUIRE(lut.front() == 0.0F);
  REQUIRE(lut.back() == 1.0F);
  // A straight line through 256 samples is the identity to within one step.
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    REQUIRE(std::abs(lut[i] - (static_cast<float>(i) / 255.0F)) < 0.002F);
  }
}

TEST_CASE("a point curve is monotone and passes through its control points") {
  const std::vector<CurvePoint> s_curve = {{0.0, 0.0}, {0.25, 0.15}, {0.75, 0.85}, {1.0, 1.0}};
  const CurveLut lut = point_curve_lut(s_curve);
  for (size_t i = 1; i < kCurveLutSize; ++i) {
    REQUIRE(lut[i] >= lut[i - 1]);
  }
  REQUIRE(std::abs(lut[64] - 0.15F) < 0.01F);
  REQUIRE(std::abs(lut[191] - 0.85F) < 0.01F);
  REQUIRE(!is_identity_lut(lut));
}

TEST_CASE("a spike between control points does not overshoot") {
  const std::vector<CurvePoint> steep = {{0.0, 0.0}, {0.5, 0.95}, {0.6, 0.96}, {1.0, 1.0}};
  const CurveLut lut = point_curve_lut(steep);
  for (const float value : lut) {
    REQUIRE(value >= 0.0F);
    REQUIRE(value <= 1.0F);
  }
  REQUIRE(lut[140] <= lut[160]);
}

TEST_CASE("each parametric region moves its own end of the range") {
  ParametricCurve regions;
  regions.shadows = 100;
  const CurveLut lifted = parametric_curve_lut(regions);
  REQUIRE(lifted[16] > 16.0F / 255.0F);
  REQUIRE(std::abs(lifted[240] - (240.0F / 255.0F)) < 0.02F);

  ParametricCurve highlights;
  highlights.highlights = -100;
  const CurveLut pulled = parametric_curve_lut(highlights);
  REQUIRE(pulled[240] < 240.0F / 255.0F);
  REQUIRE(std::abs(pulled[16] - (16.0F / 255.0F)) < 0.02F);
}

TEST_CASE("composing with the identity changes nothing") {
  const std::vector<CurvePoint> points = {{0.0, 0.1}, {1.0, 0.9}};
  const CurveLut curve = point_curve_lut(points);
  const CurveLut composed = compose_lut(curve, identity_lut());
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    REQUIRE(std::abs(composed[i] - curve[i]) < 0.005F);
  }
}

TEST_CASE("control points are normalised through the registry") {
  std::vector<std::string> warnings;
  const nlohmann::json params = normalize_params_for(
      "tone_curve",
      {{"rgb",
        nlohmann::json::array(
            {{{"x", 0.8}, {"y", 1.4}}, {{"x", 0.2}, {"y", 0.1}}, nlohmann::json::array({1, 2})})}},
      warnings);
  const std::vector<CurvePoint> points = curve_points_from_json(params["rgb"]);
  REQUIRE(points.size() == 2);
  REQUIRE(points[0].x == 0.2);
  REQUIRE(points[1].y == 1.0);
  REQUIRE(warnings.size() == 1);
  REQUIRE(params["highlights"] == 0.0);
  REQUIRE(params["shadowSplit"] == 25.0);
}

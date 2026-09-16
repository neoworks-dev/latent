// Image space: the geometry matrix, the migration off the old content-space coordinates,
// and the viewport. No GPU — this is the arithmetic every mask pass and every overlay
// coordinate goes through (engine/src/ops/geometry.cpp), and it is worth pinning on its
// own, because a wrong sign here is a mask that drifts off the subject rather than a
// compile error.
#include "ops/geometry.h"
#include "ops/mask.h"
#include "ops/op.h"

#include <cmath>
#include <cstdint>

#include <array>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

// A 3:2 frame, the sample raw's shape, so a crop that changes the aspect is visible.
constexpr uint32_t kPhotoWidth = 6000;
constexpr uint32_t kPhotoHeight = 4000;
constexpr uint32_t kViewWidth = 900;
constexpr uint32_t kViewHeight = 600;

Op geometry_op(const std::string& name, const nlohmann::json& params) {
  Op op;
  op.id = name + "00001";
  op.name = name;
  op.params = params;
  return op;
}

GeometryMap map_for(const Stack& stack, const Viewport& viewport = Viewport{}) {
  return geometry_map(geometry_from_stack(stack), kPhotoWidth, kPhotoHeight, kViewWidth,
                      kViewHeight, viewport);
}

// The image point a view pixel sits on, and back again.
std::array<double, 2> to_image(const GeometryMap& map, double x, double y) {
  return mat3_apply(map.view_to_image, x, y);
}

std::array<double, 2> to_view(const GeometryMap& map, double x, double y) {
  return mat3_apply(map.image_to_view, x, y);
}

Op masked_exposure(const nlohmann::json& mask) {
  Op op;
  op.id = "exp00001";
  op.name = "exposure";
  op.params = {{"value", 1.0}};
  op.mask = mask;
  return op;
}

}  // namespace

TEST_CASE("the matrix and its inverse agree, with and without geometry") {
  const Stack plain;
  const Stack cropped = {geometry_op(
      "crop", {{"left", 0.25}, {"top", 0.1}, {"right", 0.75}, {"bottom", 0.6}, {"angle", 7.0}})};
  const Stack turned = {geometry_op("rotate", {{"value", 90.0}}),
                        geometry_op("flip", {{"horizontal", true}})};
  const Stack skewed = {geometry_op(
      "transform", {{"rotate", 4.0}, {"vertical", 15.0}, {"horizontal", -8.0}, {"scale", 110.0}})};

  for (const Stack& stack : {plain, cropped, turned, skewed}) {
    const GeometryMap map = map_for(stack);
    for (const double x : {40.0, 450.0, 860.0}) {
      for (const double y : {30.0, 300.0, 570.0}) {
        const std::array<double, 2> image = to_image(map, x, y);
        const std::array<double, 2> back = to_view(map, image[0], image[1]);
        CHECK_THAT(back[0], Catch::Matchers::WithinAbs(x, 1e-6));
        CHECK_THAT(back[1], Catch::Matchers::WithinAbs(y, 1e-6));
      }
    }
  }
}

TEST_CASE("an image point keeps its pixel when geometry moves") {
  // The centre of the uncropped photo is the centre of the view. Every stage below either
  // leaves it there or moves it somewhere the matrix can still name.
  const GeometryMap plain = map_for({});
  const std::array<double, 2> centre = to_view(plain, 0.5, 0.5);
  CHECK_THAT(centre[0], Catch::Matchers::WithinAbs(kViewWidth / 2.0, 0.5));
  CHECK_THAT(centre[1], Catch::Matchers::WithinAbs(kViewHeight / 2.0, 0.5));

  // A crop of the left half: image x 0.25 is now the middle of what is shown.
  const GeometryMap cropped = map_for({geometry_op("crop", {{"right", 0.5}})});
  const std::array<double, 2> quarter = to_view(cropped, 0.25, 0.5);
  CHECK_THAT(quarter[0], Catch::Matchers::WithinAbs(kViewWidth / 2.0, 1.0));
  // And the point that used to be in the middle has moved to the right edge of the image.
  const std::array<double, 2> half = to_view(cropped, 0.5, 0.5);
  REQUIRE(half[0] > quarter[0] + 100);

  // 90 degrees clockwise: the image's x axis runs down the view, not across it.
  const GeometryMap rotated = map_for({geometry_op("rotate", {{"value", 90.0}})});
  const std::array<double, 2> left = to_view(rotated, 0.1, 0.5);
  const std::array<double, 2> right = to_view(rotated, 0.9, 0.5);
  CHECK_THAT(left[0], Catch::Matchers::WithinAbs(right[0], 1.0));
  REQUIRE(left[1] < right[1]);

  // A horizontal flip mirrors it about the middle and nothing else.
  const GeometryMap flipped = map_for({geometry_op("flip", {{"horizontal", true}})});
  const std::array<double, 2> mirrored = to_view(flipped, 0.2, 0.5);
  const std::array<double, 2> plain_point = to_view(plain, 0.8, 0.5);
  CHECK_THAT(mirrored[0], Catch::Matchers::WithinAbs(plain_point[0], 1.0));
  CHECK_THAT(mirrored[1], Catch::Matchers::WithinAbs(plain_point[1], 1.0));
}

TEST_CASE("the viewport zooms about a point and clamps its pan") {
  const GeometryMap fitted = map_for({});
  Viewport viewport;
  viewport.scale = 2;
  viewport.center_x = 0.5;
  viewport.center_y = 0.5;
  viewport.fit = false;
  const GeometryMap zoomed = map_for({}, viewport);

  // Twice the pixels, and the point the view is centred on is still in the middle.
  CHECK(zoomed.content.width == fitted.content.width * 2);
  const std::array<double, 2> centre = to_view(zoomed, 0.5, 0.5);
  CHECK_THAT(centre[0], Catch::Matchers::WithinAbs(kViewWidth / 2.0, 1.0));
  CHECK_THAT(centre[1], Catch::Matchers::WithinAbs(kViewHeight / 2.0, 1.0));

  // Centred elsewhere: that point lands in the middle instead.
  viewport.center_x = 0.3;
  viewport.center_y = 0.4;
  const GeometryMap panned = map_for({}, viewport);
  const std::array<double, 2> at = to_view(panned, 0.3, 0.4);
  CHECK_THAT(at[0], Catch::Matchers::WithinAbs(kViewWidth / 2.0, 1.0));

  // Panned past the corner: the clamp keeps the frame full of photo, so the content rect
  // never leaves a bar on the side it was dragged towards.
  viewport.center_x = 0.0;
  viewport.center_y = 0.0;
  const GeometryMap cornered = map_for({}, viewport);
  CHECK(cornered.content.x <= 0);
  CHECK(cornered.content.y <= 0);
  CHECK(cornered.content.x + static_cast<int32_t>(cornered.content.width) >=
        static_cast<int32_t>(kViewWidth));

  // Fit ignores the centre: it is the behaviour of every render before the field existed.
  CHECK(map_for({}, Viewport{}).content.x == fitted.content.x);
}

TEST_CASE("the mask cache key follows the geometry, not only the mask") {
  const nlohmann::json mask =
      normalize_mask({{"components", nlohmann::json::array({{{"id", "m1"}, {"kind", "radial"}}})}});

  // The same mask over a straighten that leaves the content rect's size alone: the pixels
  // it covers have moved, so the key has to move with them.
  const nlohmann::json plain = geometry_to_json(geometry_from_stack({}));
  const nlohmann::json straightened =
      geometry_to_json(geometry_from_stack({geometry_op("crop", {{"angle", 5.0}})}));
  REQUIRE(plain != straightened);

  const std::string flat = mask_hash({{"m", mask}, {"g", plain}}, kViewWidth, kViewHeight);
  const std::string turned = mask_hash({{"m", mask}, {"g", straightened}}, kViewWidth, kViewHeight);
  CHECK(flat != turned);
  CHECK(flat == mask_hash({{"m", mask}, {"g", plain}}, kViewWidth, kViewHeight));
}

TEST_CASE("a legacy content-space mask is converted on load") {
  // A gradient drawn down the middle of a view that was showing the left half of the
  // photo. In content space that is x 0.5; in image space it is x 0.25.
  nlohmann::json mask = {
      {"space", "content"},
      {"components",
       nlohmann::json::array({{{"id", "m1"},
                               {"kind", "linear"},
                               {"mode", "add"},
                               {"params", {{"start", {0.5, 0.0}}, {"end", {0.5, 1.0}}}}},
                              {{"id", "m2"},
                               {"kind", "radial"},
                               {"mode", "add"},
                               {"params", {{"center", {0.5, 0.5}}, {"radius", {0.2, 0.2}}}}}})}};

  // The top left quarter: content 0.5 is image 0.25 on both axes, and a shape drawn over
  // half the view covers a quarter of the photo.
  Stack stack = {geometry_op("crop", {{"right", 0.5}, {"bottom", 0.5}}), masked_exposure(mask)};
  migrate_mask_space(stack, kPhotoWidth, kPhotoHeight);

  const nlohmann::json& migrated = *stack[1].mask;
  REQUIRE(migrated["space"] == "image");
  const nlohmann::json& linear = migrated["components"][0]["params"];
  CHECK_THAT(linear["start"][0].get<double>(), Catch::Matchers::WithinAbs(0.25, 1e-6));
  CHECK_THAT(linear["start"][1].get<double>(), Catch::Matchers::WithinAbs(0.0, 1e-6));

  const nlohmann::json& radial = migrated["components"][1]["params"];
  CHECK_THAT(radial["center"][0].get<double>(), Catch::Matchers::WithinAbs(0.25, 1e-6));
  CHECK_THAT(radial["center"][1].get<double>(), Catch::Matchers::WithinAbs(0.25, 1e-6));
  CHECK_THAT(radial["radius"][0].get<double>(), Catch::Matchers::WithinAbs(0.1, 1e-3));
  CHECK_THAT(radial["radius"][1].get<double>(), Catch::Matchers::WithinAbs(0.1, 1e-3));

  // Idempotent: a second load must not crop the coordinates twice.
  migrate_mask_space(stack, kPhotoWidth, kPhotoHeight);
  CHECK_THAT((*stack[1].mask)["components"][0]["params"]["start"][0].get<double>(),
             Catch::Matchers::WithinAbs(0.25, 1e-6));
}

TEST_CASE("a mask without a declared space is already image space") {
  // Every client this engine ships with names the space. One that does not is one that
  // never applied geometry either, and there the two conventions coincide.
  const nlohmann::json component = {
      {"id", "m1"}, {"kind", "linear"}, {"params", {{"start", {0.5, 0.0}}, {"end", {0.5, 1.0}}}}};
  const nlohmann::json undeclared = {{"components", nlohmann::json::array({component})}};
  Stack stack = {geometry_op("crop", {{"right", 0.5}}), masked_exposure(undeclared)};
  migrate_mask_space(stack, kPhotoWidth, kPhotoHeight);
  CHECK_THAT((*stack[1].mask)["components"][0]["params"]["start"][0].get<double>(),
             Catch::Matchers::WithinAbs(0.5, 1e-9));

  // And the canonical form says so, so the next sidecar write is unambiguous.
  CHECK(normalize_mask(*stack[1].mask)["space"] == "image");
}

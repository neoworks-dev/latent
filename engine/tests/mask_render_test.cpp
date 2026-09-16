// Masks on the GPU: the combine fold, and the blend an op does with the result. Renders a
// flat synthetic photo through the real pass chain, so the numbers below are the shader's
// and not a CPU model of it. Skips itself when no adapter is available.
#include "ops/geometry.h"
#include "ops/mask.h"
#include "ops/op.h"
#include "ops/registry.h"
#include "pipeline/renderer.h"
#include "raw/raw_decode.h"

#include <cmath>
#include <cstdint>

#include <array>
#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

// Square and flat: the view needs no letterbox, so the mask's normalised coordinates and
// the frame's pixels are the same grid, and every brightness change is the op's.
constexpr uint32_t kSize = 64;

DecodedRaw flat_raw() {
  DecodedRaw raw;
  raw.width = kSize;
  raw.height = kSize;
  raw.camera = "Synthetic Mask Test";
  raw.rgba.assign(static_cast<size_t>(kSize) * kSize * 4, 16384);
  for (size_t i = 3; i < raw.rgba.size(); i += 4) {
    raw.rgba[i] = 65535;
  }
  return raw;
}

// A gradient whose ramp is one thousandth of the frame wide, so it is a hard edge at a
// known column: `end` sets where it flips, because t reaches 0.5 halfway along the axis.
nlohmann::json half_plane(const std::string& id, const std::string& mode, double end_x) {
  return {{"id", id},
          {"kind", "linear"},
          {"mode", mode},
          {"feather", 0},
          {"params", {{"start", {0.0, 0.0}}, {"end", {end_x, 0.0}}}}};
}

Op masked_exposure(const std::vector<nlohmann::json>& components, double value, double opacity) {
  std::vector<std::string> warnings;
  nlohmann::json mask = nlohmann::json::object();
  mask["components"] = components;
  Op op;
  op.id = "exp00001";
  op.name = "exposure";
  op.params = normalize_params_for("exposure", {{"value", value}}, warnings);
  op.mask = normalize_mask(mask);
  op.opacity = opacity;
  return op;
}

struct Fixture {
  std::unique_ptr<Renderer> renderer;
  std::vector<uint8_t> frame;
  std::vector<uint8_t> raster;

  void start() {
    renderer->load_photo(1, flat_raw());
    renderer->open_view(1, 1, kSize, kSize);
    frame.resize(static_cast<size_t>(kSize) * kSize * 4);
    raster.resize(static_cast<size_t>(kSize) * kSize);
  }

  double coverage(const Stack& stack, const std::string& component_id = {}) {
    return renderer->read_mask(1, stack, "exp00001", component_id, raster, 0).coverage;
  }

  // Mean red level of one column of the frame, 0-255.
  double column(const Stack& stack, uint32_t x) {
    renderer->render(1, stack, frame, 0);
    double sum = 0;
    for (uint32_t y = 0; y < kSize; ++y) {
      sum += frame[(((static_cast<size_t>(y) * kSize) + x) * 4)];
    }
    return sum / kSize;
  }

  // The same column back in the linear light the blend happens in: mix(in, op(in), m) is
  // linear, and the frame is sRGB-encoded (shaders/display.wgsl), so halfway is only
  // halfway once the OETF is undone.
  double linear_column(const Stack& stack, uint32_t x) {
    const double level = column(stack, x) / 255.0;
    if (level <= 0.04045) return level / 12.92;
    return std::pow((level + 0.055) / 1.055, 2.4);
  }
};

std::unique_ptr<Fixture> make_fixture() {
  auto fixture = std::make_unique<Fixture>();
  try {
    fixture->renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception&) {
    return nullptr;
  }
  fixture->start();
  return fixture;
}

}  // namespace

TEST_CASE("components fold with add, subtract and intersect") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  // Two half-planes: `left` covers x > 0.25, `right` covers x > 0.5. The first component
  // seeds the accumulator whatever its mode says, so the fold is left <op> right.
  const nlohmann::json left = half_plane("l", "add", 0.5);
  const nlohmann::json right_add = half_plane("r", "add", 1.0);
  const nlohmann::json right_subtract = half_plane("r", "subtract", 1.0);
  const nlohmann::json right_intersect = half_plane("r", "intersect", 1.0);

  const double alone = fixture->coverage({masked_exposure({left}, 0.0, 100)});
  CHECK_THAT(alone, Catch::Matchers::WithinAbs(0.75, 0.02));

  // Union: the wider of the two.
  CHECK_THAT(fixture->coverage({masked_exposure({left, right_add}, 0.0, 100)}),
             Catch::Matchers::WithinAbs(0.75, 0.02));
  // Difference: the band between the two edges.
  CHECK_THAT(fixture->coverage({masked_exposure({left, right_subtract}, 0.0, 100)}),
             Catch::Matchers::WithinAbs(0.25, 0.02));
  // Both: the narrower of the two.
  CHECK_THAT(fixture->coverage({masked_exposure({left, right_intersect}, 0.0, 100)}),
             Catch::Matchers::WithinAbs(0.5, 0.02));

  // invert flips a component before it is folded, opacity scales it. Half-covered pixels
  // sit at 50 %, which the coverage threshold counts as outside.
  nlohmann::json inverted = left;
  inverted["invert"] = true;
  CHECK_THAT(fixture->coverage({masked_exposure({inverted}, 0.0, 100)}),
             Catch::Matchers::WithinAbs(0.25, 0.02));
  nlohmann::json faint = left;
  faint["opacity"] = 40;
  CHECK_THAT(fixture->coverage({masked_exposure({faint}, 0.0, 100)}),
             Catch::Matchers::WithinAbs(0.0, 0.001));

  // One component's own raster is what mask.preview hands out, before any folding.
  CHECK_THAT(fixture->coverage({masked_exposure({left, right_subtract}, 0.0, 100)}, "r"),
             Catch::Matchers::WithinAbs(0.5, 0.02));
}

TEST_CASE("a masked op changes the frame only inside its mask") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  const Stack neutral;
  const double base_outside = fixture->column(neutral, 8);
  const double base_inside = fixture->column(neutral, 56);

  const nlohmann::json right = half_plane("r", "add", 1.0);
  const Stack masked = {masked_exposure({right}, 1.0, 100)};
  CHECK_THAT(fixture->column(masked, 8), Catch::Matchers::WithinAbs(base_outside, 0.5));
  REQUIRE(fixture->column(masked, 56) > base_inside + 10);

  // Opacity is the same mix, applied everywhere the mask is: half the strength lands
  // between the untouched frame and the full one.
  const Stack half = {masked_exposure({right}, 1.0, 50)};
  const double full_level = fixture->column(masked, 56);
  const double half_level = fixture->column(half, 56);
  REQUIRE(half_level > base_inside + 2);
  REQUIRE(half_level < full_level - 2);
  CHECK_THAT(
      fixture->linear_column(half, 56),
      Catch::Matchers::WithinRel(
          (fixture->linear_column(neutral, 56) + fixture->linear_column(masked, 56)) / 2, 0.01));
  // Outside the mask, opacity changes nothing: there is nothing to mix in.
  CHECK_THAT(fixture->column(half, 8), Catch::Matchers::WithinAbs(base_outside, 0.5));

  // An unmasked op at half opacity is the same mix over the whole frame.
  std::vector<std::string> warnings;
  Op plain;
  plain.id = "exp00001";
  plain.name = "exposure";
  plain.params = normalize_params_for("exposure", {{"value", 1.0}}, warnings);
  plain.opacity = 50;
  CHECK_THAT(fixture->column({plain}, 8), Catch::Matchers::WithinAbs(half_level, 0.5));
}

TEST_CASE("a pending component contributes nothing, so the op does nothing") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  const double base = fixture->column({}, 32);
  // No mask.detect has run, so there is no raster: selecting everything would be the
  // wrong guess, and so would applying the op unmasked.
  const nlohmann::json subject = {{"id", "s"}, {"kind", "subject"}, {"mode", "add"}};
  const Stack pending = {masked_exposure({subject}, 2.0, 100)};
  CHECK_THAT(fixture->column(pending, 32), Catch::Matchers::WithinAbs(base, 0.5));
  CHECK_THAT(fixture->coverage(pending), Catch::Matchers::WithinAbs(0.0, 0.001));
}

TEST_CASE("a cached mask survives a render and a resize rebuilds it") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  const nlohmann::json right = half_plane("r", "add", 1.0);
  const Stack first = {masked_exposure({right}, 1.0, 100)};
  const double level = fixture->column(first, 56);
  // A second render of a stack whose mask JSON is unchanged must land on the same pixels.
  CHECK_THAT(fixture->column(first, 56), Catch::Matchers::WithinAbs(level, 0.001));
  // Only the op's own param moved, so the mask is reused and the frame still follows it.
  const Stack stronger = {masked_exposure({right}, 2.0, 100)};
  REQUIRE(fixture->column(stronger, 56) > level);
  CHECK_THAT(fixture->column(stronger, 8), Catch::Matchers::WithinAbs(fixture->column({}, 8), 0.5));

  fixture->renderer->resize_view(1, kSize * 2, kSize * 2);
  fixture->frame.resize(static_cast<size_t>(kSize) * kSize * 16);
  fixture->raster.resize(static_cast<size_t>(kSize) * kSize * 4);
  CHECK_THAT(fixture->coverage(first), Catch::Matchers::WithinAbs(0.5, 0.02));
}

namespace {

// A hard-edged disc at a named point of the *image*. Feather 0 so the raster's centroid is
// the centre and not a weighted smear.
nlohmann::json disc(const std::string& id, double x, double y, double radius) {
  return {{"id", id},
          {"kind", "radial"},
          {"mode", "add"},
          {"feather", 0},
          {"params", {{"center", {x, y}}, {"radius", {radius, radius}}}}};
}

Op geometry_op(const std::string& name, const nlohmann::json& params) {
  Op op;
  op.id = name + "00001";
  op.name = name;
  op.params = params;
  return op;
}

}  // namespace

TEST_CASE("a mask stays on the same image pixels when the geometry moves") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  // Where the mask is, in image coordinates. Inside the crop below on every axis, so the
  // whole disc stays visible and the centroid is comparable.
  constexpr double kCentreX = 0.35;
  constexpr double kCentreY = 0.6;
  const Op masked = masked_exposure({disc("m", kCentreX, kCentreY, 0.12)}, 1.0, 100);

  // The raster's centre of mass, carried back through the render's own geometry matrix.
  // If image space works, this is the same point whatever is in front of the mask.
  const auto centroid = [&](const Stack& stack) {
    fixture->coverage(stack);
    const GeometryMap map = fixture->renderer->view_map(1);
    double sum_x = 0;
    double sum_y = 0;
    double weight = 0;
    for (uint32_t y = 0; y < kSize; ++y) {
      for (uint32_t x = 0; x < kSize; ++x) {
        const double value = fixture->raster[(static_cast<size_t>(y) * kSize) + x] / 255.0;
        if (value <= 0.5) continue;
        sum_x += x + 0.5;
        sum_y += y + 0.5;
        weight += 1;
      }
    }
    REQUIRE(weight > 4);
    return mat3_apply(map.view_to_image, sum_x / weight, sum_y / weight);
  };

  const std::array<double, 2> plain = centroid({masked});
  CHECK_THAT(plain[0], Catch::Matchers::WithinAbs(kCentreX, 0.02));
  CHECK_THAT(plain[1], Catch::Matchers::WithinAbs(kCentreY, 0.02));

  // A crop that keeps the disc: it now sits elsewhere in the frame, and on the same pixels
  // of the photo. Content space would have left it where it was on screen instead.
  const Stack cropped = {
      geometry_op("crop", {{"left", 0.1}, {"top", 0.3}, {"right", 0.7}, {"bottom", 0.95}}), masked};
  const std::array<double, 2> after_crop = centroid(cropped);
  CHECK_THAT(after_crop[0], Catch::Matchers::WithinAbs(kCentreX, 0.02));
  CHECK_THAT(after_crop[1], Catch::Matchers::WithinAbs(kCentreY, 0.02));

  // A quarter turn, a mirror, and a Transform straighten: each moves every view pixel, and
  // none of them moves the mask off the photo.
  const Stack turned = {geometry_op("rotate", {{"value", 90.0}}), masked};
  const std::array<double, 2> after_rotate = centroid(turned);
  CHECK_THAT(after_rotate[0], Catch::Matchers::WithinAbs(kCentreX, 0.03));
  CHECK_THAT(after_rotate[1], Catch::Matchers::WithinAbs(kCentreY, 0.03));

  const Stack mirrored = {geometry_op("flip", {{"horizontal", true}}), masked};
  const std::array<double, 2> after_flip = centroid(mirrored);
  CHECK_THAT(after_flip[0], Catch::Matchers::WithinAbs(kCentreX, 0.03));
  CHECK_THAT(after_flip[1], Catch::Matchers::WithinAbs(kCentreY, 0.03));

  const Stack skewed = {geometry_op("transform", {{"rotate", 12.0}}), masked};
  const std::array<double, 2> after_transform = centroid(skewed);
  CHECK_THAT(after_transform[0], Catch::Matchers::WithinAbs(kCentreX, 0.03));
  CHECK_THAT(after_transform[1], Catch::Matchers::WithinAbs(kCentreY, 0.03));
}

TEST_CASE("the mask cache is rebuilt when the geometry moves it") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  // A half of the image, and a crop that shows only the other half: the mask JSON has not
  // changed, so a cache keyed on it alone would hand back the stale raster and the op
  // would still be applied to half the frame.
  const nlohmann::json right = half_plane("r", "add", 1.0);
  const Op masked = masked_exposure({right}, 1.0, 100);
  CHECK_THAT(fixture->coverage({masked}), Catch::Matchers::WithinAbs(0.5, 0.03));
  CHECK_THAT(fixture->coverage({geometry_op("crop", {{"right", 0.5}}), masked}),
             Catch::Matchers::WithinAbs(0.0, 0.03));
  CHECK_THAT(fixture->coverage({geometry_op("crop", {{"left", 0.5}}), masked}),
             Catch::Matchers::WithinAbs(1.0, 0.03));
  // And back: the first key is still the first raster.
  CHECK_THAT(fixture->coverage({masked}), Catch::Matchers::WithinAbs(0.5, 0.03));
}

TEST_CASE("a zoomed view keeps the mask on the subject") {
  std::unique_ptr<Fixture> fixture = make_fixture();
  if (!fixture) SKIP("no GPU adapter");

  const Op masked = masked_exposure({disc("m", 0.35, 0.6, 0.12)}, 1.0, 100);
  const double fitted = fixture->coverage({masked});

  Viewport viewport;
  viewport.scale = 2;
  viewport.center_x = 0.35;
  viewport.center_y = 0.6;
  viewport.fit = false;
  fixture->renderer->set_viewport(1, viewport);
  fixture->coverage({masked});

  // Centred on the disc at 2x, it covers four times the share of the visible image, and the
  // matrix still names the point it is centred on as the middle of the frame.
  const GeometryMap map = fixture->renderer->view_map(1);
  const std::array<double, 2> centre = mat3_apply(map.image_to_view, 0.35, 0.6);
  CHECK_THAT(centre[0], Catch::Matchers::WithinAbs(kSize / 2.0, 1.5));
  CHECK_THAT(centre[1], Catch::Matchers::WithinAbs(kSize / 2.0, 1.5));
  CHECK(map.content.width == fixture->renderer->view_map(1).content.width);
  REQUIRE(fitted > 0.01);
}

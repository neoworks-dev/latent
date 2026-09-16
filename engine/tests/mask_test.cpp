// The mask model without a GPU: what the engine accepts, what it refuses, what it fills
// in, and what a brush stroke list rasterises to. The combine maths and the blend need a
// device and live in mask_render_test.cpp.
#include "ops/mask.h"

#include "ops/mask_raster.h"

#include <cstdint>

#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

nlohmann::json one(const nlohmann::json& component) {
  return {{"components", nlohmann::json::array({component})}};
}

double mean_level(const GrayImage& image) {
  double sum = 0;
  for (const uint8_t pixel : image.pixels) {
    sum += pixel;
  }
  return image.pixels.empty() ? 0 : sum / static_cast<double>(image.pixels.size());
}

}  // namespace

TEST_CASE("a mask round trips through its canonical form") {
  const nlohmann::json given = {
      {"components",
       nlohmann::json::array({{{"id", "m1"},
                               {"kind", "radial"},
                               {"mode", "add"},
                               {"params", {{"center", {0.4, 0.6}}}}},
                              {{"id", "m2"},
                               {"kind", "luminance"},
                               {"mode", "intersect"},
                               {"invert", true},
                               {"opacity", 60},
                               {"params", {{"range", {0.2, 0.8}}, {"smoothness", 0.3}}}}})}};

  const nlohmann::json canonical = normalize_mask(given);
  REQUIRE(normalize_mask(canonical) == canonical);

  const Mask mask = mask_from_json(canonical);
  REQUIRE(mask.components.size() == 2);
  REQUIRE(mask.components[0].kind == MaskKind::Radial);
  REQUIRE(mask.components[0].mode == MaskMode::Add);
  // A radial without a radius gets Lightroom's soft default, not zero.
  REQUIRE(mask.components[0].feather == 50);
  REQUIRE(mask.components[0].params["radius"][0] == 0.3);
  REQUIRE(mask.components[0].params["center"][1] == 0.6);
  REQUIRE(mask.components[1].mode == MaskMode::Intersect);
  REQUIRE(mask.components[1].invert);
  REQUIRE(mask.components[1].opacity == 60);
  REQUIRE(mask.components[1].feather == 0);
  // Every component the caller did not mark is ready: only AI kinds start pending.
  REQUIRE(mask.components[0].state == MaskState::Ready);
}

TEST_CASE("a gradient defaults to the full ramp and a brush to a soft edge") {
  REQUIRE(mask_from_json(one({{"id", "a"}, {"kind", "linear"}, {"mode", "add"}}))
              .components[0]
              .feather == 100);
  REQUIRE(mask_from_json(one({{"id", "a"}, {"kind", "brush"}, {"mode", "add"}}))
              .components[0]
              .feather == 50);
  REQUIRE(mask_from_json(one({{"id", "a"}, {"kind", "color"}, {"mode", "add"}}))
              .components[0]
              .feather == 0);
}

TEST_CASE("an AI component nobody has run is pending, not ready") {
  const Mask fresh = mask_from_json(one({{"id", "a"}, {"kind", "subject"}, {"mode", "add"}}));
  REQUIRE(fresh.components[0].state == MaskState::Pending);
  REQUIRE(!fresh.components[0].contributes());
  REQUIRE(mask_kind_is_ai(MaskKind::Subject));
  REQUIRE(!mask_kind_is_ai(MaskKind::Brush));

  // Once it has a raster it contributes, and a failed one never does.
  const Mask ready = mask_from_json(one({{"id", "a"},
                                         {"kind", "subject"},
                                         {"mode", "add"},
                                         {"params", {{"raster", "masks/a.png"}}}}));
  REQUIRE(ready.components[0].state == MaskState::Ready);
  REQUIRE(ready.components[0].contributes());
  REQUIRE(ready.components[0].params["raster"] == "masks/a.png");
  const Mask failed =
      mask_from_json(one({{"id", "a"}, {"kind", "sky"}, {"mode", "add"}, {"state", "failed"}}));
  REQUIRE(!failed.components[0].contributes());
}

TEST_CASE("a malformed mask is refused rather than clamped") {
  // Two components cannot share an id: mask.preview and mask.stroke address them by it.
  REQUIRE_THROWS_AS(
      mask_from_json({{"components", nlohmann::json::array({{{"id", "m"}, {"kind", "radial"}},
                                                            {{"id", "m"}, {"kind", "brush"}}})}}),
      OpError);
  REQUIRE_THROWS_AS(mask_from_json(one({{"id", "a"}, {"kind", "sorcery"}})), OpError);
  REQUIRE_THROWS_AS(mask_from_json(one({{"id", "a"}, {"kind", "radial"}, {"mode", "xor"}})),
                    OpError);
  REQUIRE_THROWS_AS(mask_from_json(one({{"id", "a"}, {"kind", "radial"}, {"opacity", 140}})),
                    OpError);
  REQUIRE_THROWS_AS(mask_from_json(one({{"id", "a"}, {"kind", "radial"}, {"feather", -1}})),
                    OpError);
  // Coordinates are normalised over the image, with a frame of slack for a drag that went
  // off-canvas; a pixel coordinate is a caller bug.
  REQUIRE_THROWS_AS(
      mask_from_json(one({{"id", "a"}, {"kind", "radial"}, {"params", {{"center", {640, 480}}}}})),
      OpError);
  REQUIRE_THROWS_AS(mask_from_json(one({{"id", "a"},
                                        {"kind", "linear"},
                                        {"params", {{"start", nlohmann::json::array({0.5})}}}})),
                    OpError);
  REQUIRE_THROWS_AS(mask_from_json(one(
                        {{"id", "a"}, {"kind", "luminance"}, {"params", {{"range", {0.9, 0.1}}}}})),
                    OpError);
  REQUIRE_THROWS_AS(mask_from_json(one(
                        {{"id", "a"}, {"kind", "color"}, {"params", {{"samples", {{0.5, 0.5}}}}}})),
                    OpError);
  // text needs its prompt: there is nothing for Florence-2 to look for without it.
  REQUIRE_THROWS_AS(mask_from_json(one({{"id", "a"}, {"kind", "text"}})), OpError);
  REQUIRE_NOTHROW(
      mask_from_json(one({{"id", "a"}, {"kind", "text"}, {"params", {{"prompt", "cat"}}}})));
}

TEST_CASE("the mask hash keys the raster cache on the params and the size") {
  const nlohmann::json mask = normalize_mask(one({{"id", "a"}, {"kind", "radial"}}));
  const std::string base = mask_hash(mask, 1280, 720);
  REQUIRE(mask_hash(mask, 1280, 720) == base);
  REQUIRE(mask_hash(mask, 640, 360) != base);
  const nlohmann::json moved =
      normalize_mask(one({{"id", "a"}, {"kind", "radial"}, {"params", {{"angle", 15}}}}));
  REQUIRE(mask_hash(moved, 1280, 720) != base);
}

TEST_CASE("brush strokes live in the params and append one at a time") {
  nlohmann::json params = {{"size", 0.1}, {"flow", 80}};
  REQUIRE(brush_strokes(params).empty());

  BrushStroke stroke;
  stroke.size = 0.1;
  stroke.flow = 80;
  stroke.points = {{0.2, 0.2, 1.0}, {0.4, 0.4, 0.5}};
  append_brush_stroke(params, stroke);
  BrushStroke erase = stroke;
  erase.erase = true;
  erase.points = {{0.3, 0.3, 1.0}};
  append_brush_stroke(params, erase);

  const std::vector<BrushStroke> read = brush_strokes(params);
  REQUIRE(read.size() == 2);
  REQUIRE(read[0].points.size() == 2);
  REQUIRE(read[0].points[1].pressure == 0.5);
  REQUIRE(!read[0].erase);
  REQUIRE(read[1].erase);

  // The canonical form keeps them, because they are the mask (one undo = one stroke).
  const nlohmann::json canonical =
      normalize_mask(one({{"id", "b"}, {"kind", "brush"}, {"params", params}}));
  REQUIRE(canonical["components"][0]["params"][std::string(kBrushStrokeDataKey)].size() == 2);
  REQUIRE(canonical["components"][0]["params"]["flow"] == 80.0);

  REQUIRE(brush_stroke_relative_path("b") == "masks/b.strokes.json");
  REQUIRE(mask_raster_relative_path("b", "0123456789abcdef0011") == "masks/b.0123456789abcdef.png");
  REQUIRE(sidecar_dir_for("/photos/a.ARW") == "/photos/a.ARW.latent.d");
  REQUIRE(mask_dir_for("/photos/a.ARW") == "/photos/a.ARW.latent.d/masks");
}

TEST_CASE("the brush rasteriser stamps, joins and erases") {
  BrushStroke stroke;
  stroke.size = 0.2;  // diameter, fraction of the long edge: r = 10 px at 100 px
  stroke.flow = 100;
  stroke.points = {{0.2, 0.5, 1.0}, {0.8, 0.5, 1.0}};

  const GrayImage hard = rasterize_brush({stroke}, 0, 100, 100);
  REQUIRE(hard.width == 100);
  REQUIRE(hard.pixels.size() == 100 * 100);
  // The line joins its two ends instead of leaving two dots.
  REQUIRE(hard.pixels[(50 * 100) + 50] == 255);
  REQUIRE(hard.pixels[(50 * 100) + 20] == 255);
  REQUIRE(hard.pixels[(50 * 100) + 80] == 255);
  // And stays inside its radius.
  REQUIRE(hard.pixels[(10 * 100) + 50] == 0);
  REQUIRE(hard.pixels[(50 * 100) + 5] == 0);

  // Feather only softens the rim, so it costs coverage but keeps the core: at full
  // feather the peak is a stamp centre half a pixel away, not quite 255.
  const GrayImage soft = rasterize_brush({stroke}, 100, 100, 100);
  REQUIRE(soft.pixels[(50 * 100) + 50] > 240);
  REQUIRE(mean_level(soft) < mean_level(hard));

  // Flow scales the whole stroke.
  BrushStroke faint = stroke;
  faint.flow = 50;
  const GrayImage weak = rasterize_brush({faint}, 0, 100, 100);
  REQUIRE(weak.pixels[(50 * 100) + 50] == 128);

  // An erase stroke over the same line takes it back out.
  BrushStroke erase = stroke;
  erase.erase = true;
  const GrayImage erased = rasterize_brush({stroke, erase}, 0, 100, 100);
  REQUIRE(erased.pixels[(50 * 100) + 50] == 0);
  REQUIRE(mean_level(erased) == 0);

  // Two half-flow passes build up, which is what flow means.
  const GrayImage twice = rasterize_brush({faint, faint}, 0, 100, 100);
  REQUIRE(twice.pixels[(50 * 100) + 50] > weak.pixels[(50 * 100) + 50]);
  REQUIRE(twice.pixels[(50 * 100) + 50] < 255);

  REQUIRE(mean_level(rasterize_brush({}, 0, 100, 100)) == 0);
}

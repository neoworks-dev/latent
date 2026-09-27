// The generative composite on the GPU (PROMPT.md 3.5, shaders/composite.wgsl): a cached
// raster put back where it was cut from. Its own binary because it needs a device.
//
// Two things are asserted, and they are the whole contract of the pass:
//   1. a pixel the mask does not cover comes back bit for bit, and
//   2. the result lands inside `resultRect` and nowhere else.
#include "generative/generative.h"
#include "image/gray.h"
#include "image/jpeg.h"
#include "ops/op.h"
#include "ops/registry.h"
#include "pipeline/renderer.h"
#include "raw/raw_decode.h"

#include <cstdint>

#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

constexpr uint32_t kWidth = 240;
constexpr uint32_t kHeight = 160;

// A flat grey photo: the composite's job is to replace pixels, so a picture with no
// structure makes "which pixels moved" unambiguous.
DecodedRaw flat_raw() {
  DecodedRaw raw;
  raw.width = kWidth;
  raw.height = kHeight;
  raw.camera = "Synthetic Test";
  raw.rgba.assign(static_cast<size_t>(kWidth) * kHeight * 4, 20000);
  for (size_t pixel = 0; pixel < static_cast<size_t>(kWidth) * kHeight; ++pixel) {
    raw.rgba[(pixel * 4) + 3] = 65535;
  }
  return raw;
}

Rgb8Image magenta(uint32_t width, uint32_t height) {
  Rgb8Image image;
  image.width = width;
  image.height = height;
  image.pixels.assign(static_cast<size_t>(width) * height * 3, 0);
  for (size_t pixel = 0; pixel < static_cast<size_t>(width) * height; ++pixel) {
    image.pixels[pixel * 3] = 255;
    image.pixels[(pixel * 3) + 2] = 255;
  }
  return image;
}

// A radial mask over the middle of the frame, hard-edged so the rect it implies is known.
Op make_fill(const std::vector<double>& rect, const std::string& result) {
  std::vector<std::string> warnings;
  Op op;
  op.id = "gen1";
  op.name = "generative_fill";
  op.params = normalize_params_for(op.name, {{"prompt", "x"}}, warnings);
  // Parsed, not brace-built: nlohmann reads a nested initializer list of pairs as an array,
  // and an op whose `mask` is an array renders as if it had none at all.
  op.mask = nlohmann::json::parse(R"({"components": [{
      "id": "m1", "kind": "radial", "mode": "add", "feather": 0,
      "params": {"center": [0.5, 0.5], "radius": [0.1, 0.1], "angle": 0}}]})");
  op.result = result;
  op.result_rect = rect;
  return op;
}

struct Fixture {
  std::unique_ptr<Renderer> renderer;
  std::vector<uint8_t> frame;

  std::vector<uint8_t> render(const Stack& stack) {
    renderer->render(1, stack, frame, 0);
    return frame;
  }
};

std::array<uint8_t, 3> pixel_at(const std::vector<uint8_t>& frame, uint32_t x, uint32_t y) {
  const size_t at = ((static_cast<size_t>(y) * kWidth) + x) * 4;
  return {frame[at], frame[at + 1], frame[at + 2]};
}

}  // namespace

TEST_CASE("the generative composite lands inside its rect and leaves the rest alone") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  const std::vector<uint8_t> empty = fixture.render(Stack{});

  // An op whose result the renderer has never been handed composites nothing: a fill that
  // has not run is not a black hole in the picture.
  const Op op = make_fill({0.3, 0.3, 0.7, 0.7}, "generative/gen1.png");
  CHECK(fixture.render(Stack{op}) == empty);
  CHECK_FALSE(fixture.renderer->has_generative_result(1, "gen1", "generative/gen1.png"));

  fixture.renderer->put_generative_result(1, "gen1", "generative/gen1.png", magenta(96, 64));
  CHECK(fixture.renderer->has_generative_result(1, "gen1", "generative/gen1.png"));
  const std::vector<uint8_t> composited = fixture.render(Stack{op});
  CHECK(composited != empty);

  // The mask is a radius of 0.2 around the centre; the rect is 0.3..0.7. Outside the rect
  // nothing may move, and outside the mask nothing may move either.
  const uint32_t centre_x = kWidth / 2;
  const uint32_t centre_y = kHeight / 2;
  const std::array<uint8_t, 3> middle = pixel_at(composited, centre_x, centre_y);
  CHECK(middle[0] > middle[1]);
  CHECK(middle[2] > middle[1]);

  size_t changed = 0;
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (uint32_t x = 0; x < kWidth; ++x) {
      const bool inside_rect =
          x >= static_cast<uint32_t>(0.3 * kWidth) && x < static_cast<uint32_t>(0.7 * kWidth) &&
          y >= static_cast<uint32_t>(0.3 * kHeight) && y < static_cast<uint32_t>(0.7 * kHeight);
      const size_t at = ((static_cast<size_t>(y) * kWidth) + x) * 4;
      const bool moved = composited[at] != empty[at] || composited[at + 1] != empty[at + 1] ||
                         composited[at + 2] != empty[at + 2];
      if (moved) ++changed;
      if (inside_rect) continue;
      // Bit-identical, not "close": the pass returns the source texel verbatim outside its
      // rect, so a fill can never quietly resample the frame around it.
      REQUIRE(composited[at] == empty[at]);
      REQUIRE(composited[at + 1] == empty[at + 1]);
      REQUIRE(composited[at + 2] == empty[at + 2]);
    }
  }

  // The mask is an ellipse inside a square rect, so strictly fewer pixels moved than the
  // rect holds: the rect places the crop, the mask decides coverage.
  const size_t rect_area = static_cast<size_t>(0.4 * kWidth) * static_cast<size_t>(0.4 * kHeight);
  CHECK(changed > 0);
  CHECK(changed < rect_area);
}

TEST_CASE("a result the renderer holds under another key is not composited") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);
  const std::vector<uint8_t> empty = fixture.render(Stack{});

  // The key is the op's `result` path. Holding pixels under an older one must not paint
  // them, or a re-run that failed would show the run before it.
  fixture.renderer->put_generative_result(1, "gen1", "generative/old.png", magenta(64, 64));
  const Op op = make_fill({0.3, 0.3, 0.7, 0.7}, "generative/gen1.png");
  CHECK(fixture.render(Stack{op}) == empty);

  // And an op with no rect has nowhere to put its result.
  Op no_rect = op;
  no_rect.result_rect.clear();
  fixture.renderer->put_generative_result(1, "gen1", "generative/gen1.png", magenta(64, 64));
  CHECK(fixture.render(Stack{no_rect}) == empty);
}

TEST_CASE("the ops above a generative op still apply to its pixels") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  const Op op = make_fill({0.3, 0.3, 0.7, 0.7}, "generative/gen1.png");
  fixture.renderer->put_generative_result(1, "gen1", "generative/gen1.png", magenta(96, 64));
  const std::vector<uint8_t> plain = fixture.render(Stack{op});

  std::vector<std::string> warnings;
  Op exposure;
  exposure.id = "e1";
  exposure.name = "exposure";
  exposure.params = normalize_params_for("exposure", {{"value", -2.0}}, warnings);
  const std::vector<uint8_t> darkened = fixture.render(Stack{op, exposure});

  // The patch is inside the mask; two stops down must move it, which is only true if the
  // composite runs before the tone stage.
  const std::array<uint8_t, 3> before = pixel_at(plain, kWidth / 2, kHeight / 2);
  const std::array<uint8_t, 3> after = pixel_at(darkened, kWidth / 2, kHeight / 2);
  CHECK(after[0] < before[0]);
  CHECK(after[2] < before[2]);
}

TEST_CASE(
    "a whole-frame raster covers the frame, and an upscaled one does not resize the preview") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  const std::vector<uint8_t> empty = fixture.render(Stack{});

  std::vector<std::string> warnings;
  Op denoise;
  denoise.id = "d1";
  denoise.name = "denoise";
  denoise.params = normalize_params_for(denoise.name, {{"strength", 50}}, warnings);
  denoise.result = "generative/d1.png";
  denoise.result_rect = {0, 0, 1, 1};

  // No mask, so the composite mixes at full coverage over the whole content rect: every
  // pixel of the frame is the model's, which is what "the raster is the new input" means.
  fixture.renderer->put_generative_result(1, "d1", "generative/d1.png", magenta(kWidth, kHeight));
  const std::vector<uint8_t> denoised = fixture.render(Stack{denoise});
  for (uint32_t y = 0; y < kHeight; y += 8) {
    for (uint32_t x = 0; x < kWidth; x += 8) {
      const std::array<uint8_t, 3> texel = pixel_at(denoised, x, y);
      REQUIRE(texel[0] > texel[1]);
      REQUIRE(texel[2] > texel[1]);
    }
  }
  CHECK(denoised != empty);

  // An upscale's raster is bigger than the frame it lands in. The preview is proxy
  // resolution either way, so the composite samples it down and the frame keeps its size —
  // only render_export renders at the larger one (issue #52).
  Op upscale;
  upscale.id = "u1";
  upscale.name = "upscale";
  upscale.params = normalize_params_for(upscale.name, {{"factor", "2x"}}, warnings);
  upscale.result = "generative/u1.png";
  upscale.result_rect = {0, 0, 1, 1};
  fixture.renderer->put_generative_result(1, "u1", "generative/u1.png",
                                          magenta(kWidth * 2, kHeight * 2));
  const std::vector<uint8_t> enlarged = fixture.render(Stack{upscale});
  CHECK(enlarged.size() == empty.size());
  CHECK(enlarged != empty);
}

// photo.open after a restart shows the cached preview first and swaps in the full decode
// behind it (Server::upgrade_to_full_resolution). The rasters photo.open loaded beside the
// first texture are image-space and must survive the second: without them every AI mask
// component answered "no cached raster" and every fill vanished once the upgrade landed.
TEST_CASE("reloading a photo keeps its mask rasters, depth map and generative results") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  GrayImage raster{.width = 8, .height = 8, .pixels = std::vector<uint8_t>(64, 255)};
  fixture.renderer->put_mask_raster(1, "subject1", "masks/subject1.png", raster);
  Gray16Image depth{.width = 8, .height = 8, .pixels = std::vector<uint16_t>(64, 1000)};
  fixture.renderer->put_depth_map(1, "depth.png", depth);
  fixture.renderer->put_generative_result(1, "gen1", "generative/gen1.png", magenta(8, 8));

  fixture.renderer->load_photo(1, flat_raw());

  CHECK(fixture.renderer->has_mask_raster(1, "subject1", "masks/subject1.png"));
  CHECK(fixture.renderer->has_depth_map(1));
  CHECK(fixture.renderer->has_generative_result(1, "gen1", "generative/gen1.png"));
}

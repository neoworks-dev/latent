// The relight passes on the GPU (PROMPT.md 3.8, shaders/relight.wgsl). Its own binary
// because it needs a device, and its own file because — like a generative op — the op
// renders nothing from its params alone: it needs the photo's depth map.
//
// The scene is deliberately crude. A flat grey photo, a depth map that is far everywhere
// except one near bar in the middle, and a light above it. That is enough to assert the
// four things the pass promises: no map means no light, the light falls off with distance,
// the bar casts a shadow, and the shafts are darker behind the bar than beside it.
#include "image/gray.h"
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

constexpr uint32_t kSize = 128;

DecodedRaw flat_raw() {
  DecodedRaw raw;
  raw.width = kSize;
  raw.height = kSize;
  raw.camera = "Synthetic Relight Test";
  raw.rgba.assign(static_cast<size_t>(kSize) * kSize * 4, 12000);
  for (size_t pixel = 0; pixel < static_cast<size_t>(kSize) * kSize; ++pixel) {
    raw.rgba[(pixel * 4) + 3] = 65535;
  }
  return raw;
}

// Far everywhere (0), with one near bar across the middle third: the tree the light has to
// shine past. 16-bit, like every map the estimator produces.
Gray16Image bar_depth() {
  Gray16Image map;
  map.width = kSize;
  map.height = kSize;
  map.pixels.assign(static_cast<size_t>(kSize) * kSize, 0);
  for (uint32_t y = 0; y < kSize; ++y) {
    const double v = (y + 0.5) / kSize;
    if (v < 0.4 || v > 0.6) continue;
    for (uint32_t x = 0; x < kSize; ++x) {
      const double u = (x + 0.5) / kSize;
      if (u < 0.35 || u > 0.65) continue;
      map.pixels[(static_cast<size_t>(y) * kSize) + x] = 59000;
    }
  }
  return map;
}

Op make_light(const nlohmann::json& params) {
  std::vector<std::string> warnings;
  Op op;
  op.id = "lit00001";
  op.name = "relight";
  op.params = normalize_params_for("relight", params, warnings);
  REQUIRE(warnings.empty());
  return op;
}

struct Fixture {
  std::unique_ptr<Renderer> renderer;
  std::vector<uint8_t> frame;

  void render(const Stack& stack) { renderer->render(1, stack, frame, 0); }

  // Green, which on a neutral photo tracks luminance and needs no weighting.
  int level(double u, double v) {
    const auto x = static_cast<uint32_t>(u * kSize);
    const auto y = static_cast<uint32_t>(v * kSize);
    return frame[(((static_cast<size_t>(y) * kSize) + x) * 4) + 1];
  }
};

// A light over the top of the frame, in front of the far background and behind the bar.
nlohmann::json overhead(double intensity, double rays, double occlusion) {
  return {{"x", 0.5},      {"y", 0.08},    {"distance", 30},         {"intensity", intensity},
          {"radius", 70},  {"rays", rays}, {"occlusion", occlusion}, {"rayLength", 100},
          {"rayDecay", 20}};
}

}  // namespace

TEST_CASE("a relight op renders nothing until the photo has a depth map") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kSize, kSize);
  fixture.frame.resize(static_cast<size_t>(kSize) * kSize * 4);

  fixture.render(Stack{});
  const std::vector<uint8_t> empty = fixture.frame;

  REQUIRE_FALSE(fixture.renderer->has_depth_map(1));
  const Stack lit = {make_light(overhead(100, 100, 60))};
  fixture.render(lit);
  CHECK(fixture.frame == empty);

  // The same stack, once the map is there.
  fixture.renderer->put_depth_map(1, "test", bar_depth());
  REQUIRE(fixture.renderer->has_depth_map(1));
  fixture.render(lit);
  CHECK(fixture.frame != empty);
}

TEST_CASE("the light falls off with distance and the bar shadows what is behind it") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kSize, kSize);
  fixture.frame.resize(static_cast<size_t>(kSize) * kSize * 4);
  fixture.renderer->put_depth_map(1, "test", bar_depth());

  // Shadows off: what is left is the falloff, and nothing else.
  fixture.render(Stack{make_light(overhead(100, 0, 0))});
  const int near_light = fixture.level(0.5, 0.15);
  const int far_corner = fixture.level(0.05, 0.95);
  CHECK(near_light > far_corner);
  // Both sides of the frame are the same distance from a light on its centre line.
  CHECK(fixture.level(0.1, 0.85) == fixture.level(0.9, 0.85));

  // Under the bar, with shadows off and then on. Only the shadow term moved, so the drop
  // is the bar's and not the falloff's.
  const int shadowed_before = fixture.level(0.5, 0.85);
  const int clear_before = fixture.level(0.08, 0.85);
  fixture.render(Stack{make_light(overhead(100, 0, 100))});
  const int shadowed_after = fixture.level(0.5, 0.85);
  const int clear_after = fixture.level(0.08, 0.85);
  CHECK(shadowed_after < shadowed_before);
  // A pixel whose line to the light misses the bar keeps the light it had.
  CHECK(clear_after == clear_before);
  CHECK(shadowed_after < clear_after);
}

TEST_CASE("light rays are airlight: they brighten the gaps and not the shadow") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kSize, kSize);
  fixture.frame.resize(static_cast<size_t>(kSize) * kSize * 4);
  fixture.renderer->put_depth_map(1, "test", bar_depth());

  fixture.render(Stack{});
  const std::vector<uint8_t> empty = fixture.frame;

  // Rays alone, with the surface light off: the frame still changes, because scattering
  // does not need a surface to land on.
  fixture.render(Stack{make_light(overhead(0, 100, 0))});
  CHECK(fixture.frame != empty);
  const int behind_bar = fixture.level(0.5, 0.85);
  const int beside_bar = fixture.level(0.08, 0.85);
  CHECK(beside_bar > behind_bar);
}

TEST_CASE("a mask gates the relight like any other op") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, flat_raw());
  fixture.renderer->open_view(1, 1, kSize, kSize);
  fixture.frame.resize(static_cast<size_t>(kSize) * kSize * 4);
  fixture.renderer->put_depth_map(1, "test", bar_depth());

  fixture.render(Stack{});
  const int unlit_left = fixture.level(0.05, 0.5);
  const int unlit_right = fixture.level(0.9, 0.5);

  Op op = make_light(overhead(100, 0, 0));
  // Parsed, not brace-built: nlohmann reads a nested initializer list of pairs as an array,
  // and an op whose `mask` is an array renders as if it had none at all.
  op.mask = nlohmann::json::parse(R"({"components": [{
      "id": "m1", "kind": "linear", "mode": "add", "feather": 0,
      "params": {"start": [0.0, 0.0], "end": [0.4, 0.0]}}]})");
  fixture.render(Stack{op});
  // Left of the gradient's midpoint the mask is empty and the pixel is untouched; right of
  // it the light lands.
  CHECK(fixture.level(0.05, 0.5) == unlit_left);
  CHECK(fixture.level(0.9, 0.5) > unlit_right);
}

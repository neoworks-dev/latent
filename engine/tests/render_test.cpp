// The only test that touches the GPU: it renders a synthetic photo through the real pass
// chain and asserts two things about every op in the registry —
//
//   1. at its defaults it renders exactly what an empty stack renders, and
//   2. at a non-default value it renders something else.
//
// (1) is the contract the whole panel rests on: adding an op must not change the picture
// until a slider moves. (2) is what stops (1) from being satisfied by an op that does
// nothing at all. The test skips itself when no adapter is available.
#include "generative/generative.h"
#include "ops/op.h"
#include "ops/registry.h"
#include "pipeline/renderer.h"
#include "raw/raw_decode.h"

#include <cmath>
#include <cstdint>

#include <algorithm>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

constexpr uint32_t kWidth = 320;
constexpr uint32_t kHeight = 200;

// Hue sweep, a tone ramp, a hard checker for the edge-driven ops and per-pixel noise for
// the noise ones: every op in the registry has something to bite on.
DecodedRaw synthetic_raw() {
  DecodedRaw raw;
  raw.width = kWidth;
  raw.height = kHeight;
  raw.camera = "Synthetic Test";
  raw.rgba.resize(static_cast<size_t>(kWidth) * kHeight * 4);
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (uint32_t x = 0; x < kWidth; ++x) {
      const double u = static_cast<double>(x) / kWidth;
      const double v = static_cast<double>(y) / kHeight;
      const double hue = u * 6.0;
      const double checker = ((x / 8) + (y / 8)) % 2 == 0 ? 1.0 : 0.45;
      const double noise = std::fmod(std::sin((x * 12.9898) + (y * 78.233)) * 43758.5453, 1.0);
      const double level = (0.1 + (0.8 * v)) * checker * (1.0 + (0.06 * noise));
      // A floor under every channel: a fully saturated sweep has a zero dark channel
      // everywhere, which is a haze-free image and would leave dehaze nothing to do.
      const double red = 0.25 + (0.75 * std::clamp(std::abs(hue - 3.0) - 1.0, 0.0, 1.0));
      const double green = 0.25 + (0.75 * std::clamp(2.0 - std::abs(hue - 2.0), 0.0, 1.0));
      const double blue = 0.25 + (0.75 * std::clamp(2.0 - std::abs(hue - 4.0), 0.0, 1.0));
      const size_t index = ((static_cast<size_t>(y) * kWidth) + x) * 4;
      raw.rgba[index] = static_cast<uint16_t>(std::clamp(level * red, 0.0, 1.0) * 65535);
      raw.rgba[index + 1] = static_cast<uint16_t>(std::clamp(level * green, 0.0, 1.0) * 65535);
      raw.rgba[index + 2] = static_cast<uint16_t>(std::clamp(level * blue, 0.0, 1.0) * 65535);
      raw.rgba[index + 3] = 65535;
    }
  }
  return raw;
}

uint64_t hash_of(const std::vector<uint8_t>& pixels) {
  uint64_t hash = 1469598103934665603ULL;
  for (const uint8_t byte : pixels) {
    hash = (hash ^ byte) * 1099511628211ULL;
  }
  return hash;
}

// One value per op that must visibly change the frame. Every registered op needs an entry
// here, which is asserted below, so a new op cannot quietly opt out of the test.
const std::map<std::string, nlohmann::json>& strong_values() {
  static const std::map<std::string, nlohmann::json> values = {
      {"exposure", {{"value", 1.5}}},
      {"contrast", {{"value", 60}}},
      {"highlights", {{"value", -70}}},
      {"shadows", {{"value", 70}}},
      {"whites", {{"value", 60}}},
      {"blacks", {{"value", -60}}},
      {"tone_curve",
       {{"highlights", 60},
        {"shadows", -40},
        {"rgb", nlohmann::json::array({{{"x", 0.0}, {"y", 0.1}}, {{"x", 1.0}, {"y", 0.9}}})}}},
      {"white_balance", {{"mode", "kelvin"}, {"kelvin", 9000}, {"tint", 40}}},
      {"vibrance", {{"value", 80}}},
      {"saturation", {{"value", -80}}},
      {"color_mixer", {{"redHue", 80}, {"blueSaturation", -90}, {"greenLuminance", 70}}},
      {"color_grading",
       {{"shadowHue", 220},
        {"shadowSaturation", 80},
        {"highlightHue", 40},
        {"highlightSaturation", 60}}},
      {"texture", {{"value", 90}}},
      {"clarity", {{"value", 90}}},
      {"dehaze", {{"value", 80}}},
      {"vignette", {{"amount", -80}}},
      {"grain", {{"amount", 80}}},
      {"sharpening", {{"amount", 120}, {"masking", 20}}},
      {"noise_reduction", {{"luminance", 90}}},
      {"color_noise_reduction", {{"amount", 90}}},
      {"manual_denoise", {{"luminance", 80}, {"color", 90}}},
      {"chromatic_aberration", {{"enabled", true}}},
      {"lens_correction", {{"distortion", 60}, {"vignetting", 60}}},
      {"defringe", {{"purpleAmount", 100}, {"greenAmount", 100}}},
      {"crop", {{"left", 0.2}, {"top", 0.1}, {"right", 0.7}, {"bottom", 0.8}, {"angle", 4}}},
      {"rotate", {{"value", 90}}},
      {"flip", {{"horizontal", true}}},
      {"transform", {{"vertical", 40}, {"scale", 120}, {"offsetX", 20}}},
  };
  return values;
}

// The ops that render nothing from their params alone: a generative op needs the raster a
// backend painted, a relight op needs the photo's depth map. Both have their own render
// test, where that input exists.
bool needs_cached_input(const OpDefinition& definition) {
  return is_generative_op(definition.name) || definition.stage == PipelineStage::Relight;
}

Op make_op(const std::string& name, const nlohmann::json& params) {
  std::vector<std::string> warnings;
  Op op;
  op.id = make_op_id();
  op.name = name;
  op.params = normalize_params_for(name, params, warnings);
  REQUIRE(warnings.empty());
  return op;
}

struct Fixture {
  std::unique_ptr<Renderer> renderer;
  std::vector<uint8_t> frame;

  uint64_t render(const Stack& stack) {
    renderer->render(1, stack, frame, 0);
    return hash_of(frame);
  }
};

}  // namespace

TEST_CASE("every op is a no-op at its defaults and changes the frame when it is not") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, synthetic_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  const uint64_t empty = fixture.render(Stack{});
  for (const OpDefinition& definition : op_definitions()) {
    INFO("op " << definition.name);
    const Stack defaults = {make_op(definition.name, nlohmann::json::object())};
    REQUIRE(fixture.render(defaults) == empty);

    // A generative op is a cached raster, not a formula: no value of `prompt` or `seed`
    // changes a pixel, only a generative.run that produced a result does. Its composite is
    // asserted in tests/generative_render_test.cpp instead. `relight` is the same shape —
    // it needs the photo's depth map before it renders anything — and is asserted in
    // tests/relight_render_test.cpp.
    if (needs_cached_input(definition)) continue;
    const auto strong = strong_values().find(definition.name);
    REQUIRE(strong != strong_values().end());
    const Stack edited = {make_op(definition.name, strong->second)};
    REQUIRE(fixture.render(edited) != empty);
  }

  // The whole set at once still renders, and is not accidentally the neutral frame.
  Stack everything;
  for (const OpDefinition& definition : op_definitions()) {
    if (needs_cached_input(definition)) continue;
    everything.push_back(make_op(definition.name, strong_values().at(definition.name)));
  }
  REQUIRE(fixture.render(everything) != empty);
}

TEST_CASE("the render order is the pipeline's, not the stack's") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, synthetic_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  // Sharpening is stage Sharpening and exposure is stage Tone, so the frame is the same
  // whichever way round the user stacked them.
  const Op exposure = make_op("exposure", {{"value", 1.0}});
  const Op sharpening = make_op("sharpening", {{"amount", 120}});
  const uint64_t tone_first = fixture.render(Stack{exposure, sharpening});
  const uint64_t sharpen_first = fixture.render(Stack{sharpening, exposure});
  REQUIRE(tone_first == sharpen_first);
}

TEST_CASE("crop changes the image rect inside the view") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, synthetic_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  fixture.render(Stack{});
  const ViewGeometry full = fixture.renderer->view_geometry(1);
  REQUIRE(full.content_width == kWidth);

  // A tall crop out of a landscape frame has to letterbox left and right.
  fixture.render(Stack{make_op("crop", {{"left", 0.3}, {"right", 0.5}})});
  const ViewGeometry cropped = fixture.renderer->view_geometry(1);
  REQUIRE(cropped.content_width < full.content_width);
  REQUIRE(cropped.content_x > 0);
  REQUIRE(cropped.height == kHeight);

  // And rotating by 90 degrees swaps the aspect the view letterboxes to.
  fixture.render(Stack{make_op("rotate", {{"value", 90}})});
  const ViewGeometry turned = fixture.renderer->view_geometry(1);
  REQUIRE(turned.content_width < turned.content_height);
}

TEST_CASE("the geometry bypass renders the whole image while a crop is on the stack") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, synthetic_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  const uint64_t uncropped = fixture.render(Stack{});
  const ViewGeometry full = fixture.renderer->view_geometry(1);

  const Stack cropped_stack = {make_op(
      "crop", {{"left", 0.3}, {"top", 0.2}, {"right", 0.6}, {"bottom", 0.9}, {"angle", 7}})};
  REQUIRE(fixture.render(cropped_stack) != uncropped);
  REQUIRE(fixture.renderer->view_geometry(1).content_width < full.content_width);

  // The crop tool's frame: same stack, whole image. The rect covers it and the pixels are
  // the ones an empty stack renders, straighten included.
  fixture.renderer->render(1, cropped_stack, fixture.frame, 0, true);
  const ViewGeometry bypassed = fixture.renderer->view_geometry(1);
  REQUIRE(bypassed.content_x == full.content_x);
  REQUIRE(bypassed.content_y == full.content_y);
  REQUIRE(bypassed.content_width == full.content_width);
  REQUIRE(bypassed.content_height == full.content_height);
  REQUIRE(hash_of(fixture.frame) == uncropped);

  // Rotate is not the crop's: it moves the whole image and survives the bypass.
  Stack turned_stack = cropped_stack;
  turned_stack.push_back(make_op("rotate", {{"value", 90}}));
  fixture.renderer->render(1, turned_stack, fixture.frame, 0, true);
  const ViewGeometry turned = fixture.renderer->view_geometry(1);
  REQUIRE(turned.content_width < turned.content_height);

  // And leaving the tool goes back to the cropped frame rather than keeping the bypass.
  REQUIRE(fixture.render(cropped_stack) != uncropped);
  REQUIRE(fixture.renderer->view_geometry(1).content_width < full.content_width);
}

namespace {

// A high-ISO frame, near enough: a dark half and a bright half so there is one hard edge to
// keep, per-pixel luminance grain, and chroma noise in 3x3 blobs — which is the shape the
// thing actually looks like, and the reason a radius-3 filter never touched it.
DecodedRaw noisy_raw() {
  DecodedRaw raw;
  raw.width = kWidth;
  raw.height = kHeight;
  raw.camera = "Synthetic Noise";
  raw.rgba.resize(static_cast<size_t>(kWidth) * kHeight * 4);
  const auto hash = [](uint32_t x, uint32_t y, uint32_t salt) {
    return std::fmod(
        std::abs(std::sin((x * 12.9898) + (y * 78.233) + (salt * 37.719)) * 43758.5453), 1.0);
  };
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (uint32_t x = 0; x < kWidth; ++x) {
      const double level = x < kWidth / 2 ? 0.18 : 0.62;
      const double grain = (hash(x, y, 0) - 0.5) * 0.10;
      // One draw per 3x3 block, per channel: neighbouring pixels share a blob.
      const double red = (hash(x / 3, y / 3, 1) - 0.5) * 0.16;
      const double green = (hash(x / 3, y / 3, 2) - 0.5) * 0.16;
      const double blue = (hash(x / 3, y / 3, 3) - 0.5) * 0.16;
      const size_t index = ((static_cast<size_t>(y) * kWidth) + x) * 4;
      const auto store = [&](size_t channel, double value) {
        raw.rgba[index + channel] = static_cast<uint16_t>(std::clamp(value, 0.0, 1.0) * 65535);
      };
      store(0, level + grain + red);
      store(1, level + grain + green);
      store(2, level + grain + blue);
      raw.rgba[index + 3] = 65535;
    }
  }
  return raw;
}

struct FrameStats {
  double chroma = 0;
  double grain = 0;
  double edge = 0;
};

// Measured on the two flat halves only — a column either side of the edge is skipped, so a
// filter is never credited for softening the edge itself.
FrameStats measure(const std::vector<uint8_t>& frame) {
  const auto at = [&](uint32_t x, uint32_t y, size_t channel) {
    return frame[((((static_cast<size_t>(y) * kWidth) + x) * 4)) + channel] / 255.0;
  };
  FrameStats stats;
  double count = 0;
  double neighbours = 0;
  for (uint32_t y = 2; y + 2 < kHeight; ++y) {
    for (uint32_t x = 2; x + 2 < kWidth; ++x) {
      if (x + 12 > kWidth / 2 && x < (kWidth / 2) + 12) continue;
      const double luma = (0.2126 * at(x, y, 0)) + (0.7152 * at(x, y, 1)) + (0.0722 * at(x, y, 2));
      stats.chroma += std::abs(at(x, y, 0) - luma) + std::abs(at(x, y, 2) - luma);
      // Pixel-to-pixel difference: what is left of the grain after the filter ran.
      const double right =
          (0.2126 * at(x + 1, y, 0)) + (0.7152 * at(x + 1, y, 1)) + (0.0722 * at(x + 1, y, 2));
      stats.grain += std::abs(right - luma);
      count += 1;
      neighbours += 1;
    }
  }
  stats.chroma /= std::max(count, 1.0);
  stats.grain /= std::max(neighbours, 1.0);
  // The step across the middle, averaged down the frame: the detail the filter must keep.
  double dark = 0;
  double bright = 0;
  for (uint32_t y = 0; y < kHeight; ++y) {
    dark += at((kWidth / 2) - 20, y, 1);
    bright += at((kWidth / 2) + 20, y, 1);
  }
  stats.edge = (bright - dark) / kHeight;
  return stats;
}

}  // namespace

TEST_CASE("manual denoise takes the noise out and leaves the edge in") {
  Fixture fixture;
  try {
    fixture.renderer = std::make_unique<Renderer>(16384);
  } catch (const std::exception& error) {
    SKIP(std::string("no GPU adapter: ") + error.what());
  }
  fixture.renderer->load_photo(1, noisy_raw());
  fixture.renderer->open_view(1, 1, kWidth, kHeight);
  fixture.frame.resize(static_cast<size_t>(kWidth) * kHeight * 4);

  fixture.render(Stack{});
  const FrameStats before = measure(fixture.frame);

  fixture.render(Stack{make_op("manual_denoise", {{"luminance", 70}, {"color", 90}})});
  const FrameStats after = measure(fixture.frame);
  INFO("chroma " << before.chroma << " -> " << after.chroma << ", grain " << before.grain << " -> "
                 << after.grain << ", edge " << before.edge << " -> " << after.edge);
  REQUIRE(after.chroma < before.chroma * 0.35);
  REQUIRE(after.grain < before.grain * 0.5);
  REQUIRE(after.edge > before.edge * 0.9);

  // The Detail panel's chroma pass is the comparison that matters: it is one gaussian at up
  // to 8 px, so it thins the blobs, and three à trous levels beat it. If this ever stops
  // being true the new op has no reason to exist.
  fixture.render(Stack{make_op("color_noise_reduction", {{"amount", 100}, {"smoothness", 100}})});
  const FrameStats parametric = measure(fixture.frame);
  INFO("parametric chroma " << parametric.chroma);
  REQUIRE(after.chroma < parametric.chroma);

  // Colour and luminance are separate halves: Color alone must not touch the grain.
  fixture.render(Stack{make_op("manual_denoise", {{"color", 90}})});
  const FrameStats chroma_only = measure(fixture.frame);
  REQUIRE(chroma_only.chroma < before.chroma * 0.35);
  REQUIRE(chroma_only.grain > before.grain * 0.8);
}

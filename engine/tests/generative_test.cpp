// Generative ops without a GPU and without ComfyUI (PROMPT.md 3.5): the hash that decides
// staleness, the crop arithmetic, the sidecar round trip, the graphs Latent ships and their
// substitution, and the stub backend the screenshot flow runs on.
//
// The composite pass itself is a render test (tests/render_test.cpp needs a device); what
// is asserted here is everything that decides what it composites.
#include "generative/generative.h"

#include "generative/backend.h"
#include "generative/comfy_cli.h"
#include "generative/image_io.h"
#include "generative/workflow.h"
#include "image/gray.h"
#include "image/png.h"
#include "ops/registry.h"
#include "ops/sidecar.h"

#include <cmath>
#include <cstdlib>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <random>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

using namespace latent;

namespace {

Op make_op(std::string id, std::string name, nlohmann::json params = nlohmann::json::object()) {
  Op op;
  op.id = std::move(id);
  op.name = std::move(name);
  std::vector<std::string> warnings;
  op.params = normalize_params_for(op.name, params, warnings);
  return op;
}

// Parsed rather than brace-built: nlohmann reads a nested initializer list of pairs as an
// array, and an op whose `mask` is an array is not a masked op at all.
nlohmann::json one_component_mask(const std::string& id) {
  return nlohmann::json::parse(R"({"components": [{"id": ")" + id +
                               R"(", "kind": "radial", "mode": "add"}]})");
}

Op make_fill(std::string id, const char* prompt = "a hat") {
  Op op = make_op(std::move(id), "generative_fill", {{"prompt", prompt}});
  op.mask = one_component_mask("m1");
  return op;
}

Rgb8Image solid(uint32_t width, uint32_t height, uint8_t value) {
  Rgb8Image image;
  image.width = width;
  image.height = height;
  image.pixels.assign(static_cast<size_t>(width) * height * 3, value);
  return image;
}

GrayImage half_mask(uint32_t width, uint32_t height) {
  GrayImage mask;
  mask.width = width;
  mask.height = height;
  mask.pixels.assign(static_cast<size_t>(width) * height, 0);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = width / 2; x < width; ++x) {
      mask.pixels[(static_cast<size_t>(y) * width) + x] = 255;
    }
  }
  return mask;
}

// The crop the sky backend is for: a sky gradient with grain in it, a scatter of stars, and
// one bright streak across the middle. The mask is the streak plus a two-pixel margin, which
// is what the `grow` param produces on a real detection.
constexpr uint32_t kStreakTop = 30;
constexpr uint32_t kStreakBottom = 33;
constexpr uint32_t kMaskTop = 28;
constexpr uint32_t kMaskBottom = 35;

uint8_t sky_value(uint32_t y) {
  return static_cast<uint8_t>(24 + (y / 4));
}

Rgb8Image night_crop(uint32_t width, uint32_t height) {
  Rgb8Image image;
  image.width = width;
  image.height = height;
  image.pixels.assign(static_cast<size_t>(width) * height * 3, 0);
  std::mt19937 noise(7);
  std::normal_distribution<double> grain(0.0, 3.0);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const size_t pixel = (static_cast<size_t>(y) * width) + x;
      double value = sky_value(y) + grain(noise);
      if (pixel % 37 == 0) value = 200;                        // a star
      if (y >= kStreakTop && y <= kStreakBottom) value = 230;  // the trail
      const auto stored = static_cast<uint8_t>(std::lround(std::clamp(value, 0.0, 255.0)));
      for (size_t channel = 0; channel < 3; ++channel) {
        image.pixels[(pixel * 3) + channel] = stored;
      }
    }
  }
  return image;
}

GrayImage streak_mask(uint32_t width, uint32_t height) {
  GrayImage mask;
  mask.width = width;
  mask.height = height;
  mask.pixels.assign(static_cast<size_t>(width) * height, 0);
  // A mask smaller than the band (the mismatched-size case) is left empty, not overrun.
  for (uint32_t y = kMaskTop; y <= kMaskBottom && y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      mask.pixels[(static_cast<size_t>(y) * width) + x] = 255;
    }
  }
  return mask;
}

std::filesystem::path scratch(const char* name) {
  const std::filesystem::path path =
      std::filesystem::temp_directory_path() / (std::string("latent-generative-test-") + name);
  std::error_code error;
  std::filesystem::remove_all(path, error);
  std::filesystem::create_directories(path, error);
  return path;
}

}  // namespace

TEST_CASE("the registry knows the two generative ops", "[generative]") {
  for (const char* name : {"generative_fill", "remove"}) {
    const OpDefinition* definition = find_op_definition(name);
    REQUIRE(definition != nullptr);
    CHECK(definition->section == "Generative");
    CHECK(definition->stage == PipelineStage::Generative);
    // The mask is the region to repaint, so both must take one.
    CHECK(definition->maskable());
    CHECK(is_generative_op(name));
  }
  CHECK_FALSE(is_generative_op("exposure"));
  // The composite runs before the tone and colour passes, so the develop settings apply to
  // the generated pixels too.
  CHECK(PipelineStage::Generative < PipelineStage::Tone);
  CHECK(PipelineStage::NoiseReduction < PipelineStage::Generative);
}

TEST_CASE("the prompt is a string param, not a number", "[generative]") {
  std::vector<std::string> warnings;
  const nlohmann::json params =
      normalize_params_for("generative_fill", {{"prompt", "a red hat"}, {"seed", 7}}, warnings);
  CHECK(params["prompt"] == "a red hat");
  CHECK(params["seed"] == 7);
  CHECK(warnings.empty());
  CHECK_THROWS_AS(normalize_params_for("generative_fill", {{"prompt", 3}}, warnings), OpError);

  const nlohmann::json described = describe_ops();
  bool found = false;
  for (const nlohmann::json& op : described["ops"]) {
    if (op["name"] != "generative_fill") continue;
    found = true;
    for (const nlohmann::json& spec : op["params"]) {
      if (spec["name"] == "prompt") CHECK(spec["type"] == "string");
    }
  }
  CHECK(found);
}

TEST_CASE("the input stack is what the composite mixes into", "[generative]") {
  Stack stack = {make_op("a", "crop", {{"left", 0.1}}), make_op("b", "noise_reduction"),
                 make_fill("g"), make_op("c", "exposure", {{"value", 1.0}})};

  const Stack input = generative_input_stack(stack, "g");
  std::vector<std::string> ids;
  for (const Op& op : input) {
    ids.push_back(op.id);
  }
  // Geometry and noise reduction render below the composite; exposure renders above it, so
  // it is not part of the crop the model was handed whatever the stack order says.
  CHECK(ids == std::vector<std::string>{"a", "b"});

  // A geometry op is framing, not an edit below: it belongs to the input wherever it sits.
  Stack moved = {make_fill("g"), make_op("a", "crop", {{"left", 0.1}})};
  CHECK(generative_input_stack(moved, "g").size() == 1);
}

// "Below" means below the composite, not below in the stack: the renderer runs every op
// under PipelineStage::Generative before the composite whatever order the user put them in,
// so those are the pixels the model was handed and those are what can go stale. An op that
// renders *above* the composite — every tone, colour and effects op — applies to the
// generated pixels as well as to their surroundings and never invalidates them.
TEST_CASE("staleness follows the ops below the composite", "[generative]") {
  Stack stack = {make_op("below", "noise_reduction", {{"luminance", 10}}), make_fill("g"),
                 make_op("above", "exposure", {{"value", 1.0}})};
  Op* fill = find_op(stack, "g");
  REQUIRE(fill != nullptr);
  fill->result = generative_result_relative_path("g");
  fill->input_hash = generative_input_hash(stack, "g");
  fill->result_rect = {0.2, 0.2, 0.6, 0.6};
  CHECK_FALSE(generative_is_stale(stack, *fill));

  SECTION("editing an op below marks it stale") {
    find_op(stack, "below")->params["luminance"] = 40;
    CHECK(generative_is_stale(stack, *find_op(stack, "g")));
  }
  SECTION("editing an op that renders above the composite does not") {
    find_op(stack, "above")->params["value"] = 2.0;
    CHECK_FALSE(generative_is_stale(stack, *find_op(stack, "g")));
  }
  SECTION("a tone op below it in the stack still renders above and still does not") {
    Op exposure = make_op("under", "exposure", {{"value", 0.5}});
    stack.insert(stack.begin(), exposure);
    Op* fill_again = find_op(stack, "g");
    CHECK_FALSE(generative_is_stale(stack, *fill_again));
    find_op(stack, "under")->params["value"] = 3.0;
    CHECK_FALSE(generative_is_stale(stack, *fill_again));
  }
  SECTION("a noise-reduction op counts wherever it sits, because it renders below") {
    const Op below = *find_op(stack, "below");
    stack.erase(stack.begin());
    stack.push_back(below);
    Op* moved_fill = find_op(stack, "g");
    // Moving it did not change which pixels the model saw, so nothing went stale …
    CHECK_FALSE(generative_is_stale(stack, *moved_fill));
    // … and editing it still does.
    find_op(stack, "below")->params["luminance"] = 80;
    CHECK(generative_is_stale(stack, *moved_fill));
  }
  SECTION("the prompt is part of the hash") {
    find_op(stack, "g")->params["prompt"] = "a different hat";
    CHECK(generative_is_stale(stack, *find_op(stack, "g")));
  }
  SECTION("the mask is part of the hash") {
    find_op(stack, "g")->mask = one_component_mask("m2");
    CHECK(generative_is_stale(stack, *find_op(stack, "g")));
  }
  SECTION("an op with no result is never stale") {
    Op fresh = make_fill("h");
    CHECK_FALSE(generative_is_stale(stack, fresh));
  }
}

TEST_CASE("stale is annotated on the way out and never stored", "[generative]") {
  Stack stack = {make_op("below", "noise_reduction", {{"luminance", 10}}), make_fill("g")};
  Op* fill = find_op(stack, "g");
  fill->result = generative_result_relative_path("g");
  fill->input_hash = generative_input_hash(stack, "g");
  fill->result_rect = {0, 0, 1, 1};

  nlohmann::json wire = stack_to_json(stack);
  annotate_generative_stale(wire, stack);
  CHECK(wire[1]["stale"] == false);
  CHECK_FALSE(wire[0].contains("stale"));

  find_op(stack, "below")->params["luminance"] = 90;
  wire = stack_to_json(stack);
  annotate_generative_stale(wire, stack);
  CHECK(wire[1]["stale"] == true);
  // The sidecar codec never sees the derived field.
  CHECK_FALSE(op_to_json(*find_op(stack, "g")).contains("stale"));
}

TEST_CASE("result, inputHash and resultRect survive the sidecar", "[generative]") {
  Stack stack = {make_fill("g")};
  Op* fill = find_op(stack, "g");
  fill->result = "generative/g.png";
  fill->input_hash = std::string(64, 'a');
  fill->result_rect = {0.25, 0.5, 0.75, 1.0};

  Sidecar sidecar;
  sidecar.source_path = "/tmp/photo.arw";
  sidecar.stack = stack;
  const Sidecar back = sidecar_from_json(sidecar_to_json(sidecar));
  REQUIRE(back.stack.size() == 1);
  CHECK(back.stack[0].result == "generative/g.png");
  CHECK(back.stack[0].input_hash == std::string(64, 'a'));
  CHECK(back.stack[0].result_rect == std::vector<double>{0.25, 0.5, 0.75, 1.0});

  // A result rect that is not four numbers is a malformed op, not a silently empty one.
  nlohmann::json broken = op_to_json(*fill);
  broken["resultRect"] = nlohmann::json::array({0, 1});
  CHECK_THROWS_AS(op_from_json(broken), OpError);
}

TEST_CASE("the mask bounding box grows by its padding and snaps to eight pixels", "[generative]") {
  // A 100x100 content rect inside a 120x100 frame, with the mask in one quarter of it.
  MaskWindow window;
  window.stride = 120;
  window.content_x = 10;
  window.content_y = 0;
  window.content_width = 100;
  window.content_height = 100;
  std::vector<uint8_t> coverage(120 * 100, 0);
  for (uint32_t y = 40; y < 60; ++y) {
    for (uint32_t x = 40; x < 60; ++x) {
      coverage[(y * 120) + window.content_x + x] = 255;
    }
  }

  const std::optional<GenerativeRect> tight = mask_bounds(coverage, window, 0.0);
  REQUIRE(tight.has_value());
  CHECK(tight->x0 == Catch::Approx(0.4));
  CHECK(tight->x1 == Catch::Approx(0.6));

  const std::optional<GenerativeRect> padded = mask_bounds(coverage, window, 0.1);
  REQUIRE(padded.has_value());
  CHECK(padded->x0 == Catch::Approx(0.3));
  CHECK(padded->y1 == Catch::Approx(0.7));

  const CropBox box = crop_box(*padded, 100, 100);
  CHECK(box.width % 8 == 0);
  CHECK(box.height % 8 == 0);
  CHECK(box.x + box.width <= 100);
  const GenerativeRect back = rect_of(box, 100, 100);
  CHECK(back.x1 > back.x0);
  CHECK(back.x1 <= 1.0);

  // An empty mask has no box, which is what makes generative.run refuse instead of
  // repainting the whole frame.
  CHECK_FALSE(mask_bounds(std::vector<uint8_t>(120 * 100, 0), window, 0.1).has_value());
}

TEST_CASE("a small mask asks for a bigger render", "[generative]") {
  const GenerativeRect small{0.45, 0.45, 0.55, 0.55};
  // A tenth of the frame at 1024 is a 102 px crop; to land near 1536 the view has to grow.
  CHECK(view_size_for_crop(small, 1024, 1536) > 4000);
  const GenerativeRect whole{0.0, 0.0, 1.0, 1.0};
  // A mask over everything wants the whole frame at the target size.
  CHECK(view_size_for_crop(whole, 1024, 1536) == 1536);
  // Never below the probe, so a crop that is already big enough is rendered once.
  CHECK(view_size_for_crop(whole, 2048, 1536) == 2048);
  // And never beyond a size a proxy render can hold.
  CHECK(view_size_for_crop({0.49, 0.49, 0.5, 0.5}, 1024, 1536) == 4096);
}

TEST_CASE("the shipped graphs substitute by node id", "[generative]") {
  const std::vector<Workflow> workflows = load_workflows();
  REQUIRE_FALSE(workflows.empty());

  const Workflow* fill = nullptr;
  const Workflow* remove = nullptr;
  for (const Workflow& workflow : workflows) {
    if (workflow.name == "inpaint-sdxl") fill = &workflow;
    if (workflow.name == "remove") remove = &workflow;
  }
  REQUIRE(fill != nullptr);
  REQUIRE(remove != nullptr);
  CHECK(fill->task == "fill");
  CHECK(remove->task == "remove");

  WorkflowValues values;
  values.image = "latent-1-crop.png";
  values.mask = "latent-1-mask.png";
  values.prompt = "a red hat";
  values.seed = 4242;
  values.model = "SomeOther.safetensors";
  const nlohmann::json filled = fill_workflow(*fill, values);

  const auto widget = [&filled](const std::string& binding) {
    const size_t dot = binding.find('.');
    return filled.at(binding.substr(0, dot))["inputs"].at(binding.substr(dot + 1));
  };
  CHECK(widget(fill->bindings.image) == "latent-1-crop.png");
  CHECK(widget(fill->bindings.mask) == "latent-1-mask.png");
  CHECK(widget(fill->bindings.prompt) == "a red hat");
  CHECK(widget(fill->bindings.seed) == 4242);
  CHECK(widget(fill->bindings.model) == "SomeOther.safetensors");
  // The SaveImage the result is read back from has to be in the graph.
  CHECK(filled.contains(fill->bindings.output));
  // The template is copied, never edited: the Workflow still holds what is on disk.
  const size_t dot = fill->bindings.image.find('.');
  CHECK(fill->graph.at(fill->bindings.image.substr(0, dot))["inputs"].at(
            fill->bindings.image.substr(dot + 1)) != "latent-1-crop.png");

  // `remove` has no prompt binding, so a prompt is dropped rather than written somewhere.
  CHECK(remove->bindings.prompt.empty());
  CHECK_NOTHROW(fill_workflow(*remove, values));
}

TEST_CASE("every shipped graph names nodes it actually has", "[generative]") {
  for (const Workflow& workflow : load_workflows()) {
    WorkflowValues values;
    values.image = "crop.png";
    values.mask = "mask.png";
    values.prompt = "x";
    values.seed = 1;
    values.model = "model.safetensors";
    INFO("workflow " << workflow.name);
    CHECK_NOTHROW(fill_workflow(workflow, values));
    CHECK_FALSE(workflow.required_models.empty());
    CHECK_FALSE(workflow.bindings.output.empty());
    CHECK(workflow.graph.contains(workflow.bindings.output));
  }
}

TEST_CASE("a graph whose node ids drifted is a packaging error", "[generative]") {
  Workflow workflow;
  workflow.name = "broken";
  workflow.graph = {{"1", {{"class_type", "LoadImage"}, {"inputs", {{"image", "a.png"}}}}}};
  workflow.bindings.image = "99.image";
  WorkflowValues values;
  values.image = "crop.png";
  CHECK_THROWS_AS(fill_workflow(workflow, values), OpError);

  workflow.bindings.image = "1.nosuchwidget";
  CHECK_THROWS_AS(fill_workflow(workflow, values), OpError);
}

TEST_CASE("the stub backend repaints only what the mask covers", "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_stub_backend();
  REQUIRE(backend->name() == "stub");

  GenerativeRequest request;
  request.task = "fill";
  request.seed = 11;
  request.image = encode_rgb_png(solid(64, 32, 200));
  request.mask = encode_gray_png(half_mask(64, 32));

  const GenerativeResult result = backend->run(request, {});
  REQUIRE(result.ok);
  const std::optional<Rgb8Image> out = decode_rgb_png(result.png);
  REQUIRE(out.has_value());
  CHECK(out->width == 64);
  CHECK(out->height == 32);

  // Unmasked pixels come back byte for byte; masked ones do not.
  bool changed = false;
  for (uint32_t y = 0; y < 32; ++y) {
    for (uint32_t x = 0; x < 64; ++x) {
      const size_t at = ((static_cast<size_t>(y) * 64) + x) * 3;
      if (x < 32) {
        REQUIRE(out->pixels[at] == 200);
      } else if (out->pixels[at] != 200) {
        changed = true;
      }
    }
  }
  CHECK(changed);
}

TEST_CASE("the stub backend is deterministic per seed and differs across seeds", "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_stub_backend();
  GenerativeRequest request;
  request.image = encode_rgb_png(solid(32, 32, 120));
  request.mask = encode_gray_png(half_mask(32, 32));
  request.seed = 1;
  const std::vector<uint8_t> first = backend->run(request, {}).png;
  const std::vector<uint8_t> again = backend->run(request, {}).png;
  request.seed = 180;
  const std::vector<uint8_t> other = backend->run(request, {}).png;
  CHECK(first == again);
  CHECK(first != other);
}

TEST_CASE("the sky backend puts sky where the streak was", "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_sky_backend();
  REQUIRE(backend->name() == "sky");

  const uint32_t width = 96;
  const uint32_t height = 64;
  GenerativeRequest request;
  request.task = "remove";
  request.seed = 3;
  const Rgb8Image crop = night_crop(width, height);
  request.image = encode_rgb_png(crop);
  request.mask = encode_gray_png(streak_mask(width, height));

  const GenerativeResult result = backend->run(request, {});
  REQUIRE(result.ok);
  CHECK(result.model == "sky-fill");
  const std::optional<Rgb8Image> out = decode_rgb_png(result.png);
  REQUIRE(out.has_value());

  // Outside the mask nothing moved, stars included.
  for (uint32_t y = 0; y < height; ++y) {
    if (y >= kMaskTop && y <= kMaskBottom) continue;
    for (uint32_t x = 0; x < width; ++x) {
      const size_t at = ((static_cast<size_t>(y) * width) + x) * 3;
      REQUIRE(out->pixels[at] == crop.pixels[at]);
    }
  }

  // Inside it: the streak is gone, and what replaced it is the sky the rows either side
  // have — not a smear of the stars the interpolation had to reach over.
  double total = 0;
  double squares = 0;
  double count = 0;
  uint8_t brightest = 0;
  for (uint32_t y = kMaskTop; y <= kMaskBottom; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const double value = out->pixels[(((static_cast<size_t>(y) * width) + x)) * 3];
      total += value;
      squares += value * value;
      count += 1;
      brightest = std::max(brightest, out->pixels[(((static_cast<size_t>(y) * width) + x)) * 3]);
    }
  }
  const double mean = total / count;
  CHECK(mean == Catch::Approx(sky_value((kStreakTop + kStreakBottom) / 2)).margin(5));
  CHECK(brightest < 120);
  // Grain, at something like the frame's own amplitude: a perfectly flat patch is as
  // visible as the trail was.
  const double deviation = std::sqrt(std::max(0.0, (squares / count) - (mean * mean)));
  CHECK(deviation > 1.0);
  CHECK(deviation < 8.0);
}

TEST_CASE("the sky backend repeats itself and owns up to a mask with no sky in it",
          "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_sky_backend();
  GenerativeRequest request;
  request.image = encode_rgb_png(night_crop(48, 48));
  request.mask = encode_gray_png(streak_mask(48, 48));
  request.seed = 5;
  // A cached result is keyed on an input hash, so two runs that differ only in grain would
  // read as the op having changed.
  CHECK(backend->run(request, {}).png == backend->run(request, {}).png);

  GrayImage everything;
  everything.width = 48;
  everything.height = 48;
  everything.pixels.assign(48 * 48, 255);
  request.mask = encode_gray_png(everything);
  const GenerativeResult covered = backend->run(request, {});
  CHECK_FALSE(covered.ok);
  CHECK(covered.code == "no_sky");

  request.mask = encode_gray_png(streak_mask(16, 16));
  const GenerativeResult mismatched = backend->run(request, {});
  CHECK_FALSE(mismatched.ok);
  CHECK(mismatched.code == "bad_input");
}

TEST_CASE("a backend run stops when the progress callback says so", "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_stub_backend();
  GenerativeRequest request;
  request.image = encode_rgb_png(solid(16, 16, 10));
  request.mask = encode_gray_png(half_mask(16, 16));
  const GenerativeResult result =
      backend->run(request, [](double, const std::string&) { return false; });
  CHECK_FALSE(result.ok);
  CHECK(result.code == "cancelled");
}

TEST_CASE("LATENT_GENERATIVE_STUB picks the stub and the param overrides it", "[generative]") {
  CHECK(make_generative_backend("stub", "fill")->name() == "stub");
  CHECK(make_generative_backend("sky", "fill")->name() == "sky");
  CHECK(make_generative_backend("comfy", "fill")->name() == "comfy");
  setenv("LATENT_GENERATIVE_STUB", "1", 1);
  CHECK(make_generative_backend("auto", "fill")->name() == "stub");
  CHECK(make_generative_backend("auto", "denoise")->name() == "stub");
  unsetenv("LATENT_GENERATIVE_STUB");
  CHECK(make_generative_backend("auto", "fill")->name() == "comfy");
}

TEST_CASE("auto sends a denoise to the local model when it is installed", "[generative]") {
  const std::filesystem::path root =
      std::filesystem::temp_directory_path() / "latent-denoise-store-test";
  std::filesystem::remove_all(root);
  std::filesystem::create_directories(root);
  const char* previous = std::getenv("LATENT_MODEL_STORE");
  const std::string restore = previous == nullptr ? std::string() : previous;
  setenv("LATENT_MODEL_STORE", root.string().c_str(), 1);

  // An empty store: there is no local model, so auto is still the graph.
  CHECK(resolve_generative_backend("auto", "denoise") == "comfy");

  std::filesystem::create_directories(root / "scunet-color-real");
  std::ofstream(root / "scunet-color-real" / "config.json") << "{\"tile\": 512}";
  CHECK(resolve_generative_backend("auto", "denoise") == "onnx");
  // Only a denoise: nothing else here is a restoration problem, and the model answers no
  // other task.
  CHECK(resolve_generative_backend("auto", "fill") == "comfy");
  CHECK(resolve_generative_backend("auto", "upscale") == "comfy");
  // An explicit choice is still the user's.
  CHECK(resolve_generative_backend("comfy", "denoise") == "comfy");
  CHECK(make_generative_backend("onnx", "denoise")->name() == "onnx");

  // The local backend refuses the tasks it cannot do rather than returning something.
  GenerativeRequest request;
  request.task = "upscale";
  const GenerativeResult refused =
      make_onnx_denoise_backend()->run(request, [](double, const std::string&) { return true; });
  CHECK_FALSE(refused.ok);
  CHECK(refused.code == "no_workflow");

  if (restore.empty()) {
    unsetenv("LATENT_MODEL_STORE");
  } else {
    setenv("LATENT_MODEL_STORE", restore.c_str(), 1);
  }
  std::filesystem::remove_all(root);
}

TEST_CASE("a ComfyUI that is not running is named as such", "[generative]") {
  // `comfy upload` reports an unreachable server against the file it was sending, which
  // reads like a broken file rather than a daemon nobody started.
  CHECK(comfy_hint_for("upload_failed", "Failed to upload latent-2-crop.png, connection refused")
            .find("comfy launch") != std::string::npos);
  CHECK(comfy_hint_for("server_not_running", "").find("comfy launch") != std::string::npos);
  CHECK(comfy_hint_for("execution_error", "the sampler ran out of memory").empty());
}

TEST_CASE("colour PNGs round-trip through the generative codec", "[generative]") {
  const Rgb8Image image = solid(9, 5, 77);
  const std::optional<Rgb8Image> back = decode_rgb_png(encode_rgb_png(image));
  REQUIRE(back.has_value());
  CHECK(back->width == 9);
  CHECK(back->pixels == image.pixels);
  CHECK_FALSE(decode_rgb_png(std::vector<uint8_t>{1, 2, 3, 4}).has_value());

  const std::filesystem::path directory = scratch("png");
  const std::string path = (directory / "sub" / "result.png").string();
  write_rgb_png(path, image);
  const std::optional<Rgb8Image> read = read_rgb_png(path);
  REQUIRE(read.has_value());
  CHECK(read->pixels == image.pixels);
  CHECK_FALSE(read_rgb_png((directory / "missing.png").string()).has_value());
  std::error_code error;
  std::filesystem::remove_all(directory, error);
}

TEST_CASE("status says what is missing instead of failing a run silently", "[generative]") {
  const nlohmann::json status = generative_status();
  REQUIRE(status.contains("backend"));
  REQUIRE(status.contains("comfy"));
  REQUIRE(status["workflows"].is_array());
  CHECK_FALSE(status["workflows"].empty());
  for (const nlohmann::json& workflow : status["workflows"]) {
    CHECK(workflow.contains("name"));
    CHECK(workflow.contains("ready"));
  }
  // Not ready is a state with a reason, never an empty answer.
  if (!status["ready"].get<bool>()) CHECK(status.contains("message"));
}

// ---- the whole-frame ops (issues #51, #52) ---------------------------------------------
//
// `denoise` and `upscale` are the same cached-raster machine as the two above with three
// differences: no mask, the whole frame, and a position under everything a slider can do.
// `upscale` adds a fourth — it is the one op in the engine that changes how many pixels the
// photo has, which only the export renders at.

TEST_CASE("the registry knows the two whole-frame ops", "[generative]") {
  for (const char* name : {"denoise", "upscale"}) {
    const OpDefinition* definition = find_op_definition(name);
    REQUIRE(definition != nullptr);
    CHECK(definition->section == "Enhance");
    CHECK(is_generative_op(name));
    CHECK(is_whole_frame_op(name));
    // There is no region to choose: the raster covers the frame, so a mask would be a
    // second, contradictory answer to the same question.
    CHECK_FALSE(definition->maskable());
  }
  CHECK_FALSE(is_whole_frame_op("generative_fill"));
  CHECK_FALSE(is_whole_frame_op("noise_reduction"));

  // Denoise first, always: an upscaler turns leftover noise into detail that was never
  // there. Both sit under the parametric noise reduction, which is the cheap cleanup on top
  // of what the model left rather than a second opinion about the same pixels.
  CHECK(PipelineStage::Optics < find_op_definition("denoise")->stage);
  CHECK(find_op_definition("denoise")->stage < find_op_definition("upscale")->stage);
  CHECK(find_op_definition("upscale")->stage < PipelineStage::NoiseReduction);
}

TEST_CASE("each generative op names the graph it runs", "[generative]") {
  CHECK(generative_task("generative_fill") == "fill");
  CHECK(generative_task("remove") == "remove");
  CHECK(generative_task("denoise") == "denoise");
  CHECK(generative_task("upscale") == "upscale");
  CHECK(generative_task("exposure").empty());
}

TEST_CASE("a whole-frame op's input is everything that renders under it", "[generative]") {
  Stack stack = {make_op("crop", "crop", {{"left", 0.1}}), make_op("d", "denoise"),
                 make_op("u", "upscale"), make_op("e", "exposure", {{"value", 1.0}})};

  const auto ids = [](const Stack& input) {
    std::vector<std::string> out;
    for (const Op& op : input) {
      out.push_back(op.id);
    }
    return out;
  };
  // Geometry is framing and comes wherever it sits; the upscale renders above the denoise,
  // so it is not part of what the denoise model is handed.
  CHECK(ids(generative_input_stack(stack, "d")) == std::vector<std::string>{"crop"});
  // The upscale is handed the denoised frame, which is the whole point of the ordering.
  CHECK(ids(generative_input_stack(stack, "u")) == std::vector<std::string>{"crop", "d"});
  // And a fill above both sees them both, whatever the stack order is.
  stack.push_back(make_fill("g"));
  CHECK(ids(generative_input_stack(stack, "g")) == std::vector<std::string>{"crop", "d", "u"});
}

TEST_CASE("only an upscale with a raster changes the export's size", "[generative]") {
  Stack stack = {make_op("u", "upscale", {{"factor", "4x"}})};
  CHECK(upscale_factor(stack[0]) == 4.0);
  // Asked for but never run: the op renders nothing, so the export is native size.
  CHECK(stack_upscale_factor(stack) == 1.0);

  stack[0].result = generative_result_relative_path("u");
  CHECK(stack_upscale_factor(stack) == 4.0);

  stack[0].enabled = false;
  CHECK(stack_upscale_factor(stack) == 1.0);
  stack[0].enabled = true;

  // Two of them compound, because each one really did make the raster below it bigger.
  Op second = make_op("u2", "upscale", {{"factor", "2x"}});
  second.result = generative_result_relative_path("u2");
  stack.push_back(second);
  CHECK(stack_upscale_factor(stack) == 8.0);

  // An unparseable factor is the param's first value, which is what normalize_params does
  // with anything outside the enum.
  CHECK(upscale_factor(make_op("u3", "upscale")) == 2.0);
}

TEST_CASE("the stub backend answers the whole-frame tasks without a mask", "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_stub_backend();
  GenerativeRequest request;
  request.task = "denoise";
  request.image = encode_rgb_png(solid(64, 32, 200));
  request.strength = 0.3;

  const GenerativeResult denoised = backend->run(request, {});
  REQUIRE(denoised.ok);
  const std::optional<Rgb8Image> denoised_image = decode_rgb_png(denoised.png);
  REQUIRE(denoised_image.has_value());
  // A denoise hands back the same frame, at the same size: the composite puts it back over
  // the whole content rect.
  CHECK(denoised_image->width == 64);
  CHECK(denoised_image->height == 32);

  request.task = "upscale";
  request.scale = 4;
  const GenerativeResult enlarged = backend->run(request, {});
  REQUIRE(enlarged.ok);
  const std::optional<Rgb8Image> enlarged_image = decode_rgb_png(enlarged.png);
  REQUIRE(enlarged_image.has_value());
  CHECK(enlarged_image->width == 256);
  CHECK(enlarged_image->height == 128);

  request.scale = 2;
  const std::optional<Rgb8Image> half = decode_rgb_png(backend->run(request, {}).png);
  REQUIRE(half.has_value());
  CHECK(half->width == 128);
}

TEST_CASE("the whole-frame graphs take no mask and are the ones for their task", "[generative]") {
  const std::vector<Workflow> workflows = load_workflows();
  for (const char* name : {"denoise", "upscale"}) {
    const auto found = std::find_if(workflows.begin(), workflows.end(),
                                    [name](const Workflow& entry) { return entry.name == name; });
    REQUIRE(found != workflows.end());
    CHECK(found->task == name);
    CHECK(found->bindings.mask.empty());

    WorkflowValues values;
    values.image = "crop.png";
    values.strength = 0.42;
    values.seed = 7;
    const nlohmann::json filled = fill_workflow(*found, values);
    const auto widget = [&filled](const std::string& binding) {
      const size_t dot = binding.find('.');
      return filled.at(binding.substr(0, dot))["inputs"].at(binding.substr(dot + 1));
    };
    CHECK(widget(found->bindings.image) == "crop.png");
    CHECK(filled.contains(found->bindings.output));
  }

  // Strength is the sampler's denoise widget, and only the denoise graph has one: an
  // upscale model has no such knob and must not be handed one.
  const auto denoise = std::find_if(workflows.begin(), workflows.end(),
                                    [](const Workflow& entry) { return entry.name == "denoise"; });
  REQUIRE(denoise != workflows.end());
  REQUIRE_FALSE(denoise->bindings.strength.empty());
  WorkflowValues values;
  values.image = "crop.png";
  values.strength = 0.42;
  const nlohmann::json filled = fill_workflow(*denoise, values);
  const size_t dot = denoise->bindings.strength.find('.');
  CHECK(filled.at(denoise->bindings.strength.substr(0, dot))["inputs"].at(
            denoise->bindings.strength.substr(dot + 1)) == 0.42);
}

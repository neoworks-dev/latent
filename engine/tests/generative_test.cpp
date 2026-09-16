// Generative ops without a GPU and without ComfyUI (PROMPT.md 3.5): the hash that decides
// staleness, the crop arithmetic, the sidecar round trip, the graphs Latent ships and their
// substitution, and the stub backend the screenshot flow runs on.
//
// The composite pass itself is a render test (tests/render_test.cpp needs a device); what
// is asserted here is everything that decides what it composites.
#include "generative/generative.h"

#include "generative/backend.h"
#include "generative/image_io.h"
#include "generative/workflow.h"
#include "image/gray.h"
#include "image/png.h"
#include "ops/registry.h"
#include "ops/sidecar.h"

#include <cstdlib>

#include <filesystem>

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

  const GenerativeResult result = backend->inpaint(request, {});
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
  const std::vector<uint8_t> first = backend->inpaint(request, {}).png;
  const std::vector<uint8_t> again = backend->inpaint(request, {}).png;
  request.seed = 180;
  const std::vector<uint8_t> other = backend->inpaint(request, {}).png;
  CHECK(first == again);
  CHECK(first != other);
}

TEST_CASE("a backend run stops when the progress callback says so", "[generative]") {
  const std::unique_ptr<GenerativeBackend> backend = make_stub_backend();
  GenerativeRequest request;
  request.image = encode_rgb_png(solid(16, 16, 10));
  request.mask = encode_gray_png(half_mask(16, 16));
  const GenerativeResult result =
      backend->inpaint(request, [](double, const std::string&) { return false; });
  CHECK_FALSE(result.ok);
  CHECK(result.code == "cancelled");
}

TEST_CASE("LATENT_GENERATIVE_STUB picks the stub and the param overrides it", "[generative]") {
  CHECK(make_generative_backend("stub")->name() == "stub");
  CHECK(make_generative_backend("comfy")->name() == "comfy");
  setenv("LATENT_GENERATIVE_STUB", "1", 1);
  CHECK(make_generative_backend("auto")->name() == "stub");
  unsetenv("LATENT_GENERATIVE_STUB");
  CHECK(make_generative_backend("auto")->name() == "comfy");
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

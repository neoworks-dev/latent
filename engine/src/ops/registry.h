// Op definitions: names, panels, ranges, defaults. Mirrors Lightroom's Edit panels
// (reference/lightroom/light.md, color.md) and feeds ops.describe, which the UI turns
// into generated panels.
#pragma once

#include "ops/op.h"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// Curve params carry an array of control points, `[{"x": 0, "y": 0}, …]`, both axes 0..1,
// ascending in x. An empty array is the identity curve. See ops/curve.h.
// String carries free text a generated panel cannot hold — a generative prompt, a model
// name the engine only learns from the backend at runtime. `ops.describe` reports it as
// `"string"` and the hand-built Generative panel draws it.
enum class ParamType { Number, Integer, Boolean, Enum, Curve, String };

struct OpParamSpec {
  std::string name;
  std::string label;
  ParamType type = ParamType::Number;
  std::optional<double> min;
  std::optional<double> max;
  std::optional<double> step;
  std::string unit;
  nlohmann::json default_value;
  std::vector<std::string> values;
  // ops.describe `display` (protocol OpParamDisplay): which control a generated panel
  // draws and which gradient goes under its track. Empty kind = no hint, plain slider.
  std::string display_kind;
  std::string display_tint;
};

// Where an op sits in the render pipeline, regardless of where it sits in the stack.
// Lightroom's order, and the order engine/src/pipeline/renderer.cpp renders passes in:
// geometry, then optics, then noise reduction, then tone, colour, effects, and finally
// sharpening and grain. See the comment above build_definitions().
enum class PipelineStage : int {
  Geometry = 10,
  Optics = 20,
  // `denoise` and `upscale` (issues #51, #52): model rasters like the generative ops, but
  // whole-frame and unmasked, and they sit under everything a slider can do — the raster is
  // the new input to the rest of the stack. Denoise is below upscale because an upscaler
  // turns leftover noise into detail that was never there, and both are below the
  // parametric NoiseReduction pass, which is the cheap cleanup on top of whatever the model
  // left rather than a second opinion about the same pixels.
  Denoise = 24,
  Upscale = 26,
  NoiseReduction = 30,
  // Generative results are composited before the tone and colour passes, so the develop
  // settings apply to the generated pixels as well as to everything around them — a patch
  // that kept the exposure it was generated at would show as a rectangle the first time a
  // slider moved. The crop the backend was handed is rendered through exactly the passes
  // below this line (PROMPT.md 3.5, generative_input_stack in src/generative/).
  Generative = 35,
  Tone = 40,
  Color = 50,
  // A group (ops/op.h, kGroupOpName) renders here, as a unit, whatever its children are:
  // the branch runs off the group's input and one blend puts it back through the mask. It
  // sits after the global tone and colour passes because that is where Lightroom applies a
  // local adjustment — the mask is drawn on a picture the user has already developed. The
  // price is that a masked op does not render at its own stage any more: a group holding
  // noise reduction denoises after the tone curve, not before it.
  Local = 55,
  // `relight` (PROMPT.md 3.8) sits between the local adjustments and the effects: it adds
  // light to a developed picture, so the tone and colour passes are already behind it, and
  // vignette, grain and sharpening have to see the light it added rather than the other way
  // round.
  Relight = 58,
  Effects = 60,
  Sharpening = 70,
  Grain = 80,
};

struct OpDefinition {
  std::string name;
  std::string panel;
  // Lightroom's section heading for `panel`, and the order of this op inside it
  // (reference/lightroom/README.md). Empty/0 = the UI falls back to `panel` and to name
  // order.
  std::string section;
  int order = 0;
  std::string label;
  // Engine-internal, never in ops.describe: the stack is the user's order, this is the
  // renderer's.
  PipelineStage stage = PipelineStage::Tone;
  std::vector<OpParamSpec> params;

  // ops.describe `maskable`: every develop op takes a mask and an opacity. Geometry ops
  // move pixels rather than changing them, so there is nothing to blend a mask into —
  // a mask on one is ignored with an engine.log warning. `denoise` and `upscale` are the
  // other exception: they are whole-frame by definition, so there is no region to pick.
  bool maskable() const {
    if (panel == "geometry") return false;
    return stage != PipelineStage::Denoise && stage != PipelineStage::Upscale;
  }
};

const std::vector<OpDefinition>& op_definitions();
const OpDefinition* find_op_definition(std::string_view name);

// Every op whose pixels a model produced rather than a formula: `generative_fill` and
// `remove` (PROMPT.md 3.5), `denoise` and `upscale` (issues #51, #52). All four are cached
// rasters with an input hash, none ever re-runs on its own, and none sits under a group
// (src/generative/generative.h).
bool is_generative_op(std::string_view name);

// The two of those that cover the whole frame: `denoise` and `upscale` take no mask — there
// is no region to choose, the raster replaces the picture the ops below it produced.
bool is_whole_frame_op(std::string_view name);

// ops.describe result payload.
nlohmann::json describe_ops();

// Returns a complete param object: every spec'd param present, unknown keys dropped,
// numbers clamped into range. Clamps and drops append a line to `warnings`; a value of
// the wrong type throws OpError.
nlohmann::json normalize_params(const OpDefinition& definition, const nlohmann::json& params,
                                std::vector<std::string>& warnings);

// normalize_params for an op named at runtime. Throws OpError if the name is unknown.
nlohmann::json normalize_params_for(std::string_view op_name, const nlohmann::json& params,
                                    std::vector<std::string>& warnings);

}  // namespace latent

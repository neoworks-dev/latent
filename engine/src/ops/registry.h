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
enum class ParamType { Number, Integer, Boolean, Enum, Curve };

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
  NoiseReduction = 30,
  Tone = 40,
  Color = 50,
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
};

const std::vector<OpDefinition>& op_definitions();
const OpDefinition* find_op_definition(std::string_view name);

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

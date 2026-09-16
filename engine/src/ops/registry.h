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
};

struct OpDefinition {
  std::string name;
  std::string panel;
  std::string label;
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

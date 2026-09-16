#include "ops/registry.h"

#include <cmath>

#include <algorithm>

namespace latent {

namespace {

OpParamSpec slider(std::string name, std::string label, double minimum, double maximum, double step,
                   std::string unit) {
  OpParamSpec spec;
  spec.name = std::move(name);
  spec.label = std::move(label);
  spec.type = ParamType::Number;
  spec.min = minimum;
  spec.max = maximum;
  spec.step = step;
  spec.unit = std::move(unit);
  spec.default_value = 0.0;
  return spec;
}

// Every Light/Color slider except Exposure is a -100..100 integer-stepped amount.
OpParamSpec amount(std::string label) {
  return slider("value", std::move(label), -100, 100, 1, "");
}

std::vector<OpDefinition> build_definitions() {
  std::vector<OpDefinition> definitions;
  definitions.push_back(
      {"exposure", "light", "Exposure", {slider("value", "Exposure", -5, 5, 0.01, "EV")}});
  definitions.push_back({"contrast", "light", "Contrast", {amount("Contrast")}});
  definitions.push_back({"highlights", "light", "Highlights", {amount("Highlights")}});
  definitions.push_back({"shadows", "light", "Shadows", {amount("Shadows")}});
  definitions.push_back({"whites", "light", "Whites", {amount("Whites")}});
  definitions.push_back({"blacks", "light", "Blacks", {amount("Blacks")}});
  definitions.push_back({"white_balance",
                         "color",
                         "White Balance",
                         {slider("temperature", "Temperature", -100, 100, 1, ""),
                          slider("tint", "Tint", -100, 100, 1, "")}});
  definitions.push_back({"saturation", "color", "Saturation", {amount("Saturation")}});
  definitions.push_back({"vibrance", "color", "Vibrance", {amount("Vibrance")}});
  return definitions;
}

std::string_view type_name(ParamType type) {
  switch (type) {
    case ParamType::Number:
      return "number";
    case ParamType::Integer:
      return "integer";
    case ParamType::Boolean:
      return "boolean";
    case ParamType::Enum:
      return "enum";
    case ParamType::Curve:
      return "curve";
  }
  return "number";
}

std::string format_number(double value) {
  std::string text = nlohmann::json(value).dump();
  return text;
}

nlohmann::json clamp_number(const OpDefinition& definition, const OpParamSpec& spec, double value,
                            std::vector<std::string>& warnings) {
  double clamped = value;
  if (spec.min.has_value()) clamped = std::max(clamped, *spec.min);
  if (spec.max.has_value()) clamped = std::min(clamped, *spec.max);
  if (clamped != value) {
    warnings.push_back(definition.name + "." + spec.name + ": " + format_number(value) +
                       " out of range, clamped to " + format_number(clamped));
  }
  if (spec.type == ParamType::Integer) return static_cast<int64_t>(std::llround(clamped));
  return clamped;
}

nlohmann::json coerce(const OpDefinition& definition, const OpParamSpec& spec,
                      const nlohmann::json& value, std::vector<std::string>& warnings) {
  const std::string where = definition.name + "." + spec.name;
  if (spec.type == ParamType::Boolean) {
    if (!value.is_boolean()) throw OpError(where + " must be a boolean");
    return value;
  }
  if (spec.type == ParamType::Enum) {
    const bool known =
        value.is_string() && std::find(spec.values.begin(), spec.values.end(),
                                       value.get<std::string>()) != spec.values.end();
    if (!known) throw OpError(where + " must be one of the declared enum values");
    return value;
  }
  if (spec.type == ParamType::Curve) {
    if (!value.is_array()) throw OpError(where + " must be an array of control points");
    return value;
  }
  if (!value.is_number()) throw OpError(where + " must be a number");
  return clamp_number(definition, spec, value.get<double>(), warnings);
}

}  // namespace

const std::vector<OpDefinition>& op_definitions() {
  static const std::vector<OpDefinition> definitions = build_definitions();
  return definitions;
}

const OpDefinition* find_op_definition(std::string_view name) {
  for (const OpDefinition& definition : op_definitions()) {
    if (definition.name == name) return &definition;
  }
  return nullptr;
}

nlohmann::json describe_ops() {
  nlohmann::json ops = nlohmann::json::array();
  for (const OpDefinition& definition : op_definitions()) {
    nlohmann::json params = nlohmann::json::array();
    for (const OpParamSpec& spec : definition.params) {
      nlohmann::json param = {{"name", spec.name},
                              {"label", spec.label},
                              {"type", type_name(spec.type)},
                              {"default", spec.default_value}};
      if (spec.min.has_value()) param["min"] = *spec.min;
      if (spec.max.has_value()) param["max"] = *spec.max;
      if (spec.step.has_value()) param["step"] = *spec.step;
      if (!spec.unit.empty()) param["unit"] = spec.unit;
      if (!spec.values.empty()) param["values"] = spec.values;
      params.push_back(param);
    }
    ops.push_back({{"name", definition.name},
                   {"panel", definition.panel},
                   {"label", definition.label},
                   {"params", params}});
  }
  return {{"ops", ops}};
}

nlohmann::json normalize_params(const OpDefinition& definition, const nlohmann::json& params,
                                std::vector<std::string>& warnings) {
  if (!params.is_null() && !params.is_object()) throw OpError("params must be an object");
  nlohmann::json normalized = nlohmann::json::object();
  for (const OpParamSpec& spec : definition.params) {
    const bool given =
        params.is_object() && params.contains(spec.name) && !params[spec.name].is_null();
    if (!given) {
      normalized[spec.name] = spec.default_value;
      continue;
    }
    normalized[spec.name] = coerce(definition, spec, params[spec.name], warnings);
  }
  if (!params.is_object()) return normalized;
  for (auto entry = params.begin(); entry != params.end(); ++entry) {
    if (normalized.contains(entry.key())) continue;
    warnings.push_back(definition.name + ": unknown param '" + entry.key() + "' ignored");
  }
  return normalized;
}

nlohmann::json normalize_params_for(std::string_view op_name, const nlohmann::json& params,
                                    std::vector<std::string>& warnings) {
  const OpDefinition* definition = find_op_definition(op_name);
  if (definition == nullptr) throw OpError("unknown op '" + std::string(op_name) + "'");
  return normalize_params(*definition, params, warnings);
}

}  // namespace latent

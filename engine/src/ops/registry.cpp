#include "ops/registry.h"

#include "ops/curve.h"

#include <cmath>

#include <algorithm>
#include <utility>

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
  spec.display_kind = "slider";
  return spec;
}

// Every Light/Color slider except Exposure is a -100..100 integer-stepped amount.
OpParamSpec amount(std::string label) {
  return slider("value", std::move(label), -100, 100, 1, "");
}

// A bipolar -100..100 slider under its own name, for ops that carry several of them.
OpParamSpec bipolar(std::string name, std::string label) {
  return slider(std::move(name), std::move(label), -100, 100, 1, "");
}

// A 0..100 slider, Lightroom's one-sided sub-slider shape.
OpParamSpec unipolar(std::string name, std::string label, double default_value) {
  OpParamSpec spec = slider(std::move(name), std::move(label), 0, 100, 1, "");
  spec.default_value = default_value;
  return spec;
}

OpParamSpec with_default(OpParamSpec spec, double default_value) {
  spec.default_value = default_value;
  return spec;
}

// A slider whose track carries a gradient, the way Lightroom tints Temp and Tint.
OpParamSpec tinted(OpParamSpec spec, std::string kind, std::string tint) {
  spec.display_kind = std::move(kind);
  spec.display_tint = std::move(tint);
  return spec;
}

OpParamSpec toggle(std::string name, std::string label) {
  OpParamSpec spec;
  spec.name = std::move(name);
  spec.label = std::move(label);
  spec.type = ParamType::Boolean;
  spec.default_value = false;
  spec.display_kind = "toggle";
  return spec;
}

// An enum param carries no `display`: a generated panel draws a select from `values`,
// and claiming any of the slider-ish display kinds would make it draw the wrong control.
OpParamSpec choice(std::string name, std::string label, std::vector<std::string> values) {
  OpParamSpec spec;
  spec.name = std::move(name);
  spec.label = std::move(label);
  spec.type = ParamType::Enum;
  spec.default_value = values.front();
  spec.values = std::move(values);
  return spec;
}

// A point curve: the list of control points for one channel, drawn by the curve editor.
OpParamSpec curve(std::string name, std::string label) {
  OpParamSpec spec;
  spec.name = std::move(name);
  spec.label = std::move(label);
  spec.type = ParamType::Curve;
  spec.default_value = nlohmann::json::array();
  spec.display_kind = "curve";
  return spec;
}

// The three Hue/Saturation/Luminance sliders of one Color Mixer band.
void push_mixer_band(std::vector<OpParamSpec>& params, const std::string& band,
                     const std::string& label) {
  params.push_back(tinted(bipolar(band + "Hue", label + " hue"), "hsl", "hue"));
  params.push_back(
      tinted(bipolar(band + "Saturation", label + " saturation"), "hsl", "saturation"));
  params.push_back(bipolar(band + "Luminance", label + " luminance"));
  params.back().display_kind = "hsl";
}

// One Color Grading wheel, flattened to the three sliders Lightroom puts beside it.
void push_grading_range(std::vector<OpParamSpec>& params, const std::string& range,
                        const std::string& label) {
  OpParamSpec hue = slider(range + "Hue", label + " hue", 0, 360, 1, "°");
  params.push_back(tinted(std::move(hue), "slider", "hue"));
  params.push_back(
      tinted(unipolar(range + "Saturation", label + " saturation", 0), "slider", "saturation"));
  params.push_back(bipolar(range + "Luminance", label + " luminance"));
}

OpDefinition define(std::string name, std::string panel, std::string section, int order,
                    PipelineStage stage, std::string label, std::vector<OpParamSpec> params) {
  OpDefinition definition;
  definition.name = std::move(name);
  definition.panel = std::move(panel);
  definition.section = std::move(section);
  definition.order = order;
  definition.stage = stage;
  definition.label = std::move(label);
  definition.params = std::move(params);
  return definition;
}

// `section` and `order` are Lightroom's Edit panel, top to bottom (reference/lightroom/,
// scraped 2026-09-16): Light is Exposure … Blacks then the Curve; Color is White Balance,
// Vibrance, Saturation, Color Mixer, Color Grading; Effects is Texture, Clarity, Dehaze,
// Vignette, Grain; Detail is Sharpening and the two noise reductions; Optics is Chromatic
// Aberration, Lens Corrections, Defringe; Geometry is Crop, Rotate, Flip, Transform.
//
// `stage` is the other axis: the order the renderer applies the passes in, which is
// Lightroom's pipeline and not the stack's order —
//
//   Geometry (crop/rotate/flip/transform/lens distortion, folded into the proxy's
//   sampling pass) → Optics (CA, defringe) → Noise reduction → Tone (WB, the Light
//   sliders, the curve) → Colour (mixer, vibrance, saturation, grading) → Effects
//   (texture, clarity, dehaze, vignette) → Sharpening → Grain.
//
// Sharpening and grain are last because everything before them changes the detail they
// work on; noise reduction is early for the same reason.
//
// Every op's defaults are a no-op, which is not always Lightroom's default: Sharpening
// Amount and Color Noise Reduction Amount default to 0 here rather than to 40 and 25, and
// Lens Corrections' Distortion/Vignetting are manual -100..100 offsets (0 = untouched)
// rather than a 0..150 scale of a lens profile, because Latent has no profile database
// yet. engine/tests/render_test.cpp asserts the defaults render identically to an empty
// stack.
std::vector<OpDefinition> build_definitions() {
  std::vector<OpDefinition> definitions;
  definitions.push_back(define("exposure", "light", "Light", 1, PipelineStage::Tone, "Exposure",
                               {slider("value", "Exposure", -5, 5, 0.01, "EV")}));
  definitions.push_back(define("contrast", "light", "Light", 2, PipelineStage::Tone, "Contrast",
                               {amount("Contrast")}));
  definitions.push_back(define("highlights", "light", "Light", 3, PipelineStage::Tone, "Highlights",
                               {amount("Highlights")}));
  definitions.push_back(
      define("shadows", "light", "Light", 4, PipelineStage::Tone, "Shadows", {amount("Shadows")}));
  definitions.push_back(
      define("whites", "light", "Light", 5, PipelineStage::Tone, "Whites", {amount("Whites")}));
  definitions.push_back(
      define("blacks", "light", "Light", 6, PipelineStage::Tone, "Blacks", {amount("Blacks")}));
  definitions.push_back(define(
      "tone_curve", "light", "Light", 7, PipelineStage::Tone, "Curve",
      {bipolar("highlights", "Highlights"), bipolar("lights", "Lights"), bipolar("darks", "Darks"),
       bipolar("shadows", "Shadows"), unipolar("shadowSplit", "Shadow split", 25),
       unipolar("midtoneSplit", "Midtone split", 50),
       unipolar("highlightSplit", "Highlight split", 75), curve("rgb", "RGB channels"),
       curve("red", "Red channel"), curve("green", "Green channel"),
       curve("blue", "Blue channel")}));

  definitions.push_back(define(
      "white_balance", "color", "Color", 1, PipelineStage::Tone, "White Balance",
      {choice("mode", "Mode", {"relative", "kelvin"}),
       tinted(slider("temperature", "Temperature", -100, 100, 1, ""), "slider", "temperature"),
       tinted(with_default(slider("kelvin", "Temperature", 2000, 50000, 50, "K"), 5500), "kelvin",
              "temperature"),
       tinted(slider("tint", "Tint", -150, 150, 1, ""), "slider", "tint")}));
  definitions.push_back(define("vibrance", "color", "Color", 2, PipelineStage::Color, "Vibrance",
                               {tinted(amount("Vibrance"), "slider", "saturation")}));
  definitions.push_back(define("saturation", "color", "Color", 3, PipelineStage::Color,
                               "Saturation",
                               {tinted(amount("Saturation"), "slider", "saturation")}));

  std::vector<OpParamSpec> mixer;
  push_mixer_band(mixer, "red", "Red");
  push_mixer_band(mixer, "orange", "Orange");
  push_mixer_band(mixer, "yellow", "Yellow");
  push_mixer_band(mixer, "green", "Green");
  push_mixer_band(mixer, "aqua", "Aqua");
  push_mixer_band(mixer, "blue", "Blue");
  push_mixer_band(mixer, "purple", "Purple");
  push_mixer_band(mixer, "magenta", "Magenta");
  definitions.push_back(define("color_mixer", "color", "Color", 4, PipelineStage::Color,
                               "Color Mixer", std::move(mixer)));

  std::vector<OpParamSpec> grading;
  push_grading_range(grading, "shadow", "Shadows");
  push_grading_range(grading, "midtone", "Midtones");
  push_grading_range(grading, "highlight", "Highlights");
  push_grading_range(grading, "global", "Global");
  grading.push_back(unipolar("blending", "Blending", 50));
  grading.push_back(bipolar("balance", "Balance"));
  definitions.push_back(define("color_grading", "color", "Color", 5, PipelineStage::Color,
                               "Color Grading", std::move(grading)));

  definitions.push_back(define("texture", "effects", "Effects", 1, PipelineStage::Effects,
                               "Texture", {amount("Texture")}));
  definitions.push_back(define("clarity", "effects", "Effects", 2, PipelineStage::Effects,
                               "Clarity", {amount("Clarity")}));
  definitions.push_back(define("dehaze", "effects", "Effects", 3, PipelineStage::Effects, "Dehaze",
                               {amount("Dehaze")}));
  definitions.push_back(
      define("vignette", "effects", "Effects", 4, PipelineStage::Effects, "Vignette",
             {bipolar("amount", "Amount"), unipolar("midpoint", "Midpoint", 50),
              unipolar("feather", "Feather", 50), bipolar("roundness", "Roundness"),
              unipolar("highlights", "Highlights", 0)}));
  definitions.push_back(define("grain", "effects", "Effects", 5, PipelineStage::Grain, "Grain",
                               {unipolar("amount", "Amount", 0), unipolar("size", "Size", 25),
                                unipolar("roughness", "Roughness", 50)}));

  definitions.push_back(
      define("sharpening", "detail", "Detail", 1, PipelineStage::Sharpening, "Sharpening",
             {slider("amount", "Amount", 0, 150, 1, ""),
              with_default(slider("radius", "Radius", 0.5, 3, 0.1, "px"), 1.0),
              unipolar("detail", "Detail", 25), unipolar("masking", "Masking", 0)}));
  definitions.push_back(define(
      "noise_reduction", "detail", "Detail", 2, PipelineStage::NoiseReduction, "Noise Reduction",
      {unipolar("luminance", "Luminance", 0), unipolar("detail", "Detail", 50),
       unipolar("contrast", "Contrast", 0)}));
  definitions.push_back(define("color_noise_reduction", "detail", "Detail", 3,
                               PipelineStage::NoiseReduction, "Color Noise Reduction",
                               {unipolar("amount", "Amount", 0), unipolar("detail", "Detail", 50),
                                unipolar("smoothness", "Smoothness", 50)}));

  definitions.push_back(define("chromatic_aberration", "optics", "Optics", 1, PipelineStage::Optics,
                               "Remove Chromatic Aberration",
                               {toggle("enabled", "Remove chromatic aberration")}));
  definitions.push_back(
      define("lens_correction", "optics", "Optics", 2, PipelineStage::Geometry, "Lens Corrections",
             {bipolar("distortion", "Distortion"), bipolar("vignetting", "Vignetting")}));
  definitions.push_back(define(
      "defringe", "optics", "Optics", 3, PipelineStage::Optics, "Defringe",
      {unipolar("purpleAmount", "Purple amount", 0), unipolar("purpleHueLow", "Purple hue low", 30),
       unipolar("purpleHueHigh", "Purple hue high", 70), unipolar("greenAmount", "Green amount", 0),
       unipolar("greenHueLow", "Green hue low", 40),
       unipolar("greenHueHigh", "Green hue high", 60)}));

  definitions.push_back(define("crop", "geometry", "Geometry", 1, PipelineStage::Geometry, "Crop",
                               {with_default(slider("left", "Left", 0, 1, 0.001, ""), 0),
                                with_default(slider("top", "Top", 0, 1, 0.001, ""), 0),
                                with_default(slider("right", "Right", 0, 1, 0.001, ""), 1),
                                with_default(slider("bottom", "Bottom", 0, 1, 0.001, ""), 1),
                                slider("angle", "Straighten", -45, 45, 0.1, "°")}));
  OpParamSpec quadrant = slider("value", "Rotate", 0, 270, 90, "°");
  quadrant.type = ParamType::Integer;
  definitions.push_back(
      define("rotate", "geometry", "Geometry", 2, PipelineStage::Geometry, "Rotate", {quadrant}));
  definitions.push_back(
      define("flip", "geometry", "Geometry", 3, PipelineStage::Geometry, "Flip",
             {toggle("horizontal", "Flip horizontal"), toggle("vertical", "Flip vertical")}));
  definitions.push_back(
      define("transform", "geometry", "Geometry", 4, PipelineStage::Geometry, "Transform",
             {bipolar("vertical", "Vertical"), bipolar("horizontal", "Horizontal"),
              slider("rotate", "Rotate", -10, 10, 0.1, "°"), bipolar("aspect", "Aspect"),
              with_default(slider("scale", "Scale", 50, 150, 0.5, "%"), 100),
              bipolar("offsetX", "X offset"), bipolar("offsetY", "Y offset")}));
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
    const std::vector<CurvePoint> points = curve_points_from_json(value);
    if (points.size() != value.size()) {
      warnings.push_back(where + ": dropped control points that were not {x, y} in 0..1");
    }
    return curve_points_to_json(points);
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
      if (!spec.display_kind.empty()) {
        nlohmann::json display = {{"kind", spec.display_kind}};
        if (!spec.display_tint.empty()) display["tint"] = spec.display_tint;
        param["display"] = display;
      }
      params.push_back(param);
    }
    nlohmann::json described = {{"name", definition.name},
                                {"panel", definition.panel},
                                {"label", definition.label},
                                {"params", params}};
    if (!definition.section.empty()) described["section"] = definition.section;
    if (definition.order > 0) described["order"] = definition.order;
    ops.push_back(described);
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

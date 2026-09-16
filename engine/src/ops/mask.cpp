#include "ops/mask.h"

#include "ops/sha256.h"

#include <cmath>

#include <algorithm>
#include <array>
#include <numbers>
#include <span>
#include <string>
#include <unordered_set>
#include <utility>

namespace latent {

namespace {

constexpr std::array<std::string_view, 12> kKindNames = {
    "subject", "sky",    "background", "objects",   "people", "text",
    "brush",   "linear", "radial",     "luminance", "color",  "depth"};
constexpr std::array<std::string_view, 3> kModeNames = {"add", "subtract", "intersect"};
constexpr std::array<std::string_view, 4> kStateNames = {"ready", "pending", "stale", "failed"};
constexpr std::array<std::string_view, 2> kSpaceNames = {"image", "content"};

// A drag can legitimately put a gradient handle a little outside the frame, so
// coordinates are allowed one frame of slack either way; anything wilder is a bug in the
// caller, not a gesture.
constexpr double kCoordinateLow = -1.0;
constexpr double kCoordinateHigh = 2.0;
constexpr size_t kMaxColorSamples = 5;

[[noreturn]] void reject(const std::string& message) {
  throw OpError("mask: " + message);
}

double number_in(const nlohmann::json& value, double low, double high, const std::string& where) {
  if (!value.is_number()) reject(where + " must be a number");
  const double number = value.get<double>();
  if (!std::isfinite(number)) reject(where + " must be finite");
  if (number < low || number > high) {
    reject(where + " must be between " + std::to_string(low) + " and " + std::to_string(high));
  }
  return number;
}

double optional_number(const nlohmann::json& params, const char* key, double fallback, double low,
                       double high, const std::string& where) {
  if (!params.contains(key) || params[key].is_null()) return fallback;
  return number_in(params[key], low, high, where + "." + key);
}

// A [x, y] pair in normalised image coordinates.
nlohmann::json point_param(const nlohmann::json& params, const char* key,
                           const std::array<double, 2>& fallback, const std::string& where) {
  if (!params.contains(key) || params[key].is_null()) {
    return nlohmann::json::array({fallback[0], fallback[1]});
  }
  const nlohmann::json& value = params[key];
  if (!value.is_array() || value.size() != 2) {
    reject(where + "." + key + " must be a [x, y] pair");
  }
  return nlohmann::json::array(
      {number_in(value[0], kCoordinateLow, kCoordinateHigh, where + "." + key + "[0]"),
       number_in(value[1], kCoordinateLow, kCoordinateHigh, where + "." + key + "[1]")});
}

// Engine-owned bookkeeping a component carries once it has been rasterised or has failed.
// Kept verbatim so a round trip through op.update cannot lose a detect's result.
void carry_engine_fields(const nlohmann::json& from, nlohmann::json& to) {
  for (const char* key : {"model", "sourceHash", "raster", "error"}) {
    if (from.contains(key) && !from[key].is_null()) to[key] = from[key];
  }
}

nlohmann::json normalize_linear(const nlohmann::json& params, const std::string& where) {
  nlohmann::json out = nlohmann::json::object();
  out["start"] = point_param(params, "start", {0.5, 0.0}, where);
  out["end"] = point_param(params, "end", {0.5, 1.0}, where);
  return out;
}

nlohmann::json normalize_radial(const nlohmann::json& params, const std::string& where) {
  nlohmann::json out = nlohmann::json::object();
  out["center"] = point_param(params, "center", {0.5, 0.5}, where);
  if (!params.contains("radius") || params["radius"].is_null()) {
    out["radius"] = nlohmann::json::array({0.3, 0.3});
  } else {
    const nlohmann::json& radius = params["radius"];
    if (!radius.is_array() || radius.size() != 2) reject(where + ".radius must be a [rx, ry] pair");
    out["radius"] = nlohmann::json::array({number_in(radius[0], 0.001, 2.0, where + ".radius[0]"),
                                           number_in(radius[1], 0.001, 2.0, where + ".radius[1]")});
  }
  out["angle"] = optional_number(params, "angle", 0.0, -360.0, 360.0, where);
  return out;
}

nlohmann::json normalize_luminance(const nlohmann::json& params, const std::string& where) {
  nlohmann::json out = nlohmann::json::object();
  double low = 0.5;
  double high = 1.0;
  if (params.contains("range") && !params["range"].is_null()) {
    const nlohmann::json& range = params["range"];
    if (!range.is_array() || range.size() != 2) reject(where + ".range must be a [lo, hi] pair");
    low = number_in(range[0], 0.0, 1.0, where + ".range[0]");
    high = number_in(range[1], 0.0, 1.0, where + ".range[1]");
    if (low > high) reject(where + ".range must be ascending");
  }
  out["range"] = nlohmann::json::array({low, high});
  out["smoothness"] = optional_number(params, "smoothness", 0.1, 0.0, 1.0, where);
  return out;
}

nlohmann::json normalize_color(const nlohmann::json& params, const std::string& where) {
  nlohmann::json samples = nlohmann::json::array();
  if (params.contains("samples") && !params["samples"].is_null()) {
    if (!params["samples"].is_array()) reject(where + ".samples must be an array");
    if (params["samples"].size() > kMaxColorSamples) {
      reject(where + ".samples takes at most " + std::to_string(kMaxColorSamples) + " colours");
    }
    for (const nlohmann::json& sample : params["samples"]) {
      if (!sample.is_array() || sample.size() != 3) reject(where + ".samples holds [r, g, b]");
      samples.push_back(
          nlohmann::json::array({number_in(sample[0], 0.0, 1.0, where + ".samples.r"),
                                 number_in(sample[1], 0.0, 1.0, where + ".samples.g"),
                                 number_in(sample[2], 0.0, 1.0, where + ".samples.b")}));
    }
  }
  nlohmann::json out = nlohmann::json::object();
  out["samples"] = std::move(samples);
  out["range"] = optional_number(params, "range", 0.2, 0.001, 1.0, where);
  out["smoothness"] = optional_number(params, "smoothness", 0.1, 0.0, 1.0, where);
  return out;
}

nlohmann::json normalize_brush(const nlohmann::json& params, const std::string& where) {
  nlohmann::json out = nlohmann::json::object();
  out["size"] = optional_number(params, "size", 0.08, 0.001, 1.0, where);
  out["flow"] = optional_number(params, "flow", 100.0, 0.0, 100.0, where);
  const auto key = std::string(kBrushStrokeDataKey);
  if (params.contains(key) && !params[key].is_null()) {
    out[key] = brush_strokes_to_json(brush_strokes(params));
  } else {
    out[key] = nlohmann::json::array();
  }
  const auto path_key = std::string(kBrushStrokePathKey);
  if (params.contains(path_key) && params[path_key].is_string()) out[path_key] = params[path_key];
  return out;
}

nlohmann::json normalize_objects(const nlohmann::json& params, const std::string& where) {
  nlohmann::json out = nlohmann::json::object();
  if (params.contains("box") && !params["box"].is_null()) {
    const nlohmann::json& box = params["box"];
    if (!box.is_array() || box.size() != 4) reject(where + ".box must be [x0, y0, x1, y1]");
    nlohmann::json corners = nlohmann::json::array();
    for (size_t i = 0; i < 4; ++i) {
      corners.push_back(number_in(box[i], kCoordinateLow, kCoordinateHigh,
                                  where + ".box[" + std::to_string(i) + "]"));
    }
    out["box"] = std::move(corners);
  }
  if (params.contains("points") && !params["points"].is_null()) {
    if (!params["points"].is_array()) reject(where + ".points must be an array");
    nlohmann::json points = nlohmann::json::array();
    for (const nlohmann::json& point : params["points"]) {
      if (!point.is_array() || point.size() != 2) reject(where + ".points holds [x, y] pairs");
      points.push_back(nlohmann::json::array(
          {number_in(point[0], kCoordinateLow, kCoordinateHigh, where + ".points.x"),
           number_in(point[1], kCoordinateLow, kCoordinateHigh, where + ".points.y")}));
    }
    out["points"] = std::move(points);
  }
  return out;
}

nlohmann::json normalize_params_for_kind(MaskKind kind, const nlohmann::json& params,
                                         const std::string& where) {
  switch (kind) {
    case MaskKind::Linear:
      return normalize_linear(params, where);
    case MaskKind::Radial:
      return normalize_radial(params, where);
    case MaskKind::Luminance:
      return normalize_luminance(params, where);
    case MaskKind::Color:
      return normalize_color(params, where);
    case MaskKind::Brush:
      return normalize_brush(params, where);
    case MaskKind::Objects:
      return normalize_objects(params, where);
    case MaskKind::People: {
      nlohmann::json out = nlohmann::json::object();
      out["person"] = static_cast<int64_t>(
          std::llround(optional_number(params, "person", 1.0, 1.0, 64.0, where)));
      return out;
    }
    case MaskKind::Text: {
      if (!params.contains("prompt") || !params["prompt"].is_string()) {
        reject(where + ".prompt must be a string");
      }
      nlohmann::json out = nlohmann::json::object();
      out["prompt"] = params["prompt"];
      return out;
    }
    default:
      return nlohmann::json::object();
  }
}

// Lightroom's own defaults: a gradient ramps over its whole band, a radial is soft, a
// brush has a soft edge, and the range/AI kinds start hard (protocol MaskComponent).
double default_feather(MaskKind kind) {
  switch (kind) {
    case MaskKind::Linear:
      return 100;
    case MaskKind::Radial:
    case MaskKind::Brush:
      return 50;
    default:
      return 0;
  }
}

}  // namespace

std::string_view mask_kind_name(MaskKind kind) {
  return kKindNames[static_cast<size_t>(kind)];
}

std::string_view mask_mode_name(MaskMode mode) {
  return kModeNames[static_cast<size_t>(mode)];
}

std::string_view mask_state_name(MaskState state) {
  return kStateNames[static_cast<size_t>(state)];
}

std::string_view mask_space_name(MaskSpace space) {
  return kSpaceNames[static_cast<size_t>(space)];
}

bool mask_kind_is_ai(MaskKind kind) {
  switch (kind) {
    case MaskKind::Brush:
    case MaskKind::Linear:
    case MaskKind::Radial:
    case MaskKind::Luminance:
    case MaskKind::Color:
      return false;
    default:
      return true;
  }
}

MaskKind mask_kind_from_name(std::string_view name) {
  for (size_t i = 0; i < kKindNames.size(); ++i) {
    if (kKindNames[i] == name) return static_cast<MaskKind>(i);
  }
  reject("unknown component kind '" + std::string(name) + "'");
}

MaskMode mask_mode_from_name(std::string_view name) {
  for (size_t i = 0; i < kModeNames.size(); ++i) {
    if (kModeNames[i] == name) return static_cast<MaskMode>(i);
  }
  reject("unknown component mode '" + std::string(name) + "'");
}

MaskState mask_state_from_name(std::string_view name) {
  for (size_t i = 0; i < kStateNames.size(); ++i) {
    if (kStateNames[i] == name) return static_cast<MaskState>(i);
  }
  reject("unknown component state '" + std::string(name) + "'");
}

MaskSpace mask_space_from_name(std::string_view name) {
  for (size_t i = 0; i < kSpaceNames.size(); ++i) {
    if (kSpaceNames[i] == name) return static_cast<MaskSpace>(i);
  }
  reject("unknown mask space '" + std::string(name) + "'");
}

Mask mask_from_json(const nlohmann::json& value) {
  if (!value.is_object()) reject("mask must be an object");
  Mask mask;
  if (value.contains("space") && !value["space"].is_null()) {
    if (!value["space"].is_string()) reject("mask.space must be a string");
    mask.space = mask_space_from_name(value["space"].get<std::string>());
  }
  const nlohmann::json components = value.value("components", nlohmann::json::array());
  if (!components.is_array()) reject("mask.components must be an array");

  std::unordered_set<std::string> seen;
  for (const nlohmann::json& entry : components) {
    if (!entry.is_object()) reject("a mask component must be an object");
    MaskComponent component;
    // The schema requires an id; generating one for a caller that omitted it is friendlier
    // than refusing a component that is otherwise complete, and keeps the ids unique.
    component.id = entry.value("id", std::string());
    if (component.id.empty()) component.id = make_op_id();
    if (!seen.insert(component.id).second) {
      reject("duplicate component id '" + component.id + "'");
    }
    if (!entry.contains("kind") || !entry["kind"].is_string()) {
      reject("component.kind must be a string");
    }
    component.kind = mask_kind_from_name(entry["kind"].get<std::string>());
    if (entry.contains("mode")) {
      if (!entry["mode"].is_string()) reject("component.mode must be a string");
      component.mode = mask_mode_from_name(entry["mode"].get<std::string>());
    }

    const std::string where = "component '" + component.id + "'";
    if (entry.contains("invert") && !entry["invert"].is_null()) {
      if (!entry["invert"].is_boolean()) reject(where + ".invert must be a boolean");
      component.invert = entry["invert"].get<bool>();
    }
    component.feather =
        optional_number(entry, "feather", default_feather(component.kind), 0, 100, where);
    component.opacity = optional_number(entry, "opacity", 100, 0, 100, where);

    const nlohmann::json given = entry.value("params", nlohmann::json::object());
    if (!given.is_object()) reject(where + ".params must be an object");
    component.params = normalize_params_for_kind(component.kind, given, where);
    carry_engine_fields(given, component.params);

    if (entry.contains("state") && !entry["state"].is_null()) {
      if (!entry["state"].is_string()) reject(where + ".state must be a string");
      component.state = mask_state_from_name(entry["state"].get<std::string>());
    } else if (mask_kind_is_ai(component.kind) && !component.params.contains("raster")) {
      // An AI component nobody has run yet is pending, not ready: it contributes nothing
      // until mask.detect produces its raster.
      component.state = MaskState::Pending;
    }
    if (entry.contains("jobId") && entry["jobId"].is_number_integer()) {
      component.job_id = entry["jobId"].get<int64_t>();
    }
    mask.components.push_back(std::move(component));
  }
  return mask;
}

nlohmann::json component_to_json(const MaskComponent& component) {
  nlohmann::json out = {{"id", component.id},
                        {"kind", mask_kind_name(component.kind)},
                        {"mode", mask_mode_name(component.mode)},
                        {"params", component.params},
                        {"state", mask_state_name(component.state)}};
  if (component.invert) out["invert"] = true;
  if (component.feather != default_feather(component.kind)) out["feather"] = component.feather;
  if (component.opacity != 100) out["opacity"] = component.opacity;
  if (component.job_id > 0) out["jobId"] = component.job_id;
  return out;
}

nlohmann::json mask_to_json(const Mask& mask) {
  nlohmann::json components = nlohmann::json::array();
  for (const MaskComponent& component : mask.components) {
    components.push_back(component_to_json(component));
  }
  // Always written, never inferred: a sidecar that names its space cannot be migrated
  // twice, and a client reading one knows which convention the numbers follow.
  return {{"components", components}, {"space", mask_space_name(mask.space)}};
}

nlohmann::json normalize_mask(const nlohmann::json& value) {
  return mask_to_json(mask_from_json(value));
}

MaskComponent* find_component(Mask& mask, std::string_view component_id) {
  for (MaskComponent& component : mask.components) {
    if (component.id == component_id) return &component;
  }
  return nullptr;
}

const MaskComponent* find_component(const Mask& mask, std::string_view component_id) {
  for (const MaskComponent& component : mask.components) {
    if (component.id == component_id) return &component;
  }
  return nullptr;
}

std::string mask_hash(const nlohmann::json& canonical, uint32_t width, uint32_t height) {
  const std::string text =
      canonical.dump() + "@" + std::to_string(width) + "x" + std::to_string(height);
  return sha256_hex({reinterpret_cast<const uint8_t*>(text.data()), text.size()});
}

std::vector<BrushStroke> brush_strokes(const nlohmann::json& params) {
  std::vector<BrushStroke> strokes;
  const auto key = std::string(kBrushStrokeDataKey);
  if (!params.contains(key) || !params[key].is_array()) return strokes;
  for (const nlohmann::json& entry : params[key]) {
    if (!entry.is_object()) reject("brush stroke must be an object");
    BrushStroke stroke;
    stroke.erase = entry.value("erase", false);
    stroke.size = number_in(entry.value("size", nlohmann::json(0.08)), 0.001, 1.0, "stroke.size");
    stroke.flow = number_in(entry.value("flow", nlohmann::json(100.0)), 0.0, 100.0, "stroke.flow");
    const nlohmann::json points = entry.value("points", nlohmann::json::array());
    if (!points.is_array()) reject("stroke.points must be an array");
    for (const nlohmann::json& point : points) {
      if (!point.is_array() || point.size() < 2 || point.size() > 3) {
        reject("stroke point must be [x, y] or [x, y, pressure]");
      }
      StrokePoint at;
      at.x = number_in(point[0], kCoordinateLow, kCoordinateHigh, "stroke point x");
      at.y = number_in(point[1], kCoordinateLow, kCoordinateHigh, "stroke point y");
      if (point.size() == 3) at.pressure = number_in(point[2], 0.0, 1.0, "stroke point pressure");
      stroke.points.push_back(at);
    }
    if (stroke.points.empty()) continue;
    strokes.push_back(std::move(stroke));
  }
  return strokes;
}

nlohmann::json brush_strokes_to_json(const std::vector<BrushStroke>& strokes) {
  nlohmann::json out = nlohmann::json::array();
  for (const BrushStroke& stroke : strokes) {
    nlohmann::json points = nlohmann::json::array();
    for (const StrokePoint& point : stroke.points) {
      points.push_back(nlohmann::json::array({point.x, point.y, point.pressure}));
    }
    out.push_back({{"erase", stroke.erase},
                   {"size", stroke.size},
                   {"flow", stroke.flow},
                   {"points", std::move(points)}});
  }
  return out;
}

void append_brush_stroke(nlohmann::json& params, const BrushStroke& stroke) {
  std::vector<BrushStroke> strokes = brush_strokes(params);
  strokes.push_back(stroke);
  params[std::string(kBrushStrokeDataKey)] = brush_strokes_to_json(strokes);
}

namespace {

// The content -> image map in the metric the shaders work in: x scaled by the aspect so a
// circle is a circle. `columns` are the images of the unit x and y vectors at `at`, which
// is everything a scalar or an angle needs to follow the map.
struct LocalFrame {
  std::array<double, 2> x{1, 0};
  std::array<double, 2> y{0, 1};
};

LocalFrame local_frame(const GeometryMap& map, double content_aspect, double u, double v) {
  constexpr double kStep = 1e-3;
  const auto at = [&](double su, double sv) {
    const std::array<double, 2> image = mat3_apply(map.content_to_image, su, sv);
    return std::array<double, 2>{image[0] * map.image_aspect, image[1]};
  };
  const std::array<double, 2> right = at(u + (kStep / content_aspect), v);
  const std::array<double, 2> left = at(u - (kStep / content_aspect), v);
  const std::array<double, 2> down = at(u, v + kStep);
  const std::array<double, 2> up = at(u, v - kStep);
  LocalFrame frame;
  frame.x = {(right[0] - left[0]) / (2 * kStep), (right[1] - left[1]) / (2 * kStep)};
  frame.y = {(down[0] - up[0]) / (2 * kStep), (down[1] - up[1]) / (2 * kStep)};
  return frame;
}

std::array<double, 2> to_image(const GeometryMap& map, const nlohmann::json& point) {
  if (!point.is_array() || point.size() < 2) return {0, 0};
  return mat3_apply(map.content_to_image, point[0].get<double>(), point[1].get<double>());
}

nlohmann::json point_to_image(const GeometryMap& map, const nlohmann::json& point) {
  const std::array<double, 2> image = to_image(map, point);
  return nlohmann::json::array({image[0], image[1]});
}

void migrate_params(MaskKind kind, nlohmann::json& params, const GeometryMap& map,
                    double content_aspect) {
  if (kind == MaskKind::Linear) {
    if (params.contains("start")) params["start"] = point_to_image(map, params["start"]);
    if (params.contains("end")) params["end"] = point_to_image(map, params["end"]);
    return;
  }
  if (kind == MaskKind::Radial) {
    const nlohmann::json centre = params.value("center", nlohmann::json::array({0.5, 0.5}));
    const LocalFrame frame =
        local_frame(map, content_aspect, centre[0].get<double>(), centre[1].get<double>());
    params["center"] = point_to_image(map, centre);
    if (params.contains("radius")) {
      const double x_scale = std::hypot(frame.x[0], frame.x[1]);
      const double y_scale = std::hypot(frame.y[0], frame.y[1]);
      params["radius"] = nlohmann::json::array({params["radius"][0].get<double>() * x_scale,
                                                params["radius"][1].get<double>() * y_scale});
    }
    const double turn = std::atan2(frame.x[1], frame.x[0]) * 180.0 / std::numbers::pi;
    params["angle"] = params.value("angle", 0.0) + turn;
    return;
  }
  if (kind == MaskKind::Objects) {
    if (params.contains("box")) {
      const std::array<double, 2> first =
          to_image(map, nlohmann::json::array({params["box"][0], params["box"][1]}));
      const std::array<double, 2> second =
          to_image(map, nlohmann::json::array({params["box"][2], params["box"][3]}));
      params["box"] =
          nlohmann::json::array({std::min(first[0], second[0]), std::min(first[1], second[1]),
                                 std::max(first[0], second[0]), std::max(first[1], second[1])});
    }
    if (params.contains("points") && params["points"].is_array()) {
      for (nlohmann::json& point : params["points"])
        point = point_to_image(map, point);
    }
    return;
  }
  if (kind != MaskKind::Brush) return;
  const LocalFrame frame = local_frame(map, content_aspect, 0.5, 0.5);
  const double scale =
      std::sqrt(std::hypot(frame.x[0], frame.x[1]) * std::hypot(frame.y[0], frame.y[1]));
  if (params.contains("size")) params["size"] = params["size"].get<double>() * scale;
  const auto key = std::string(kBrushStrokeDataKey);
  if (!params.contains(key) || !params[key].is_array()) return;
  for (nlohmann::json& stroke : params[key]) {
    if (stroke.contains("size")) stroke["size"] = stroke["size"].get<double>() * scale;
    if (!stroke.contains("points") || !stroke["points"].is_array()) continue;
    for (nlohmann::json& point : stroke["points"]) {
      const std::array<double, 2> image = to_image(map, point);
      const double pressure = point.size() > 2 ? point[2].get<double>() : 1.0;
      point = nlohmann::json::array({image[0], image[1], pressure});
    }
  }
}

}  // namespace

nlohmann::json migrate_mask_space(const nlohmann::json& mask, const GeometryMap& map) {
  if (!mask.is_object()) return mask;
  const std::string declared = mask.value("space", std::string("image"));
  if (declared != mask_space_name(MaskSpace::Content)) return mask;
  nlohmann::json out = mask;
  out["space"] = mask_space_name(MaskSpace::Image);
  if (!out.contains("components") || !out["components"].is_array()) return out;
  const double content_aspect =
      map.content.height == 0
          ? 1.0
          : static_cast<double>(map.content.width) / static_cast<double>(map.content.height);
  for (nlohmann::json& component : out["components"]) {
    if (!component.is_object() || !component.contains("kind")) continue;
    if (!component.contains("params") || !component["params"].is_object()) continue;
    migrate_params(mask_kind_from_name(component["kind"].get<std::string>()), component["params"],
                   map, content_aspect);
  }
  return out;
}

void migrate_mask_space(Stack& stack, uint32_t photo_width, uint32_t photo_height) {
  const GeometryMap map = geometry_map(geometry_from_stack(stack), photo_width, photo_height,
                                       photo_width, photo_height);
  for (Op& op : stack) {
    if (!op.mask.has_value()) continue;
    op.mask = migrate_mask_space(*op.mask, map);
  }
}

std::string sidecar_dir_for(std::string_view photo_path) {
  return std::string(photo_path) + ".latent.d";
}

std::string mask_dir_for(std::string_view photo_path) {
  return sidecar_dir_for(photo_path) + "/masks";
}

std::string mask_raster_relative_path(std::string_view component_id, std::string_view hash) {
  return "masks/" + std::string(component_id) + "." + std::string(hash).substr(0, 16) + ".png";
}

std::string brush_stroke_relative_path(std::string_view component_id) {
  return "masks/" + std::string(component_id) + ".strokes.json";
}

}  // namespace latent

// Per-op masks (PROMPT.md 3.7): a list of components combined top-down. Pure data, no
// GPU, no I/O — the rasteriser lives in pipeline/mask_raster.* and pipeline/renderer.*.
//
// An op renders as mix(in, op(in), mask * opacity). A component that cannot contribute
// yet (an AI kind whose mask.detect job is pending, or one that failed) contributes
// nothing, which is not the same as being absent: a mask whose components all sit out
// rasterises to zero and the op does nothing.
#pragma once

#include "ops/op.h"

#include <cstdint>

#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// protocol/messages.schema.json#/definitions/MaskComponentKind.
enum class MaskKind : uint8_t {
  Subject,
  Sky,
  Background,
  Objects,
  People,
  Text,
  Brush,
  Linear,
  Radial,
  Luminance,
  Color,
  Depth,
};

enum class MaskMode : uint8_t { Add, Subtract, Intersect };

// ready / stale rasterise; pending and failed contribute nothing until mask.detect lands.
enum class MaskState : uint8_t { Ready, Pending, Stale, Failed };

std::string_view mask_kind_name(MaskKind kind);
std::string_view mask_mode_name(MaskMode mode);
std::string_view mask_state_name(MaskState state);

// True for the kinds that need a model run (mask.detect): subject, sky, background,
// objects, people, text, depth. The rest rasterise inline from their params.
bool mask_kind_is_ai(MaskKind kind);

// Throw OpError, which the server maps to -32602.
MaskKind mask_kind_from_name(std::string_view name);
MaskMode mask_mode_from_name(std::string_view name);
MaskState mask_state_from_name(std::string_view name);

// One validated component: defaults filled in, every number inside its documented range.
struct MaskComponent {
  std::string id;
  MaskKind kind = MaskKind::Brush;
  MaskMode mode = MaskMode::Add;
  bool invert = false;
  double feather = 0;
  double opacity = 100;
  nlohmann::json params = nlohmann::json::object();
  MaskState state = MaskState::Ready;
  int64_t job_id = 0;

  bool contributes() const { return state == MaskState::Ready || state == MaskState::Stale; }
};

struct Mask {
  std::vector<MaskComponent> components;
};

// Validates and fills in defaults. Throws OpError for a duplicate id, an unknown kind or
// mode, or a param that is not a finite number in its documented range.
Mask mask_from_json(const nlohmann::json& value);
nlohmann::json mask_to_json(const Mask& mask);
nlohmann::json component_to_json(const MaskComponent& component);

// mask_from_json followed by mask_to_json: the canonical form that goes into the stack,
// the sidecar and the cache key.
nlohmann::json normalize_mask(const nlohmann::json& value);

MaskComponent* find_component(Mask& mask, std::string_view component_id);
const MaskComponent* find_component(const Mask& mask, std::string_view component_id);

// Cache key: sha256 over the canonical JSON plus the raster size. A mask whose JSON and
// proxy size are unchanged reuses its raster, which is what keeps a masked slider drag
// off the rasteriser (only the blend runs).
std::string mask_hash(const nlohmann::json& canonical, uint32_t width, uint32_t height);

// ---- brush strokes ------------------------------------------------------------------
// The engine owns the stroke list: the UI appends to it with mask.stroke and never sends
// pixels. It lives in the component's params under `strokeData` so it rides the history
// snapshots (one undo drops a whole stroke), and is mirrored to the sidecar directory at
// the path `params.strokes` names.
inline constexpr std::string_view kBrushStrokeDataKey = "strokeData";
inline constexpr std::string_view kBrushStrokePathKey = "strokes";

struct StrokePoint {
  double x = 0;
  double y = 0;
  double pressure = 1;
};

struct BrushStroke {
  bool erase = false;
  // Diameter as a fraction of the content rect's long edge.
  double size = 0.08;
  double flow = 100;
  std::vector<StrokePoint> points;
};

std::vector<BrushStroke> brush_strokes(const nlohmann::json& params);
nlohmann::json brush_strokes_to_json(const std::vector<BrushStroke>& strokes);
void append_brush_stroke(nlohmann::json& params, const BrushStroke& stroke);

// ---- where rasters and strokes live -------------------------------------------------
// `<photo>.latent` is the sidecar; `<photo>.latent.d/` is its sibling directory
// (PROMPT.md 3.3), with `masks/` inside it.
std::string sidecar_dir_for(std::string_view photo_path);
std::string mask_dir_for(std::string_view photo_path);
// Relative to the sidecar directory, so the sidecar stays portable.
std::string mask_raster_relative_path(std::string_view component_id, std::string_view hash);
std::string brush_stroke_relative_path(std::string_view component_id);

}  // namespace latent

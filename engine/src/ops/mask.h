// Per-op masks (PROMPT.md 3.7): a list of components combined top-down. Pure data, no
// GPU, no I/O — the rasteriser lives in pipeline/mask_raster.* and pipeline/renderer.*.
//
// An op renders as mix(in, op(in), mask * opacity). A component that cannot contribute
// yet (an AI kind whose mask.detect job is pending, or one that failed) contributes
// nothing, which is not the same as being absent: a mask whose components all sit out
// rasterises to zero and the op does nothing.
#pragma once

#include "ops/geometry.h"
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
  Trails,
};

enum class MaskMode : uint8_t { Add, Subtract, Intersect };

// Which space a mask's coordinates are normalised over (protocol Mask.space).
//
//   Image    0..1 over the decoded photo, before crop, straighten, rotate, flip and the
//            Transform sliders. The only space this engine writes: a mask painted on the
//            subject stays on the subject when the geometry moves afterwards, which is
//            what Lightroom does.
//   Content  0..1 over the developed image as a view shows it. What every mask written
//            before this change holds; `migrate_mask_space` converts one on load and
//            nothing else in the engine ever produces one.
//
// An absent `space` on the wire means Image: a client that has not been updated is a
// client that never applied geometry either, and there the two spaces coincide.
enum class MaskSpace : uint8_t { Image, Content };

// ready / stale rasterise; pending and failed contribute nothing until mask.detect lands.
enum class MaskState : uint8_t { Ready, Pending, Stale, Failed };

std::string_view mask_kind_name(MaskKind kind);
std::string_view mask_mode_name(MaskMode mode);
std::string_view mask_state_name(MaskState state);
std::string_view mask_space_name(MaskSpace space);

// True for the kinds whose raster is produced by a mask.detect job: subject, sky,
// background, objects, people, text, depth, trails. The rest rasterise inline from their
// params. `trails` is the one that runs no model — it is a line detector (ai/trails.h) —
// but it goes through the same job, cache and staleness path as the rest.
bool mask_kind_is_ai(MaskKind kind);

// Throw OpError, which the server maps to -32602.
MaskKind mask_kind_from_name(std::string_view name);
MaskMode mask_mode_from_name(std::string_view name);
MaskState mask_state_from_name(std::string_view name);
MaskSpace mask_space_from_name(std::string_view name);

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
  MaskSpace space = MaskSpace::Image;
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
// off the rasteriser (only the blend runs). The caller folds the geometry stage into
// `canonical` (pipeline/renderer.cpp), because a mask in image space rasterises into view
// pixels and a crop, a rotate or a zoom moves every one of them.
std::string mask_hash(const nlohmann::json& canonical, uint32_t width, uint32_t height);

// ---- migration ----------------------------------------------------------------------
// Masks written before image space hold coordinates normalised over the content rect. This
// walks a loaded stack, converts every mask that has not declared its space through the
// stack's own geometry, and marks it `image`. Idempotent: a mask already in image space is
// left alone.
//
// Points convert exactly. Scalars — a radial's radii, a brush's diameter — have no exact
// image-space twin once a straighten or a keystone is in play, so they are scaled by the
// map's local linear factor at the shape's own centre. Best effort, and only ever applied
// once per sidecar.
void migrate_mask_space(Stack& stack, uint32_t photo_width, uint32_t photo_height);
nlohmann::json migrate_mask_space(const nlohmann::json& mask, const GeometryMap& map);

// Masks written before groups sit on the adjustment itself. Each one becomes a group of
// one: the mask and the opacity move up, the adjustment stays under them, and the rendered
// result is the same except for where it lands in the pipeline (PipelineStage::Local).
// Generative ops keep their own mask — it is the region a backend painted, not a layer.
// Idempotent: a stack that already holds groups is left alone.
void migrate_mask_groups(Stack& stack);

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
  // Diameter as a fraction of the *image's* long edge, like every other mask coordinate.
  // A crop does not change how wide a painted stroke is on the subject.
  double size = 0.08;
  double flow = 100;
  std::vector<StrokePoint> points;
};

std::vector<BrushStroke> brush_strokes(const nlohmann::json& params);
nlohmann::json brush_strokes_to_json(const std::vector<BrushStroke>& strokes);
void append_brush_stroke(nlohmann::json& params, const BrushStroke& stroke);

// ---- where rasters and strokes live -------------------------------------------------
// `<photo>.latent` is the sidecar and stays beside the photo. The rasters it points at —
// mask rasters, brush-stroke mirrors, the depth map, generative patches — live in the
// engine's data dir, keyed by the source file's sha-256 (`photo.hash`, the sidecar's
// `source_hash`): Latent never writes the source, so the key survives a move or rename
// outside the app, works on read-only folders, and keeps the catalog scan out of them.
// `$XDG_DATA_HOME/latent/rasters/<sha256>/`, else `~/.local/share/latent/rasters/<sha256>/`.
std::string raster_dir_for(std::string_view photo_hash);
// Before the store, rasters sat beside the photo in `<photo>.latent.d/`. The scan must skip
// such a directory wherever it still is, and opening the photo moves it into the store.
bool is_legacy_raster_dir(std::string_view directory);
// True for any path with a `*.latent.d` directory among its components.
bool is_inside_legacy_raster_dir(std::string_view path);
// Moves `<photo>.latent.d/` into raster_dir_for(hash), keeping files already in the store.
// Idempotent; a source it cannot delete (read-only folder) stays, copied. Throws nothing.
void migrate_legacy_raster_dir(std::string_view photo_path, std::string_view photo_hash);
// Relative to the raster directory, so the sidecar never names an absolute path.
std::string mask_raster_relative_path(std::string_view component_id, std::string_view hash);
std::string brush_stroke_relative_path(std::string_view component_id);

}  // namespace latent

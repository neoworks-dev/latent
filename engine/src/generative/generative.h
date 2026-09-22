// Generative ops as the op-stack sees them (PROMPT.md 3.5). A generative op is a cached
// raster: the params describe the next run, `Op.result` holds the pixels the last one
// produced, and `Op.input_hash` records what those pixels were made from. Nothing here
// touches the GPU, a process or the filesystem, so engine/tests/generative_test.cpp drives
// all of it without a device.
#pragma once

#include "ops/op.h"

#include <cstdint>

#include <optional>
#include <span>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace latent {

// `is_generative_op` lives in ops/registry.h: the stack's own data layer needs it too, to
// keep a generative op's mask out of the group migration (ops/mask.h).

// The passes the renderer runs before this op's composite, in stack order: every enabled op
// below PipelineStage::Generative, plus the generative ops that sit lower in the stack.
// That is exactly the image the composite mixes into, so it is also exactly the crop the
// backend is handed — rendering the input any other way would develop the patch twice.
//
// Geometry is the one thing taken wherever it sits: a crop is framing, not an edit below,
// and `result_rect` is normalised over the content rect it produces.
Stack generative_input_stack(const Stack& stack, std::string_view op_id);

// sha256 over the input stack, the op's mask and the op's params. Two runs with the same
// hash would see the same pixels and be asked for the same thing.
std::string generative_input_hash(const Stack& stack, std::string_view op_id);

// A result that was made from something else. A stale op still renders its last result —
// re-running is always the user's call, never the engine's (PROMPT.md 3.5 step 6).
bool generative_is_stale(const Stack& stack, const Op& op);

// `stack_to_json` with `stale` added to the generative entries that have a result. The
// field is derived, so it never reaches the sidecar: the server adds it on the way out.
void annotate_generative_stale(nlohmann::json& stack_json, const Stack& stack);

// `generative/<opId>.png`, relative to the photo's raster dir (ops/mask.h, raster_dir_for).
std::string generative_result_relative_path(std::string_view op_id);

// Which graph an op asks for: "fill", "remove", "denoise" or "upscale". An op that is not
// generative has no task and answers empty.
std::string generative_task(std::string_view op_name);

// An `upscale` op's `factor` param as a number: 2 or 4. Anything unparseable reads as 2,
// which is the param's first value and so its default.
double upscale_factor(const Op& op);

// What an export of this stack has to render at, as a multiple of the photo's native size:
// the product of every enabled `upscale` op that actually has a raster. An upscale the user
// has not run yet changes nothing, exactly like a generative op without its result
// (issue #52 — export must not resample a 4x raster back down to native).
double stack_upscale_factor(const Stack& stack);

// A rect normalised over the content rect, [0,1] in both axes, x0 < x1 and y0 < y1.
struct GenerativeRect {
  double x0 = 0;
  double y0 = 0;
  double x1 = 1;
  double y1 = 1;

  double width() const { return x1 - x0; }
  double height() const { return y1 - y0; }
  std::vector<double> to_vector() const { return {x0, y0, x1, y1}; }
};

std::optional<GenerativeRect> rect_from_json(const std::vector<double>& value);

// Where the mask actually is. `coverage` is one r8 raster `stride` bytes per row; the
// content rect inside it is what the bounds are normalised over. `padding` grows the box by
// that fraction of the content rect's long edge — a model needs context around the hole.
// std::nullopt when nothing in the rect is above half coverage.
struct MaskWindow {
  uint32_t stride = 0;
  uint32_t content_x = 0;
  uint32_t content_y = 0;
  uint32_t content_width = 0;
  uint32_t content_height = 0;
};

std::optional<GenerativeRect> mask_bounds(std::span<const uint8_t> coverage,
                                          const MaskWindow& window, double padding);

// The crop in pixels of a content rect `content_width` x `content_height`, snapped to a
// multiple of 8 — every latent diffusion model works in units of 8 pixels, and a size that
// is not one is silently rounded somewhere inside the graph. Never larger than the content
// rect, never smaller than 64.
struct CropBox {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

CropBox crop_box(const GenerativeRect& rect, uint32_t content_width, uint32_t content_height);

// The rect a CropBox actually covers, which is the one that goes into `Op.result_rect`:
// snapping to eight pixels moves the edges, and the composite has to put the result back
// where it was really taken from.
GenerativeRect rect_of(const CropBox& box, uint32_t content_width, uint32_t content_height);

// The view size whose content rect makes `rect` come out at `target` pixels on its long
// edge. Clamped so a hairline mask cannot ask for a 40k-pixel render.
uint32_t view_size_for_crop(const GenerativeRect& rect, uint32_t probe_size, uint32_t target);

}  // namespace latent

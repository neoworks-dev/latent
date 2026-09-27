// What the embedded `latent` module is allowed to do to the engine. Server implements it;
// the module never sees Server, so the Python bindings stay free of uWS and wgpu headers.
//
// THREADING: every method below must run on the server thread (it owns the GPU, the
// op-stack and the socket). Callers that are on another thread — the MCP server's uvicorn
// thread, above all — must wrap the call in run_on_server_thread(), which is where the
// hand-off is implemented and documented.
#pragma once

#include "ops/op.h"

#include <cstdint>

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

struct PhotoSummary {
  int64_t id = 0;
  std::string path;
  std::string filename;
  std::string camera;
  uint32_t width = 0;
  uint32_t height = 0;
};

// The part of the photo a preview zooms onto: image space, 0..1 over the uncropped photo,
// the space masks and the Assistant's selection use.
struct PreviewRegion {
  double x0 = 0;
  double y0 = 0;
  double x1 = 1;
  double y1 = 1;
};

class EngineApi {
 public:
  virtual ~EngineApi() = default;

  virtual bool on_server_thread() const = 0;
  // Runs `task` on the server thread and blocks until it has returned or thrown.
  virtual void run_on_server_thread(const std::function<void()>& task) = 0;

  virtual std::vector<PhotoSummary> open_photos() const = 0;
  virtual int64_t current_photo() const = 0;
  virtual PhotoSummary photo_summary(int64_t photo_id) const = 0;

  virtual Stack photo_stack(int64_t photo_id) const = 0;
  virtual void set_photo_stack(int64_t photo_id, Stack next, std::string_view source) = 0;
  // StackGetResult plus photoId, a histogram (rendering one if no view has) and clipping.
  virtual nlohmann::json agent_stack_state(int64_t photo_id) = 0;
  virtual bool undo(int64_t photo_id) = 0;
  virtual bool redo(int64_t photo_id) = 0;

  virtual std::vector<uint8_t> render_preview_jpeg(int64_t photo_id, uint32_t max_size,
                                                   std::optional<PreviewRegion> region) = 0;
  virtual nlohmann::json catalog_list(int limit) = 0;

  // `photo.masks.detect(op_id, component_id)`: starts the AI rasterisation of one
  // component and returns its jobId. The component is `pending` when this returns.
  virtual int64_t detect_mask(int64_t photo_id, const std::string& op_id,
                              const std::string& component_id) = 0;
  // `photo.estimate_depth()`: starts the monocular depth job and returns its jobId. Every
  // relight op on the photo starts rendering when it lands, and nothing re-runs on its own.
  virtual int64_t estimate_depth(int64_t photo_id) = 0;
  // Whether the photo has a depth map right now — `photo.has_depth`.
  virtual bool has_depth(int64_t photo_id) const = 0;
  // The op's combined mask as an 8-bit greyscale PNG, or one component's raster when
  // `component_id` is not empty. What MCP's render_preview(mask=...) hands an agent.
  virtual std::vector<uint8_t> render_mask_png(int64_t photo_id, const std::string& op_id,
                                               const std::string& component_id,
                                               uint32_t max_size) = 0;

  // `latent.export(...)`: validates export.run's params, queues the job and answers
  // `{ jobId, total, files }`. The files are not written yet when this returns — the job
  // reports through job.progress like every other one.
  virtual nlohmann::json start_export(const nlohmann::json& params) = 0;

  // `op.run()`: starts one generative op's job and returns its jobId. The op is untouched
  // until the job lands, and nothing here ever re-runs on its own (PROMPT.md 3.5).
  virtual int64_t run_generative(int64_t photo_id, const std::string& op_id) = 0;
  // `latent.generative.status()`: which backend is selected, whether ComfyUI is installed
  // and running, and which of the shipped graphs have their weights.
  virtual nlohmann::json generative_state() = 0;

  // `latent.merge.hdr(...)`: validates one merge.* call's params — `kind` picks which —
  // queues the job and answers `{ jobId }`. The merged photo's id arrives on the job's
  // last job.progress, not here, because the merge takes minutes.
  virtual nlohmann::json start_merge(const nlohmann::json& params) = 0;

  // Reaches the UI as engine.log, carrying photoId when the message is about one photo.
  virtual void warn(const std::string& message, int64_t photo_id) = 0;
};

}  // namespace latent

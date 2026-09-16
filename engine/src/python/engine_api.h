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

// Normalised crop of a preview, 0..1 of the image rect.
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

  // Reaches the UI as engine.log, carrying photoId when the message is about one photo.
  virtual void warn(const std::string& message, int64_t photo_id) = 0;
};

}  // namespace latent

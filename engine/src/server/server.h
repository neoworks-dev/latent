// The one socket the UI talks to: JSON-RPC 2.0 on text frames (protocol/messages.schema.json)
// and LFRM/LTHM binary frames on binary ones (protocol/frames.md).
//
// THREADING. The uWS loop thread is the server thread, and it owns the GPU, the op-stack
// and the catalog writes that matter. Two other kinds of thread exist:
//   - Worker: raw decodes, imports and thumbnail generation. It never touches engine state
//     directly; it posts results back with post() (uWS::Loop::defer).
//   - The MCP server's uvicorn thread, inside the embedded interpreter. It calls the
//     EngineApi methods below through run_on_server_thread(), which blocks it until the
//     server thread has run the work.
#pragma once

#include "ai/mask_detect.h"
#include "catalog/catalog.h"
#include "jobs/worker.h"
#include "ops/history.h"
#include "ops/mask.h"
#include "ops/op.h"
#include "pipeline/renderer.h"
#include "python/engine_api.h"
#include "python/interpreter.h"

#include <cstdint>

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>
#include <uwebsockets/App.h>

namespace latent {

// Carries a JSON-RPC error code out of a handler.
class RpcError : public std::runtime_error {
 public:
  RpcError(int code, const std::string& message) : std::runtime_error(message), code_(code) {}
  int code() const { return code_; }

 private:
  int code_;
};

struct ServerOptions {
  int port = 0;
  int mcp_port = 0;  // 0 = pick a free one
  bool enable_mcp = true;
  std::string catalog_path;        // empty = Catalog::default_path()
  std::string python_package_dir;  // empty = the compiled-in engine/python
};

class Server : public EngineApi {
 public:
  Server(Renderer& renderer, ServerOptions options);
  ~Server() override;
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  // Prints `listening on ws://127.0.0.1:<port>` once bound, then blocks until stopped.
  void run();

  // Safe to call from another thread; the loop closes its sockets and run() returns.
  void request_stop();

  // EngineApi: only valid on the server thread, see run_on_server_thread.
  bool on_server_thread() const override;
  void run_on_server_thread(const std::function<void()>& task) override;
  std::vector<PhotoSummary> open_photos() const override;
  int64_t current_photo() const override;
  PhotoSummary photo_summary(int64_t photo_id) const override;
  Stack photo_stack(int64_t photo_id) const override;
  void set_photo_stack(int64_t photo_id, Stack next, std::string_view source) override;
  nlohmann::json agent_stack_state(int64_t photo_id) override;
  bool undo(int64_t photo_id) override;
  bool redo(int64_t photo_id) override;
  std::vector<uint8_t> render_preview_jpeg(int64_t photo_id, uint32_t max_size,
                                           std::optional<PreviewRegion> region) override;
  nlohmann::json catalog_list(int limit) override;
  int64_t detect_mask(int64_t photo_id, const std::string& op_id,
                      const std::string& component_id) override;
  std::vector<uint8_t> render_mask_png(int64_t photo_id, const std::string& op_id,
                                       const std::string& component_id, uint32_t max_size) override;
  void warn(const std::string& message, int64_t photo_id) override;

 private:
  struct PerSocketData {};
  using Peer = uWS::WebSocket<false, true, PerSocketData>;

  // Where a reply goes once a handler that answered later is done.
  struct Responder {
    Peer* peer = nullptr;
    nlohmann::json id;
  };

  struct PhotoState {
    int64_t id = 0;
    std::string path;
    std::string sidecar_path;
    std::string hash;
    std::string camera;
    uint32_t width = 0;
    uint32_t height = 0;
    bool sidecar_loaded = false;
    History history;
  };

  struct ViewState {
    uint32_t id = 0;
    int64_t photo_id = 0;
    uint32_t seq = 0;
    bool has_frame = false;
    std::vector<uint8_t> frame;
  };

  struct OffscreenFrame {
    std::vector<uint8_t> rgba;
    ViewGeometry geometry;
  };

  void on_message(Peer* peer, std::string_view message);
  std::optional<nlohmann::json> dispatch(std::string_view method, const nlohmann::json& params,
                                         Peer* peer, const Responder& responder);

  nlohmann::json handle_hello(const nlohmann::json& params);
  std::optional<nlohmann::json> handle_photo_open(const nlohmann::json& params,
                                                  const Responder& responder);
  void finish_photo_open(const std::string& path, const std::shared_ptr<DecodedRaw>& raw,
                         const RawMetadata& metadata, const std::string& hash,
                         const Responder& responder);
  nlohmann::json photo_open_result(const PhotoState& photo);
  nlohmann::json handle_photo_close(const nlohmann::json& params);
  nlohmann::json handle_stack_get(const nlohmann::json& params);
  nlohmann::json handle_stack_set(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_op_add(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_op_update(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_op_remove(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_history(const nlohmann::json& params, bool redo, Peer* peer);
  nlohmann::json handle_view_open(const nlohmann::json& params);
  nlohmann::json handle_view_close(const nlohmann::json& params);
  nlohmann::json handle_view_render(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_python_run(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_catalog_import(const nlohmann::json& params);
  nlohmann::json handle_catalog_list(const nlohmann::json& params);
  nlohmann::json handle_catalog_get(const nlohmann::json& params);
  nlohmann::json handle_catalog_folders();
  nlohmann::json handle_catalog_set_rating(const nlohmann::json& params);
  nlohmann::json handle_catalog_set_flag(const nlohmann::json& params);
  nlohmann::json handle_catalog_collections();
  nlohmann::json handle_catalog_collection_set(const nlohmann::json& params);
  std::optional<nlohmann::json> handle_catalog_thumbnail(const nlohmann::json& params, Peer* peer,
                                                         const Responder& responder);
  std::optional<nlohmann::json> handle_catalog_thumbnails(const nlohmann::json& params, Peer* peer,
                                                          const Responder& responder);
  nlohmann::json handle_catalog_remove(const nlohmann::json& params);
  nlohmann::json handle_job_cancel(const nlohmann::json& params);
  nlohmann::json handle_mask_preview(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_mask_detect(const nlohmann::json& params, Peer* peer);
  nlohmann::json handle_mask_stroke(const nlohmann::json& params, Peer* peer);

  // One mask.detect run: renders the input on the server thread, detects on the worker,
  // and lands the raster back on the server thread as a stack.changed.
  int64_t start_mask_detect(PhotoState& photo, const std::string& op_id,
                            const std::string& component_id, const nlohmann::json& hint,
                            Peer* origin);
  void finish_mask_detect(int64_t photo_id, const std::string& op_id,
                          const std::string& component_id, int64_t job_id,
                          const MaskDetectResult& result);
  // Renders `op_id`'s mask into a view sized like `view_id`'s proxy (or a throwaway view
  // when it is 0) and sends the LMSK frame that precedes mask.preview's result.
  MaskReadout send_mask_frame(Peer* peer, PhotoState& photo, uint32_t view_id,
                              const std::string& op_id, const std::string& component_id,
                              std::vector<uint8_t>& frame);
  // The op `params.opId` names, or -32602 when it is unknown or carries no mask.
  static Op& require_masked_op(Stack& stack, const nlohmann::json& params);
  // Reloads the PNG cache of every AI component a freshly opened sidecar carries.
  void load_mask_rasters(const PhotoState& photo);

  // `thumbnail_job_id` was handed out with catalog.import's result, so the thumbnail job
  // always reports — with total 0 when the import found nothing or was cancelled.
  void import_job(int64_t job_id, int64_t thumbnail_job_id, const std::vector<std::string>& paths,
                  bool recursive);
  void thumbnail_job(int64_t job_id, int64_t parent_job_id, const std::vector<int64_t>& photo_ids);
  // A job is running from the moment it is queued until its `finished` progress goes out.
  void job_started(int64_t job_id);
  void job_finished(int64_t job_id);
  bool job_cancelled(int64_t job_id);
  void publish_progress(int64_t job_id, int64_t parent_job_id, std::string_view kind, int64_t done,
                        int64_t total, std::string_view state, const std::string& message,
                        const std::string& error = {});
  // Cache key for one row's thumbnails: the content hash when we have it, else the id.
  static std::string thumbnail_key(const CatalogPhoto& row);

  PhotoState& photo_for(const nlohmann::json& params);
  PhotoState& require_photo(int64_t photo_id);
  const PhotoState& require_photo(int64_t photo_id) const;
  ViewState& view_for(const nlohmann::json& params);
  CatalogPhoto require_row(int64_t photo_id);

  nlohmann::json stack_state(const PhotoState& photo);
  // `client` is the stack.changed label one step finer than `source` ("mcp:run_python");
  // empty means "same as source".
  void commit(PhotoState& photo, Stack next, bool transient, std::string_view source, Peer* origin,
              std::string_view client = {});
  void save_sidecar(PhotoState& photo);
  OffscreenFrame render_offscreen(int64_t photo_id, uint32_t max_size);

  // Sends `source` to the peer that caused the change and `external` to the others; a
  // change no socket caused (a script, an agent) keeps its own source everywhere. `client`
  // rides along the same way, defaulting to `source`.
  void broadcast_stack_changed(const PhotoState& photo, std::string_view source, Peer* origin,
                               std::string_view client = {});
  void broadcast(const nlohmann::json& notification);
  void notify_catalog_changed(const std::vector<int64_t>& photo_ids, std::string_view reason);
  void send_thumbnail(Peer* peer, int64_t photo_id, const std::vector<uint8_t>& jpeg,
                      uint32_t width, uint32_t height);
  void reply_result(const Responder& responder, const nlohmann::json& result);
  void reply_error(const Responder& responder, int code, const std::string& message);
  bool peer_alive(Peer* peer) const;

  // Runs `task` on the server thread later; drops it if the loop is already gone.
  void post(std::function<void()> task);

  void warn_all(const std::vector<std::string>& messages, int64_t photo_id);
  void stop_now();

  Renderer& renderer_;
  ServerOptions options_;
  // engine.hello's mcpUrl; empty with --no-mcp or when the SDK failed to load.
  std::string mcp_url_;
  us_listen_socket_t* listen_socket_ = nullptr;
  std::atomic<uWS::Loop*> loop_{nullptr};
  std::atomic<std::thread::id> server_thread_{};
  std::atomic<bool> stop_requested_{false};
  std::vector<Peer*> peers_;
  std::unordered_map<int64_t, PhotoState> photos_;
  std::unordered_map<uint32_t, ViewState> views_;
  int64_t last_opened_photo_ = 0;
  uint32_t next_view_id_ = 1;
  std::atomic<int64_t> next_job_id_{1};
  std::atomic<int64_t> next_run_id_{1};
  uint32_t thumbnail_seq_ = 0;
  // LMSK frames count per mask.preview call, independently of the LFRM stream.
  uint32_t mask_seq_ = 0;
  // Touched by the server thread (job.cancel) and the worker (its own loops).
  std::mutex jobs_mutex_;
  std::set<int64_t> running_jobs_;
  std::set<int64_t> cancelled_jobs_;
  Catalog catalog_;
  // The stub or the "model not installed" one, picked once at startup (ai/mask_detect.h).
  std::unique_ptr<MaskDetector> mask_detector_;
  Worker worker_;
  std::unique_ptr<PythonHost> python_;
};

}  // namespace latent

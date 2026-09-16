// The one socket the UI talks to: JSON-RPC 2.0 on text frames (protocol/messages.schema.json)
// and LFRM pixel frames on binary ones (protocol/frames.md). Single threaded — the uWS loop
// thread is also the GPU thread in Phase 0.
#pragma once

#include "ops/history.h"
#include "ops/op.h"
#include "pipeline/renderer.h"

#include <cstdint>

#include <atomic>
#include <string>
#include <string_view>
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

class Server {
 public:
  Server(Renderer& renderer, int port);
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  // Prints `listening on ws://127.0.0.1:<port>` once bound, then blocks until stopped.
  void run();

  // Safe to call from another thread; the loop closes its sockets and run() returns.
  void request_stop();

 private:
  struct PerSocketData {};
  using Peer = uWS::WebSocket<false, true, PerSocketData>;

  struct PhotoState {
    uint32_t id = 0;
    std::string path;
    std::string sidecar_path;
    std::string hash;
    std::string camera;
    uint32_t width = 0;
    uint32_t height = 0;
    History history;
  };

  struct ViewState {
    uint32_t id = 0;
    uint32_t photo_id = 0;
    uint32_t seq = 0;
    bool has_frame = false;
    std::vector<uint8_t> frame;
  };

  void on_message(Peer* peer, std::string_view message);
  nlohmann::json dispatch(std::string_view method, const nlohmann::json& params, Peer* peer);

  nlohmann::json handle_hello(const nlohmann::json& params);
  nlohmann::json handle_photo_open(const nlohmann::json& params);
  nlohmann::json handle_photo_close(const nlohmann::json& params);
  nlohmann::json handle_stack_get(const nlohmann::json& params);
  nlohmann::json handle_stack_set(const nlohmann::json& params);
  nlohmann::json handle_op_add(const nlohmann::json& params);
  nlohmann::json handle_op_update(const nlohmann::json& params);
  nlohmann::json handle_op_remove(const nlohmann::json& params);
  nlohmann::json handle_history(const nlohmann::json& params, bool redo);
  nlohmann::json handle_view_open(const nlohmann::json& params);
  nlohmann::json handle_view_close(const nlohmann::json& params);
  nlohmann::json handle_view_render(const nlohmann::json& params, Peer* peer);

  PhotoState& photo_for(const nlohmann::json& params);
  ViewState& view_for(const nlohmann::json& params);
  nlohmann::json stack_state(const PhotoState& photo);
  void commit(PhotoState& photo, Stack next, bool transient, std::string_view source);
  void save_sidecar(const PhotoState& photo);
  void broadcast(const nlohmann::json& notification);
  void warn(const std::string& message);
  void warn_all(const std::vector<std::string>& messages);
  void stop_now();

  Renderer& renderer_;
  int port_ = 0;
  us_listen_socket_t* listen_socket_ = nullptr;
  std::atomic<uWS::Loop*> loop_{nullptr};
  std::atomic<bool> stop_requested_{false};
  std::vector<Peer*> peers_;
  std::unordered_map<uint32_t, PhotoState> photos_;
  std::unordered_map<uint32_t, ViewState> views_;
  uint32_t next_photo_id_ = 1;
  uint32_t next_view_id_ = 1;
};

}  // namespace latent

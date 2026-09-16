#include "server/server.h"

#include "ops/registry.h"
#include "ops/sha256.h"
#include "ops/sidecar.h"
#include "pipeline/histogram.h"
#include "raw/raw_decode.h"

#include <cstdio>
#include <cstring>

#include <algorithm>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <utility>

namespace latent {

namespace {

constexpr int kProtocolVersion = 1;
constexpr std::string_view kEngineVersion = "0.1.0";
constexpr size_t kFrameHeaderBytes = 32;
constexpr int kInvalidParams = -32602;
constexpr int kMethodNotFound = -32601;
constexpr int kEngineFailure = -32000;

uint32_t require_id(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key)) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " is required");
  }
  const nlohmann::json& value = params[key];
  if (!value.is_number_integer() || value.get<int64_t>() < 1) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an integer >= 1");
  }
  return value.get<uint32_t>();
}

std::string require_string(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key) || !params[key].is_string()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be a string");
  }
  return params[key].get<std::string>();
}

uint32_t require_size(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key) || !params[key].is_number_integer()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an integer");
  }
  const int64_t value = params[key].get<int64_t>();
  if (value < 1 || value > 16384) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be between 1 and 16384");
  }
  return static_cast<uint32_t>(value);
}

bool optional_flag(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key)) return false;
  if (!params[key].is_boolean()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be a boolean");
  }
  return params[key].get<bool>();
}

const nlohmann::json& object_param(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key) || !params[key].is_object()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an object");
  }
  return params[key];
}

// Drops ops this engine does not know and normalises the rest, so a hand-edited sidecar
// or a script's stack.set can never put an unrenderable op in the truth.
Stack sanitize_stack(const Stack& input, std::vector<std::string>& warnings) {
  Stack out;
  out.reserve(input.size());
  for (const Op& op : input) {
    if (find_op_definition(op.name) == nullptr) {
      warnings.push_back("dropping unknown op '" + op.name + "'");
      continue;
    }
    Op copy = op;
    if (copy.id.empty()) copy.id = make_op_id();
    copy.params = normalize_params_for(copy.name, op.params, warnings);
    out.push_back(std::move(copy));
  }
  return out;
}

void write_frame_header(std::vector<uint8_t>& frame, uint32_t width, uint32_t height, uint32_t seq,
                        uint32_t view_id) {
  std::memcpy(frame.data(), "LFRM", 4);
  const uint32_t fields[5] = {width, height, seq, view_id, 0};
  std::memcpy(frame.data() + 4, fields, sizeof(fields));
  std::memset(frame.data() + 24, 0, 8);
}

}  // namespace

Server::Server(Renderer& renderer, int port) : renderer_(renderer), port_(port) {}

void Server::run() {
  loop_.store(uWS::Loop::get());
  uWS::App app;
  uWS::App::WebSocketBehavior<PerSocketData> behavior;
  behavior.compression = uWS::DISABLED;
  behavior.maxPayloadLength = 16 << 20;
  behavior.idleTimeout = 0;
  behavior.maxBackpressure = 256 << 20;
  behavior.open = [this](Peer* peer) { peers_.push_back(peer); };
  behavior.message = [this](Peer* peer, std::string_view message, uWS::OpCode opcode) {
    if (opcode != uWS::OpCode::TEXT) return;
    on_message(peer, message);
  };
  behavior.close = [this](Peer* peer, int, std::string_view) { std::erase(peers_, peer); };

  app.ws<PerSocketData>("/*", std::move(behavior));
  app.listen("127.0.0.1", port_, [this](us_listen_socket_t* token) { listen_socket_ = token; });
  if (listen_socket_ == nullptr) {
    throw std::runtime_error("cannot listen on 127.0.0.1:" + std::to_string(port_));
  }

  const int bound = us_socket_local_port(0, reinterpret_cast<us_socket_t*>(listen_socket_));
  std::printf("listening on ws://127.0.0.1:%d\n", bound);
  std::fflush(stdout);

  if (stop_requested_.load()) return;
  app.run();
}

void Server::request_stop() {
  stop_requested_.store(true);
  uWS::Loop* loop = loop_.load();
  if (loop == nullptr) return;
  loop->defer([this] { stop_now(); });
}

void Server::stop_now() {
  if (listen_socket_ != nullptr) {
    us_listen_socket_close(0, listen_socket_);
    listen_socket_ = nullptr;
  }
  const std::vector<Peer*> peers = peers_;
  for (Peer* peer : peers) {
    peer->end(1001, "latentd shutting down");
  }
}

void Server::on_message(Peer* peer, std::string_view message) {
  nlohmann::json request = nlohmann::json::parse(message, nullptr, false);
  nlohmann::json reply = {{"jsonrpc", "2.0"}, {"id", nullptr}};
  if (request.is_discarded() || !request.is_object()) {
    reply["error"] = {{"code", -32700}, {"message", "parse error: not a JSON object"}};
    peer->send(reply.dump(), uWS::OpCode::TEXT);
    return;
  }
  if (request.contains("id")) reply["id"] = request["id"];
  const std::string method = request.value("method", std::string());
  const nlohmann::json params = request.value("params", nlohmann::json::object());

  try {
    reply["result"] = dispatch(method, params, peer);
  } catch (const RpcError& error) {
    reply["error"] = {{"code", error.code()}, {"message", error.what()}};
  } catch (const OpError& error) {
    reply["error"] = {{"code", kInvalidParams}, {"message", error.what()}};
  } catch (const std::exception& error) {
    reply["error"] = {{"code", kEngineFailure}, {"message", error.what()}};
  }
  if (!request.contains("id")) return;
  peer->send(reply.dump(), uWS::OpCode::TEXT);
}

nlohmann::json Server::dispatch(std::string_view method, const nlohmann::json& params, Peer* peer) {
  if (method == "engine.hello") return handle_hello(params);
  if (method == "ops.describe") return describe_ops();
  if (method == "photo.open") return handle_photo_open(params);
  if (method == "photo.close") return handle_photo_close(params);
  if (method == "stack.get") return handle_stack_get(params);
  if (method == "stack.set") return handle_stack_set(params);
  if (method == "op.add") return handle_op_add(params);
  if (method == "op.update") return handle_op_update(params);
  if (method == "op.remove") return handle_op_remove(params);
  if (method == "history.undo") return handle_history(params, false);
  if (method == "history.redo") return handle_history(params, true);
  if (method == "view.open") return handle_view_open(params);
  if (method == "view.close") return handle_view_close(params);
  if (method == "view.render") return handle_view_render(params, peer);
  if (method == "python.run") throw RpcError(kMethodNotFound, "not implemented yet");
  throw RpcError(kMethodNotFound, "unknown method '" + std::string(method) + "'");
}

nlohmann::json Server::handle_hello(const nlohmann::json& params) {
  if (params.is_object() && params.contains("client") && !params["client"].is_string()) {
    throw RpcError(kInvalidParams, "params.client must be a string");
  }
  const GpuReport& gpu = renderer_.gpu_report();
  return {{"engineVersion", kEngineVersion},
          {"protocolVersion", kProtocolVersion},
          {"gpu",
           {{"adapter", gpu.adapter},
            {"maxTextureDimension2D", gpu.max_texture_dimension_2d},
            {"shaderF16", gpu.shader_f16}}}};
}

nlohmann::json Server::handle_photo_open(const nlohmann::json& params) {
  const std::string path = require_string(params, "path");
  if (!std::filesystem::is_regular_file(path)) {
    throw RpcError(kInvalidParams, "no such file: " + path);
  }
  for (const auto& [id, open] : photos_) {
    if (open.path != path) continue;
    return {
        {"photoId", id}, {"width", open.width}, {"height", open.height}, {"camera", open.camera}};
  }

  DecodedRaw raw = decode_raw(path);
  PhotoState photo;
  photo.id = next_photo_id_++;
  photo.path = path;
  photo.sidecar_path = sidecar_path_for(path);
  photo.hash = sha256_file_hex(path);
  photo.camera = raw.camera;
  photo.width = raw.width;
  photo.height = raw.height;
  renderer_.load_photo(photo.id, raw);

  std::vector<std::string> warnings;
  std::optional<Sidecar> sidecar;
  try {
    sidecar = read_sidecar(photo.sidecar_path);
  } catch (const std::exception& error) {
    warnings.emplace_back(std::string("ignoring sidecar: ") + error.what());
  }
  if (sidecar.has_value()) photo.history = History(sanitize_stack(sidecar->stack, warnings));

  const uint32_t photo_id = photo.id;
  photos_.emplace(photo_id, std::move(photo));
  warn_all(warnings);
  std::printf("photo %u %s %ux%u decoded in %.0f ms\n", photo_id, raw.camera.c_str(), raw.width,
              raw.height, raw.decode_ms);
  std::fflush(stdout);

  nlohmann::json changed = stack_state(photos_.at(photo_id));
  changed["photoId"] = photo_id;
  changed["source"] = "load";
  broadcast({{"jsonrpc", "2.0"}, {"method", "stack.changed"}, {"params", changed}});
  return {{"photoId", photo_id},
          {"width", photos_.at(photo_id).width},
          {"height", photos_.at(photo_id).height},
          {"camera", photos_.at(photo_id).camera}};
}

nlohmann::json Server::handle_photo_close(const nlohmann::json& params) {
  const PhotoState& photo = photo_for(params);
  const uint32_t photo_id = photo.id;
  for (auto entry = views_.begin(); entry != views_.end();) {
    if (entry->second.photo_id != photo_id) {
      ++entry;
    } else {
      entry = views_.erase(entry);
    }
  }
  renderer_.unload_photo(photo_id);
  photos_.erase(photo_id);
  return nlohmann::json::object();
}

nlohmann::json Server::handle_stack_get(const nlohmann::json& params) {
  return stack_state(photo_for(params));
}

nlohmann::json Server::handle_stack_set(const nlohmann::json& params) {
  PhotoState& photo = photo_for(params);
  if (!params.contains("stack")) throw RpcError(kInvalidParams, "params.stack is required");
  std::vector<std::string> warnings;
  Stack next = sanitize_stack(stack_from_json(params["stack"]), warnings);
  warn_all(warnings);
  commit(photo, std::move(next), false, "ui");
  return stack_state(photo);
}

nlohmann::json Server::handle_op_add(const nlohmann::json& params) {
  PhotoState& photo = photo_for(params);
  const std::string name = require_string(params, "op");
  const OpDefinition* definition = find_op_definition(name);
  if (definition == nullptr) throw RpcError(kInvalidParams, "unknown op '" + name + "'");

  std::vector<std::string> warnings;
  Op op;
  op.id = make_op_id();
  op.name = name;
  op.params = normalize_params(*definition, object_param(params, "params"), warnings);
  warn_all(warnings);

  Stack next = photo.history.current();
  size_t index = next.size();
  if (params.contains("index") && params["index"].is_number_integer()) {
    const int64_t requested = params["index"].get<int64_t>();
    index =
        static_cast<size_t>(std::clamp<int64_t>(requested, 0, static_cast<int64_t>(next.size())));
  }
  next.insert(next.begin() + static_cast<ptrdiff_t>(index), std::move(op));
  commit(photo, std::move(next), false, "ui");
  return stack_state(photo);
}

nlohmann::json Server::handle_op_update(const nlohmann::json& params) {
  PhotoState& photo = photo_for(params);
  const std::string op_id = require_string(params, "opId");
  Stack next = photo.history.current();
  Op* target = find_op(next, op_id);
  if (target == nullptr) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");

  const OpDefinition* definition = find_op_definition(target->name);
  if (definition == nullptr) {
    throw RpcError(kEngineFailure, "op '" + target->name + "' has no definition");
  }
  const nlohmann::json& update = object_param(params, "params");
  nlohmann::json merged = target->params;
  for (auto entry = update.begin(); entry != update.end(); ++entry) {
    merged[entry.key()] = entry.value();
  }
  std::vector<std::string> warnings;
  target->params = normalize_params(*definition, merged, warnings);
  if (params.contains("enabled")) target->enabled = optional_flag(params, "enabled");
  warn_all(warnings);

  commit(photo, std::move(next), optional_flag(params, "transient"), "ui");
  return stack_state(photo);
}

nlohmann::json Server::handle_op_remove(const nlohmann::json& params) {
  PhotoState& photo = photo_for(params);
  const std::string op_id = require_string(params, "opId");
  Stack next = photo.history.current();
  const auto found =
      std::find_if(next.begin(), next.end(), [&](const Op& op) { return op.id == op_id; });
  if (found == next.end()) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");
  next.erase(found);
  commit(photo, std::move(next), false, "ui");
  return stack_state(photo);
}

nlohmann::json Server::handle_history(const nlohmann::json& params, bool redo) {
  PhotoState& photo = photo_for(params);
  const bool moved = redo ? photo.history.redo() : photo.history.undo();
  nlohmann::json state = stack_state(photo);
  if (!moved) return state;
  save_sidecar(photo);
  nlohmann::json changed = state;
  changed["photoId"] = photo.id;
  changed["source"] = "history";
  broadcast({{"jsonrpc", "2.0"}, {"method", "stack.changed"}, {"params", changed}});
  return state;
}

nlohmann::json Server::handle_view_open(const nlohmann::json& params) {
  const PhotoState& photo = photo_for(params);
  ViewState view;
  view.id = next_view_id_++;
  view.photo_id = photo.id;
  renderer_.open_view(view.id, photo.id, require_size(params, "width"),
                      require_size(params, "height"));
  const uint32_t view_id = view.id;
  views_.emplace(view_id, std::move(view));
  return {{"viewId", view_id}};
}

nlohmann::json Server::handle_view_close(const nlohmann::json& params) {
  const ViewState& view = view_for(params);
  const uint32_t view_id = view.id;
  renderer_.close_view(view_id);
  views_.erase(view_id);
  return nlohmann::json::object();
}

nlohmann::json Server::handle_view_render(const nlohmann::json& params, Peer* peer) {
  ViewState& view = view_for(params);
  const auto found = photos_.find(view.photo_id);
  if (found == photos_.end()) throw RpcError(kEngineFailure, "view's photo is gone");
  if (params.contains("width") || params.contains("height")) {
    renderer_.resize_view(view.id, require_size(params, "width"), require_size(params, "height"));
  }

  const ViewGeometry geometry = renderer_.view_geometry(view.id);
  view.frame.resize(kFrameHeaderBytes + static_cast<size_t>(geometry.width) * geometry.height * 4);
  const RenderTiming timing =
      renderer_.render(view.id, found->second.history.current(), view.frame, kFrameHeaderBytes);
  ++view.seq;
  view.has_frame = true;
  write_frame_header(view.frame, geometry.width, geometry.height, view.seq, view.id);
  peer->send(std::string_view(reinterpret_cast<const char*>(view.frame.data()), view.frame.size()),
             uWS::OpCode::BINARY);
  return {{"seq", view.seq}, {"renderMs", timing.render_ms}, {"readbackMs", timing.readback_ms}};
}

Server::PhotoState& Server::photo_for(const nlohmann::json& params) {
  const uint32_t photo_id = require_id(params, "photoId");
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) {
    throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
  }
  return found->second;
}

Server::ViewState& Server::view_for(const nlohmann::json& params) {
  const uint32_t view_id = require_id(params, "viewId");
  const auto found = views_.find(view_id);
  if (found == views_.end()) {
    throw RpcError(kInvalidParams, "unknown viewId " + std::to_string(view_id));
  }
  return found->second;
}

nlohmann::json Server::stack_state(const PhotoState& photo) {
  nlohmann::json state = {{"stack", stack_to_json(photo.history.current())},
                          {"revision", photo.history.revision()},
                          {"canUndo", photo.history.can_undo()},
                          {"canRedo", photo.history.can_redo()}};
  for (const auto& [view_id, view] : views_) {
    if (view.photo_id != photo.id || !view.has_frame) continue;
    const ViewGeometry geometry = renderer_.view_geometry(view_id);
    const Histogram histogram = compute_histogram(
        std::span<const uint8_t>(view.frame).subspan(kFrameHeaderBytes), geometry.width,
        geometry.content_x, geometry.content_y, geometry.content_width, geometry.content_height);
    state["histogram"] = histogram_to_json(histogram);
    break;
  }
  return state;
}

void Server::commit(PhotoState& photo, Stack next, bool transient, std::string_view source) {
  if (transient) {
    photo.history.commit_transient(std::move(next));
  } else {
    photo.history.commit(std::move(next));
  }
  if (!transient) save_sidecar(photo);
  nlohmann::json changed = stack_state(photo);
  changed["photoId"] = photo.id;
  changed["source"] = source;
  broadcast({{"jsonrpc", "2.0"}, {"method", "stack.changed"}, {"params", changed}});
}

void Server::save_sidecar(const PhotoState& photo) {
  Sidecar sidecar;
  sidecar.source_path = photo.path;
  sidecar.source_hash = photo.hash;
  sidecar.stack = photo.history.current();
  try {
    write_sidecar(photo.sidecar_path, sidecar);
  } catch (const std::exception& error) {
    warn(std::string("sidecar not written: ") + error.what());
  }
}

void Server::broadcast(const nlohmann::json& notification) {
  const std::string text = notification.dump();
  for (Peer* peer : peers_) {
    peer->send(text, uWS::OpCode::TEXT);
  }
}

void Server::warn(const std::string& message) {
  std::fprintf(stderr, "[warn] %s\n", message.c_str());
  broadcast({{"jsonrpc", "2.0"},
             {"method", "engine.log"},
             {"params", {{"level", "warn"}, {"message", message}}}});
}

void Server::warn_all(const std::vector<std::string>& messages) {
  for (const std::string& message : messages) {
    warn(message);
  }
}

}  // namespace latent

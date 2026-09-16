#include "server/server.h"

#include "catalog/thumbnail.h"
#include "image/jpeg.h"
#include "ops/registry.h"
#include "ops/sha256.h"
#include "ops/sidecar.h"
#include "pipeline/histogram.h"
#include "raw/raw_decode.h"
#include "raw/raw_metadata.h"

#include <chrono>
#include <cstdio>
#include <cstring>

#include <algorithm>
#include <array>
#include <condition_variable>
#include <filesystem>
#include <mutex>
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
constexpr uint32_t kDefaultThumbnailSize = 256;
constexpr int kPreviewQuality = 88;
constexpr size_t kImportProgressEvery = 8;
constexpr int kDefaultScriptTimeoutMs = 30000;
// LTHM carries the photo id in a u32 (protocol/frames.md); a larger rowid cannot be
// tagged, so the request is refused instead of answered with a truncated frame.
constexpr int64_t kMaxThumbnailPhotoId = 0xFFFFFFFF;
constexpr std::array<std::string_view, 6> kNotificationNames = {
    "stack.changed", "engine.log",    "catalog.changed",
    "job.progress",  "python.output", "python.finished"};

int64_t require_id(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key)) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " is required");
  }
  const nlohmann::json& value = params[key];
  if (!value.is_number_integer() || value.get<int64_t>() < 1) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an integer >= 1");
  }
  return value.get<int64_t>();
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

bool optional_flag(const nlohmann::json& params, const char* key, bool fallback = false) {
  if (!params.is_object() || !params.contains(key)) return fallback;
  if (!params[key].is_boolean()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be a boolean");
  }
  return params[key].get<bool>();
}

int optional_int(const nlohmann::json& params, const char* key, int fallback) {
  if (!params.is_object() || !params.contains(key)) return fallback;
  if (!params[key].is_number_integer()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an integer");
  }
  return params[key].get<int>();
}

nlohmann::json object_param(const nlohmann::json& params, const char* key) {
  if (!params.is_object() || !params.contains(key) || params[key].is_null()) {
    return nlohmann::json::object();
  }
  if (!params[key].is_object()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an object");
  }
  return params[key];
}

std::vector<int64_t> id_array(const nlohmann::json& params, const char* key) {
  std::vector<int64_t> ids;
  if (!params.is_object() || !params.contains(key)) return ids;
  if (!params[key].is_array()) {
    throw RpcError(kInvalidParams, std::string("params.") + key + " must be an array");
  }
  for (const nlohmann::json& entry : params[key]) {
    if (!entry.is_number_integer()) {
      throw RpcError(kInvalidParams, std::string("params.") + key + " must hold integers");
    }
    ids.push_back(entry.get<int64_t>());
  }
  return ids;
}

// The frame's target field is a u32: an id that does not fit could only go out mislabelled.
void require_thumbnailable(int64_t photo_id) {
  if (photo_id <= kMaxThumbnailPhotoId) return;
  throw RpcError(kInvalidParams, "photoId " + std::to_string(photo_id) +
                                     " is above the thumbnail frame limit of " +
                                     std::to_string(kMaxThumbnailPhotoId));
}

std::string require_flag(const nlohmann::json& params, const char* key) {
  const std::string flag = require_string(params, key);
  if (flag != "none" && flag != "pick" && flag != "reject") {
    throw RpcError(kInvalidParams, "params.flag must be none, pick or reject");
  }
  return flag;
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

void write_frame_header(std::vector<uint8_t>& frame, const char* magic, uint32_t width,
                        uint32_t height, uint32_t seq, uint32_t target, uint32_t format) {
  std::memcpy(frame.data(), magic, 4);
  const uint32_t fields[5] = {width, height, seq, target, format};
  std::memcpy(frame.data() + 4, fields, sizeof(fields));
  std::memset(frame.data() + 24, 0, 8);
}

// `ui`, `history` and `load` describe one socket's own action; every other socket is told
// `external`. A script or an agent is nobody's action, so its source reaches everyone.
std::string_view source_for_peer(std::string_view source, bool is_origin) {
  if (is_origin) return source;
  // "mcp" and the finer client label "mcp:<tool>" are both nobody's own action.
  if (source == "python" || source.starts_with("mcp")) return source;
  return "external";
}

// One thumbnail the batch still has to decode, with everything the worker needs.
struct PendingThumbnail {
  int64_t photo_id = 0;
  std::string path;
  std::string cache;
};

std::vector<std::string> collect_raw_files(const std::vector<std::string>& paths, bool recursive) {
  std::vector<std::string> files;
  std::error_code error;
  for (const std::string& path : paths) {
    if (std::filesystem::is_regular_file(path, error)) {
      if (is_raw_extension(path)) files.push_back(path);
      continue;
    }
    if (!std::filesystem::is_directory(path, error)) continue;
    const auto options = std::filesystem::directory_options::skip_permission_denied;
    if (!recursive) {
      for (const auto& entry : std::filesystem::directory_iterator(path, options, error)) {
        if (entry.is_regular_file(error) && is_raw_extension(entry.path().string())) {
          files.push_back(entry.path().string());
        }
      }
      continue;
    }
    for (const auto& entry : std::filesystem::recursive_directory_iterator(path, options, error)) {
      if (entry.is_regular_file(error) && is_raw_extension(entry.path().string())) {
        files.push_back(entry.path().string());
      }
    }
  }
  std::sort(files.begin(), files.end());
  files.erase(std::unique(files.begin(), files.end()), files.end());
  return files;
}

}  // namespace

Server::Server(Renderer& renderer, ServerOptions options)
    : renderer_(renderer),
      options_(std::move(options)),
      catalog_(options_.catalog_path.empty() ? Catalog::default_path() : options_.catalog_path) {}

Server::~Server() {
  // The worker and the interpreter must stop reaching into the engine before it dies.
  if (python_) python_->detach();
}

void Server::run() {
  loop_.store(uWS::Loop::get());
  server_thread_.store(std::this_thread::get_id());
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
  app.listen("127.0.0.1", options_.port,
             [this](us_listen_socket_t* token) { listen_socket_ = token; });
  if (listen_socket_ == nullptr) {
    throw std::runtime_error("cannot listen on 127.0.0.1:" + std::to_string(options_.port));
  }

  const int bound = us_socket_local_port(0, reinterpret_cast<us_socket_t*>(listen_socket_));
  std::printf("listening on ws://127.0.0.1:%d\n", bound);
  std::printf("catalog %s\n", catalog_.path().c_str());
  std::fflush(stdout);

  const std::string package_dir = options_.python_package_dir.empty()
                                      ? std::string(LATENT_PYTHON_PACKAGE_DIR)
                                      : options_.python_package_dir;
  try {
    python_ = std::make_unique<PythonHost>(*this, package_dir);
  } catch (const std::exception& error) {
    std::fprintf(stderr, "[warn] python not available: %s\n", error.what());
  }
  if (python_ && options_.enable_mcp) {
    const int port = python_->start_mcp(options_.mcp_port);
    if (port > 0) {
      mcp_url_ = "http://127.0.0.1:" + std::to_string(port) + "/mcp";
      std::printf("mcp on %s\n", mcp_url_.c_str());
    }
    std::fflush(stdout);
  }

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

bool Server::on_server_thread() const {
  return server_thread_.load() == std::this_thread::get_id();
}

void Server::post(std::function<void()> task) {
  uWS::Loop* loop = loop_.load();
  if (loop == nullptr || stop_requested_.load()) return;
  loop->defer(std::move(task));
}

void Server::run_on_server_thread(const std::function<void()>& task) {
  if (on_server_thread()) {
    task();
    return;
  }
  uWS::Loop* loop = loop_.load();
  if (loop == nullptr || stop_requested_.load()) {
    throw std::runtime_error("engine is not accepting work");
  }
  std::mutex mutex;
  std::condition_variable done;
  bool finished = false;
  std::exception_ptr failure;
  loop->defer([&] {
    try {
      task();
    } catch (...) {
      failure = std::current_exception();
    }
    {
      const std::lock_guard<std::mutex> lock(mutex);
      finished = true;
    }
    done.notify_all();
  });
  {
    std::unique_lock<std::mutex> lock(mutex);
    // A bounded wait: if the loop died between the check above and the defer, a stuck MCP
    // thread would otherwise hold the request open forever.
    if (!done.wait_for(lock, std::chrono::seconds(120), [&] { return finished; })) {
      throw std::runtime_error("engine did not answer within 120 s");
    }
  }
  if (failure) std::rethrow_exception(failure);
}

void Server::on_message(Peer* peer, std::string_view message) {
  nlohmann::json request = nlohmann::json::parse(message, nullptr, false);
  if (request.is_discarded() || !request.is_object()) {
    const nlohmann::json reply = {{"jsonrpc", "2.0"},
                                  {"id", nullptr},
                                  {"error", {{"code", -32700}, {"message", "parse error"}}}};
    peer->send(reply.dump(), uWS::OpCode::TEXT);
    return;
  }
  Responder responder;
  responder.peer = peer;
  responder.id = request.contains("id") ? request["id"] : nlohmann::json();
  const std::string method = request.value("method", std::string());
  const nlohmann::json params = request.value("params", nlohmann::json::object());

  try {
    const std::optional<nlohmann::json> result = dispatch(method, params, peer, responder);
    if (!result.has_value()) return;  // the handler answers when its worker is done
    reply_result(responder, *result);
  } catch (const RpcError& error) {
    reply_error(responder, error.code(), error.what());
  } catch (const OpError& error) {
    reply_error(responder, kInvalidParams, error.what());
  } catch (const std::exception& error) {
    reply_error(responder, kEngineFailure, error.what());
  }
}

std::optional<nlohmann::json> Server::dispatch(std::string_view method,
                                               const nlohmann::json& params, Peer* peer,
                                               const Responder& responder) {
  if (std::find(kNotificationNames.begin(), kNotificationNames.end(), method) !=
      kNotificationNames.end()) {
    throw RpcError(kMethodNotFound,
                   "'" + std::string(method) + "' is a notification, not a method");
  }
  if (method == "engine.hello") return handle_hello(params);
  if (method == "ops.describe") return describe_ops();
  if (method == "photo.open") return handle_photo_open(params, responder);
  if (method == "photo.close") return handle_photo_close(params);
  if (method == "stack.get") return handle_stack_get(params);
  if (method == "stack.set") return handle_stack_set(params, peer);
  if (method == "op.add") return handle_op_add(params, peer);
  if (method == "op.update") return handle_op_update(params, peer);
  if (method == "op.remove") return handle_op_remove(params, peer);
  if (method == "history.undo") return handle_history(params, false, peer);
  if (method == "history.redo") return handle_history(params, true, peer);
  if (method == "view.open") return handle_view_open(params);
  if (method == "view.close") return handle_view_close(params);
  if (method == "view.render") return handle_view_render(params, peer);
  if (method == "python.run") return handle_python_run(params, peer);
  if (method == "catalog.import") return handle_catalog_import(params);
  if (method == "catalog.list") return handle_catalog_list(params);
  if (method == "catalog.get") return handle_catalog_get(params);
  if (method == "catalog.folders") return handle_catalog_folders();
  if (method == "catalog.setRating") return handle_catalog_set_rating(params);
  if (method == "catalog.setFlag") return handle_catalog_set_flag(params);
  if (method == "catalog.collections") return handle_catalog_collections();
  if (method == "catalog.collectionSet") return handle_catalog_collection_set(params);
  if (method == "catalog.thumbnail") return handle_catalog_thumbnail(params, peer, responder);
  if (method == "catalog.thumbnails") return handle_catalog_thumbnails(params, peer, responder);
  if (method == "catalog.remove") return handle_catalog_remove(params);
  if (method == "job.cancel") return handle_job_cancel(params);
  throw RpcError(kMethodNotFound, "unknown method '" + std::string(method) + "'");
}

nlohmann::json Server::handle_hello(const nlohmann::json& params) {
  if (params.is_object() && params.contains("client") && !params["client"].is_string()) {
    throw RpcError(kInvalidParams, "params.client must be a string");
  }
  const GpuReport& gpu = renderer_.gpu_report();
  nlohmann::json result = {{"engineVersion", kEngineVersion},
                           {"protocolVersion", kProtocolVersion},
                           {"catalogPath", catalog_.path()},
                           {"gpu",
                            {{"adapter", gpu.adapter},
                             {"maxTextureDimension2D", gpu.max_texture_dimension_2d},
                             {"shaderF16", gpu.shader_f16}}}};
  // Absent rather than empty when --no-mcp kept the server down: no url is not "".
  if (!mcp_url_.empty()) result["mcpUrl"] = mcp_url_;
  return result;
}

std::optional<nlohmann::json> Server::handle_photo_open(const nlohmann::json& params,
                                                        const Responder& responder) {
  const std::string path = require_string(params, "path");
  std::error_code error;
  const std::string resolved = std::filesystem::weakly_canonical(path, error).string();
  const std::string file = error ? path : resolved;
  if (!std::filesystem::is_regular_file(file)) {
    throw RpcError(kInvalidParams, "no such file: " + path);
  }
  for (const auto& [id, open] : photos_) {
    if (open.path == file) return photo_open_result(open);
  }

  // The decode is ~1.2 s for 24 MP: it belongs on the worker, and the upload it feeds has
  // to happen back on the server thread because that is where the GPU lives.
  worker_.submit([this, file, responder] {
    try {
      auto raw = std::make_shared<DecodedRaw>(decode_raw(file));
      const RawMetadata metadata = read_raw_metadata(file);
      const std::string hash = sha256_file_hex(file);
      post([this, file, raw, metadata, hash, responder] {
        finish_photo_open(file, raw, metadata, hash, responder);
      });
    } catch (const std::exception& failure) {
      const std::string message = failure.what();
      post([this, responder, message] { reply_error(responder, kEngineFailure, message); });
    }
  });
  return std::nullopt;
}

void Server::finish_photo_open(const std::string& path, const std::shared_ptr<DecodedRaw>& raw,
                               const RawMetadata& metadata, const std::string& hash,
                               const Responder& responder) {
  try {
    const std::string sidecar_file = sidecar_path_for(path);
    const bool has_sidecar = std::filesystem::exists(sidecar_file);
    const int64_t photo_id = catalog_.register_photo(path, metadata, has_sidecar);
    catalog_.set_hash(photo_id, hash);
    last_opened_photo_ = photo_id;
    if (photos_.contains(photo_id)) {
      // A second open of the same file raced us; the first one already owns the texture.
      reply_result(responder, photo_open_result(photos_.at(photo_id)));
      return;
    }

    PhotoState photo;
    photo.id = photo_id;
    photo.path = path;
    photo.sidecar_path = sidecar_file;
    photo.hash = hash;
    photo.camera = raw->camera;
    photo.width = raw->width;
    photo.height = raw->height;
    renderer_.load_photo(photo_id, *raw);

    std::vector<std::string> warnings;
    std::optional<Sidecar> sidecar;
    try {
      sidecar = read_sidecar(sidecar_file);
    } catch (const std::exception& failure) {
      warnings.emplace_back(std::string("ignoring sidecar: ") + failure.what());
    }
    if (sidecar.has_value()) {
      photo.history = History(sanitize_stack(sidecar->stack, warnings));
      photo.sidecar_loaded = true;
    }
    photos_.emplace(photo_id, std::move(photo));
    warn_all(warnings, photo_id);
    std::printf("photo %lld %s %ux%u decoded in %.0f ms\n", static_cast<long long>(photo_id),
                raw->camera.c_str(), raw->width, raw->height, raw->decode_ms);
    std::fflush(stdout);

    const PhotoState& opened = photos_.at(photo_id);
    broadcast_stack_changed(opened, "load", responder.peer);
    reply_result(responder, photo_open_result(opened));
  } catch (const std::exception& failure) {
    reply_error(responder, kEngineFailure, failure.what());
  }
}

nlohmann::json Server::photo_open_result(const PhotoState& photo) {
  nlohmann::json result = {{"photoId", photo.id},    {"width", photo.width},
                           {"height", photo.height}, {"camera", photo.camera},
                           {"hash", photo.hash},     {"sidecarLoaded", photo.sidecar_loaded}};
  // Opening catalogs the file, so the row rides along and the UI needs no catalog.get.
  const std::optional<CatalogPhoto> row = catalog_.get(photo.id);
  if (row.has_value()) result["catalog"] = row->to_json();
  return result;
}

nlohmann::json Server::handle_photo_close(const nlohmann::json& params) {
  const PhotoState& photo = photo_for(params);
  const int64_t photo_id = photo.id;
  for (auto entry = views_.begin(); entry != views_.end();) {
    if (entry->second.photo_id != photo_id) {
      ++entry;
    } else {
      entry = views_.erase(entry);
    }
  }
  renderer_.unload_photo(photo_id);
  photos_.erase(photo_id);
  if (last_opened_photo_ == photo_id) {
    last_opened_photo_ = photos_.empty() ? 0 : photos_.begin()->first;
  }
  return nlohmann::json::object();
}

nlohmann::json Server::handle_stack_get(const nlohmann::json& params) {
  return stack_state(photo_for(params));
}

nlohmann::json Server::handle_stack_set(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  if (!params.contains("stack")) throw RpcError(kInvalidParams, "params.stack is required");
  std::vector<std::string> warnings;
  Stack next = sanitize_stack(stack_from_json(params["stack"]), warnings);
  warn_all(warnings, photo.id);
  commit(photo, std::move(next), false, "ui", peer);
  return stack_state(photo);
}

nlohmann::json Server::handle_op_add(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  const std::string name = require_string(params, "op");
  const OpDefinition* definition = find_op_definition(name);
  if (definition == nullptr) throw RpcError(kInvalidParams, "unknown op '" + name + "'");

  std::vector<std::string> warnings;
  Op op;
  op.id = make_op_id();
  op.name = name;
  // params is optional: an op added without one lands at the registry defaults.
  op.params = normalize_params(*definition, object_param(params, "params"), warnings);
  warn_all(warnings, photo.id);

  Stack next = photo.history.current();
  size_t index = next.size();
  if (params.contains("index") && params["index"].is_number_integer()) {
    const int64_t requested = params["index"].get<int64_t>();
    index =
        static_cast<size_t>(std::clamp<int64_t>(requested, 0, static_cast<int64_t>(next.size())));
  }
  next.insert(next.begin() + static_cast<ptrdiff_t>(index), std::move(op));
  // transient, as on op.update: the op appears but no snapshot is taken, so a drag that
  // starts by creating the op is still one undo step.
  commit(photo, std::move(next), optional_flag(params, "transient"), "ui", peer);
  return stack_state(photo);
}

nlohmann::json Server::handle_op_update(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  const std::string op_id = require_string(params, "opId");
  Stack next = photo.history.current();
  Op* target = find_op(next, op_id);
  if (target == nullptr) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");

  const OpDefinition* definition = find_op_definition(target->name);
  if (definition == nullptr) {
    throw RpcError(kEngineFailure, "op '" + target->name + "' has no definition");
  }
  const nlohmann::json update = object_param(params, "params");
  nlohmann::json merged = target->params;
  for (auto entry = update.begin(); entry != update.end(); ++entry) {
    merged[entry.key()] = entry.value();
  }
  std::vector<std::string> warnings;
  target->params = normalize_params(*definition, merged, warnings);
  if (params.contains("enabled")) target->enabled = optional_flag(params, "enabled");
  warn_all(warnings, photo.id);

  commit(photo, std::move(next), optional_flag(params, "transient"), "ui", peer);
  return stack_state(photo);
}

nlohmann::json Server::handle_op_remove(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  const std::string op_id = require_string(params, "opId");
  Stack next = photo.history.current();
  const auto found =
      std::find_if(next.begin(), next.end(), [&](const Op& op) { return op.id == op_id; });
  if (found == next.end()) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");
  next.erase(found);
  commit(photo, std::move(next), false, "ui", peer);
  return stack_state(photo);
}

nlohmann::json Server::handle_history(const nlohmann::json& params, bool redo, Peer* peer) {
  PhotoState& photo = photo_for(params);
  const bool moved = redo ? photo.history.redo() : photo.history.undo();
  nlohmann::json state = stack_state(photo);
  if (!moved) return state;
  save_sidecar(photo);
  broadcast_stack_changed(photo, "history", peer);
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
  write_frame_header(view.frame, "LFRM", geometry.width, geometry.height, view.seq, view.id, 0);
  peer->send(std::string_view(reinterpret_cast<const char*>(view.frame.data()), view.frame.size()),
             uWS::OpCode::BINARY);
  // The revision the pixels came from, so a client that coalesced drags can tell whether
  // the frame it holds is the newest state or one render behind.
  return {{"seq", view.seq},
          {"width", geometry.width},
          {"height", geometry.height},
          {"renderMs", timing.render_ms},
          {"readbackMs", timing.readback_ms},
          {"revision", found->second.history.revision()}};
}

nlohmann::json Server::handle_python_run(const nlohmann::json& params, Peer* peer) {
  if (!python_) throw RpcError(kEngineFailure, "the embedded interpreter is not available");
  const std::string code = require_string(params, "code");
  int64_t photo_id = 0;
  if (params.contains("photoId")) {
    photo_id = require_id(params, "photoId");
    require_photo(photo_id);
  }
  const int timeout_ms = optional_int(params, "timeoutMs", kDefaultScriptTimeoutMs);
  if (timeout_ms < 1) throw RpcError(kInvalidParams, "params.timeoutMs must be >= 1");

  // The script runs on this thread, so its output can go straight out of this socket as it
  // is written; only the calling socket gets it (protocol/README.md, python.run).
  const int64_t run_id = next_run_id_++;
  const python_module::OutputSink sink = [this, peer, run_id](const std::string& stream,
                                                              const std::string& text) {
    if (!peer_alive(peer)) return;
    const nlohmann::json notification = {
        {"jsonrpc", "2.0"},
        {"method", "python.output"},
        {"params", {{"runId", run_id}, {"stream", stream}, {"text", text}}}};
    peer->send(notification.dump(), uWS::OpCode::TEXT);
  };

  // Scripts run on the server thread and block it (PROMPT.md 3.4): one writer, no locks.
  const auto started = std::chrono::steady_clock::now();
  const PythonRunResult result = python_->run(code, photo_id, timeout_ms, sink);
  const std::chrono::duration<double, std::milli> elapsed =
      std::chrono::steady_clock::now() - started;

  // After the last python.output and before the result: a console closes the stream on
  // this, without waiting for the reply (protocol/README.md, python.finished).
  if (peer_alive(peer)) {
    const nlohmann::json finished = {
        {"jsonrpc", "2.0"},
        {"method", "python.finished"},
        {"params", {{"runId", run_id}, {"durationMs", elapsed.count()}, {"ok", result.ok}}}};
    peer->send(finished.dump(), uWS::OpCode::TEXT);
  }

  nlohmann::json out = {{"ok", result.ok},
                        {"stdout", result.out},
                        {"stderr", result.err},
                        {"runId", run_id},
                        {"durationMs", elapsed.count()}};
  if (result.has_value) out["value"] = result.value;
  return out;
}

nlohmann::json Server::handle_catalog_import(const nlohmann::json& params) {
  if (!params.contains("paths") || !params["paths"].is_array() || params["paths"].empty()) {
    throw RpcError(kInvalidParams, "params.paths must be a non-empty array");
  }
  std::vector<std::string> paths;
  for (const nlohmann::json& entry : params["paths"]) {
    if (!entry.is_string()) throw RpcError(kInvalidParams, "params.paths must hold strings");
    paths.push_back(entry.get<std::string>());
  }
  const bool recursive = optional_flag(params, "recursive", true);
  const int64_t job_id = next_job_id_++;
  // Reserved here, not when the import ends, so the result can name both jobs and a client
  // can cancel the thumbnails before the import that feeds them is done.
  const int64_t thumbnail_job_id = next_job_id_++;
  job_started(job_id);
  job_started(thumbnail_job_id);
  worker_.submit([this, job_id, thumbnail_job_id, paths, recursive] {
    import_job(job_id, thumbnail_job_id, paths, recursive);
  });
  return {{"jobId", job_id}, {"thumbnailJobId", thumbnail_job_id}};
}

nlohmann::json Server::handle_catalog_list(const nlohmann::json& params) {
  CatalogQuery query;
  if (params.contains("folder")) query.folder = require_string(params, "folder");
  if (params.contains("collectionId")) query.collection_id = require_id(params, "collectionId");
  if (params.contains("photoIds")) query.photo_ids = id_array(params, "photoIds");
  if (params.contains("query")) query.query = require_string(params, "query");
  if (params.contains("flag")) query.flag = require_flag(params, "flag");
  if (params.contains("minRating")) query.min_rating = optional_int(params, "minRating", 0);
  if (params.contains("sort")) query.sort = require_string(params, "sort");
  query.descending = optional_flag(params, "descending");
  query.limit = optional_int(params, "limit", 0);
  query.offset = optional_int(params, "offset", 0);

  // An explicit empty photoIds list asks for exactly nothing, not for everything.
  if (params.contains("photoIds") && query.photo_ids.empty()) {
    return {{"photos", nlohmann::json::array()}, {"total", 0}};
  }
  const CatalogPage page = catalog_.list(query);
  nlohmann::json photos = nlohmann::json::array();
  for (const CatalogPhoto& photo : page.photos) {
    photos.push_back(photo.to_json());
  }
  return {{"photos", photos}, {"total", page.total}};
}

nlohmann::json Server::handle_catalog_get(const nlohmann::json& params) {
  return require_row(require_id(params, "photoId")).to_json();
}

nlohmann::json Server::handle_catalog_folders() {
  nlohmann::json folders = nlohmann::json::array();
  for (const CatalogFolder& folder : catalog_.folders()) {
    folders.push_back({{"path", folder.path}, {"count", folder.count}});
  }
  return {{"folders", folders}};
}

nlohmann::json Server::handle_catalog_set_rating(const nlohmann::json& params) {
  const int64_t photo_id = require_id(params, "photoId");
  const int rating = optional_int(params, "rating", -1);
  if (rating < 0 || rating > 5) throw RpcError(kInvalidParams, "params.rating must be 0..5");
  if (!catalog_.set_rating(photo_id, rating)) {
    throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
  }
  notify_catalog_changed({photo_id}, "rating");
  return require_row(photo_id).to_json();
}

nlohmann::json Server::handle_catalog_set_flag(const nlohmann::json& params) {
  const int64_t photo_id = require_id(params, "photoId");
  const std::string flag = require_flag(params, "flag");
  if (!catalog_.set_flag(photo_id, flag)) {
    throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
  }
  notify_catalog_changed({photo_id}, "flag");
  return require_row(photo_id).to_json();
}

nlohmann::json Server::handle_catalog_collections() {
  nlohmann::json collections = nlohmann::json::array();
  for (const CatalogCollection& collection : catalog_.collections()) {
    collections.push_back(
        {{"collectionId", collection.id}, {"name", collection.name}, {"count", collection.count}});
  }
  return {{"collections", collections}};
}

nlohmann::json Server::handle_catalog_collection_set(const nlohmann::json& params) {
  const bool has_id = params.contains("collectionId");
  const bool has_name = params.contains("name");
  if (!has_id && !has_name) {
    throw RpcError(kInvalidParams, "params needs collectionId, name, or both");
  }
  int64_t collection_id = has_id ? require_id(params, "collectionId") : 0;
  if (!has_id) collection_id = catalog_.create_collection(require_string(params, "name"));
  if (has_id && has_name) catalog_.rename_collection(collection_id, require_string(params, "name"));

  const std::vector<int64_t> add = id_array(params, "add");
  const std::vector<int64_t> remove = id_array(params, "remove");
  if (!add.empty()) catalog_.add_to_collection(collection_id, add);
  if (!remove.empty()) catalog_.remove_from_collection(collection_id, remove);
  if (optional_flag(params, "delete")) catalog_.delete_collection(collection_id);

  std::vector<int64_t> touched = add;
  touched.insert(touched.end(), remove.begin(), remove.end());
  notify_catalog_changed(touched, "collection");
  return handle_catalog_collections();
}

std::optional<nlohmann::json> Server::handle_catalog_thumbnail(const nlohmann::json& params,
                                                               Peer* peer,
                                                               const Responder& responder) {
  const int64_t photo_id = require_id(params, "photoId");
  require_thumbnailable(photo_id);
  const CatalogPhoto row = require_row(photo_id);
  const int requested = optional_int(params, "size", static_cast<int>(kDefaultThumbnailSize));
  if (requested < 32 || requested > 2048) {
    throw RpcError(kInvalidParams, "params.size must be between 32 and 2048");
  }
  const auto size = static_cast<uint32_t>(requested);
  const std::string cache = thumbnail_cache_path(thumbnail_key(row), size);

  const std::optional<Thumbnail> cached = read_cached_thumbnail(cache);
  if (cached.has_value()) {
    send_thumbnail(peer, photo_id, cached->jpeg, cached->width, cached->height);
    return nlohmann::json{
        {"photoId", photo_id}, {"width", cached->width}, {"height", cached->height}};
  }

  const std::string path = row.path;
  worker_.submit([this, photo_id, path, cache, size, responder] {
    try {
      const Thumbnail thumbnail = make_thumbnail(path, cache, size);
      post([this, photo_id, thumbnail, responder] {
        send_thumbnail(responder.peer, photo_id, thumbnail.jpeg, thumbnail.width, thumbnail.height);
        reply_result(
            responder,
            {{"photoId", photo_id}, {"width", thumbnail.width}, {"height", thumbnail.height}});
      });
    } catch (const std::exception& failure) {
      const std::string message = failure.what();
      post([this, responder, message] { reply_error(responder, kEngineFailure, message); });
    }
  });
  return std::nullopt;
}

std::optional<nlohmann::json> Server::handle_catalog_thumbnails(const nlohmann::json& params,
                                                                Peer* peer,
                                                                const Responder& responder) {
  std::vector<int64_t> photo_ids = id_array(params, "photoIds");
  // One unrepresentable id fails the whole call: it is a malformed request, not a photo
  // that failed to render, so it does not belong in `missing`.
  for (int64_t photo_id : photo_ids)
    require_thumbnailable(photo_id);
  std::sort(photo_ids.begin(), photo_ids.end());
  photo_ids.erase(std::unique(photo_ids.begin(), photo_ids.end()), photo_ids.end());
  const int requested = optional_int(params, "size", static_cast<int>(kDefaultThumbnailSize));
  if (requested < 32 || requested > 2048) {
    throw RpcError(kInvalidParams, "params.size must be between 32 and 2048");
  }
  const auto size = static_cast<uint32_t>(requested);
  const auto total = static_cast<int64_t>(photo_ids.size());

  // Cached ones go out now; the rest are decoded on the worker and the result waits for
  // them, so every frame of the batch is on the wire before it (frames.md).
  std::vector<int64_t> missing;
  std::vector<PendingThumbnail> pending;
  int64_t sent = 0;
  for (int64_t photo_id : photo_ids) {
    const std::optional<CatalogPhoto> row = catalog_.get(photo_id);
    if (!row.has_value()) {
      missing.push_back(photo_id);
      continue;
    }
    const std::string cache = thumbnail_cache_path(thumbnail_key(*row), size);
    const std::optional<Thumbnail> cached = read_cached_thumbnail(cache);
    if (!cached.has_value()) {
      pending.push_back({photo_id, row->path, cache});
      continue;
    }
    send_thumbnail(peer, photo_id, cached->jpeg, cached->width, cached->height);
    ++sent;
  }
  if (pending.empty()) {
    return nlohmann::json{{"requested", total}, {"sent", sent}, {"missing", missing}};
  }

  worker_.submit([this, pending, size, sent, total, missing, responder] {
    int64_t made = sent;
    std::vector<int64_t> failed = missing;
    for (const PendingThumbnail& entry : pending) {
      try {
        const Thumbnail thumbnail = make_thumbnail(entry.path, entry.cache, size);
        ++made;
        const int64_t photo_id = entry.photo_id;
        post([this, photo_id, thumbnail, responder] {
          send_thumbnail(responder.peer, photo_id, thumbnail.jpeg, thumbnail.width,
                         thumbnail.height);
        });
      } catch (const std::exception& error) {
        std::fprintf(stderr, "[warn] thumbnail failed for %s: %s\n", entry.path.c_str(),
                     error.what());
        failed.push_back(entry.photo_id);
      }
    }
    post([this, responder, total, made, failed] {
      reply_result(responder, {{"requested", total}, {"sent", made}, {"missing", failed}});
    });
  });
  return std::nullopt;
}

nlohmann::json Server::handle_catalog_remove(const nlohmann::json& params) {
  const std::vector<int64_t> photo_ids = id_array(params, "photoIds");
  std::vector<int64_t> removed;
  for (int64_t photo_id : photo_ids) {
    const std::optional<CatalogPhoto> row = catalog_.get(photo_id);
    if (!row.has_value()) continue;
    removed.push_back(photo_id);
    forget_thumbnails(thumbnail_key(*row));
    // An open photo whose row is gone would edit a catalog entry that no longer exists.
    if (!photos_.contains(photo_id)) continue;
    renderer_.unload_photo(photo_id);
    photos_.erase(photo_id);
    std::erase_if(views_,
                  [photo_id](const auto& entry) { return entry.second.photo_id == photo_id; });
  }
  const int count = catalog_.remove_photos(removed);
  if (last_opened_photo_ > 0 && !photos_.contains(last_opened_photo_)) {
    last_opened_photo_ = photos_.empty() ? 0 : photos_.begin()->first;
  }
  if (!removed.empty()) notify_catalog_changed(removed, "remove");
  return {{"removed", count}};
}

nlohmann::json Server::handle_job_cancel(const nlohmann::json& params) {
  const int64_t job_id = require_id(params, "jobId");
  const std::lock_guard<std::mutex> lock(jobs_mutex_);
  if (!running_jobs_.contains(job_id)) return {{"cancelled", false}};
  cancelled_jobs_.insert(job_id);
  return {{"cancelled", true}};
}

void Server::import_job(int64_t job_id, int64_t thumbnail_job_id,
                        const std::vector<std::string>& paths, bool recursive) {
  const std::vector<std::string> files = collect_raw_files(paths, recursive);
  const auto total = static_cast<int64_t>(files.size());
  publish_progress(job_id, 0, "import", 0, total, "running",
                   files.empty() ? "no raw files found" : "");

  std::vector<int64_t> imported;
  int64_t done = 0;
  bool cancelled = false;
  for (const std::string& file : files) {
    cancelled = worker_.stopping() || job_cancelled(job_id);
    if (cancelled) break;
    ++done;
    try {
      const bool has_sidecar = std::filesystem::exists(sidecar_path_for(file));
      imported.push_back(catalog_.register_photo(file, read_raw_metadata(file), has_sidecar));
    } catch (const std::exception& error) {
      std::fprintf(stderr, "[warn] import skipped %s: %s\n", file.c_str(), error.what());
    }
    if (done % kImportProgressEvery == 0) {
      publish_progress(job_id, 0, "import", done, total, "running", "");
    }
  }

  // Work already done stands: a cancelled import keeps the rows it registered.
  const std::vector<int64_t> photo_ids = imported;
  if (!photo_ids.empty()) post([this, photo_ids] { notify_catalog_changed(photo_ids, "import"); });
  publish_progress(job_id, 0, "import", done, total, cancelled ? "cancelled" : "done",
                   std::to_string(imported.size()) + " photos");
  job_finished(job_id);

  // catalog.import already named this job, so it reports either way: nothing to do after a
  // cancelled or empty import is a finished job over zero photos, not silence.
  const std::vector<int64_t> queued = cancelled ? std::vector<int64_t>() : imported;
  worker_.submit([this, thumbnail_job_id, job_id, queued] {
    thumbnail_job(thumbnail_job_id, job_id, queued);
  });
}

void Server::thumbnail_job(int64_t job_id, int64_t parent_job_id,
                           const std::vector<int64_t>& photo_ids) {
  const auto total = static_cast<int64_t>(photo_ids.size());
  int64_t done = 0;
  bool cancelled = false;
  for (int64_t photo_id : photo_ids) {
    cancelled = worker_.stopping() || job_cancelled(job_id);
    if (cancelled) break;
    ++done;
    const std::optional<CatalogPhoto> row = catalog_.get(photo_id);
    if (!row.has_value()) continue;
    const std::string cache = thumbnail_cache_path(thumbnail_key(*row), kDefaultThumbnailSize);
    try {
      if (!read_cached_thumbnail(cache).has_value()) {
        make_thumbnail(row->path, cache, kDefaultThumbnailSize);
      }
    } catch (const std::exception& error) {
      std::fprintf(stderr, "[warn] thumbnail failed for %s: %s\n", row->path.c_str(), error.what());
    }
    if (done % 4 == 0) {
      publish_progress(job_id, parent_job_id, "thumbnails", done, total, "running", "");
    }
  }
  publish_progress(job_id, parent_job_id, "thumbnails", done, total,
                   cancelled ? "cancelled" : "done", "");
  job_finished(job_id);
}

void Server::job_started(int64_t job_id) {
  const std::lock_guard<std::mutex> lock(jobs_mutex_);
  running_jobs_.insert(job_id);
}

void Server::job_finished(int64_t job_id) {
  const std::lock_guard<std::mutex> lock(jobs_mutex_);
  running_jobs_.erase(job_id);
  cancelled_jobs_.erase(job_id);
}

bool Server::job_cancelled(int64_t job_id) {
  const std::lock_guard<std::mutex> lock(jobs_mutex_);
  return cancelled_jobs_.contains(job_id);
}

void Server::publish_progress(int64_t job_id, int64_t parent_job_id, std::string_view kind,
                              int64_t done, int64_t total, std::string_view state,
                              const std::string& message) {
  nlohmann::json params = {{"jobId", job_id},
                           {"kind", kind},
                           {"done", done},
                           {"total", total},
                           {"finished", state != "running"},
                           {"state", state}};
  if (parent_job_id > 0) params["parentJobId"] = parent_job_id;
  if (!message.empty()) params["message"] = message;
  // Notifications always leave from the server thread, whoever produced the progress.
  post([this, params] {
    broadcast({{"jsonrpc", "2.0"}, {"method", "job.progress"}, {"params", params}});
  });
}

std::string Server::thumbnail_key(const CatalogPhoto& row) {
  if (!row.hash.empty()) return row.hash;
  return "id" + std::to_string(row.id);
}

Server::PhotoState& Server::photo_for(const nlohmann::json& params) {
  return require_photo(require_id(params, "photoId"));
}

Server::PhotoState& Server::require_photo(int64_t photo_id) {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) {
    throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
  }
  return found->second;
}

const Server::PhotoState& Server::require_photo(int64_t photo_id) const {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) {
    throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
  }
  return found->second;
}

Server::ViewState& Server::view_for(const nlohmann::json& params) {
  const auto view_id = static_cast<uint32_t>(require_id(params, "viewId"));
  const auto found = views_.find(view_id);
  if (found == views_.end()) {
    throw RpcError(kInvalidParams, "unknown viewId " + std::to_string(view_id));
  }
  return found->second;
}

CatalogPhoto Server::require_row(int64_t photo_id) {
  const std::optional<CatalogPhoto> row = catalog_.get(photo_id);
  if (!row.has_value()) {
    throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
  }
  return *row;
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

void Server::commit(PhotoState& photo, Stack next, bool transient, std::string_view source,
                    Peer* origin, std::string_view client) {
  if (transient) {
    photo.history.commit_transient(std::move(next));
  } else {
    photo.history.commit(std::move(next));
  }
  if (!transient) save_sidecar(photo);
  broadcast_stack_changed(photo, source, origin, client);
  if (transient) return;
  catalog_.touch_edited(photo.id, std::filesystem::exists(photo.sidecar_path));
  notify_catalog_changed({photo.id}, "edit");
}

void Server::save_sidecar(PhotoState& photo) {
  Sidecar sidecar;
  sidecar.source_path = photo.path;
  sidecar.source_hash = photo.hash;
  sidecar.stack = photo.history.current();
  try {
    write_sidecar(photo.sidecar_path, sidecar);
  } catch (const std::exception& error) {
    warn(std::string("sidecar not written: ") + error.what(), photo.id);
  }
}

Server::OffscreenFrame Server::render_offscreen(int64_t photo_id, uint32_t max_size) {
  const PhotoState& photo = require_photo(photo_id);
  const double aspect = static_cast<double>(photo.width) / std::max(1U, photo.height);
  uint32_t width = std::clamp(max_size, 32U, 4096U);
  auto height = std::max(1U, static_cast<uint32_t>(std::lround(width / aspect)));
  if (height > width) {
    height = std::clamp(max_size, 32U, 4096U);
    width = std::max(1U, static_cast<uint32_t>(std::lround(height * aspect)));
  }

  const uint32_t view_id = next_view_id_++;
  renderer_.open_view(view_id, photo_id, width, height);
  OffscreenFrame out;
  try {
    out.geometry = renderer_.view_geometry(view_id);
    out.rgba.resize(static_cast<size_t>(out.geometry.width) * out.geometry.height * 4);
    renderer_.render(view_id, photo.history.current(), out.rgba, 0);
  } catch (...) {
    renderer_.close_view(view_id);
    throw;
  }
  renderer_.close_view(view_id);
  return out;
}

void Server::broadcast_stack_changed(const PhotoState& photo, std::string_view source, Peer* origin,
                                     std::string_view client) {
  nlohmann::json params = stack_state(photo);
  params["photoId"] = photo.id;
  const std::string_view label = client.empty() ? source : client;
  for (Peer* peer : peers_) {
    if (peer == nullptr) continue;
    const bool is_origin = peer == origin;
    params["source"] = source_for_peer(source, is_origin);
    params["client"] = source_for_peer(label, is_origin);
    const nlohmann::json notification = {
        {"jsonrpc", "2.0"}, {"method", "stack.changed"}, {"params", params}};
    peer->send(notification.dump(), uWS::OpCode::TEXT);
  }
}

void Server::broadcast(const nlohmann::json& notification) {
  const std::string text = notification.dump();
  for (Peer* peer : peers_) {
    peer->send(text, uWS::OpCode::TEXT);
  }
}

void Server::notify_catalog_changed(const std::vector<int64_t>& photo_ids,
                                    std::string_view reason) {
  broadcast({{"jsonrpc", "2.0"},
             {"method", "catalog.changed"},
             {"params", {{"photoIds", photo_ids}, {"reason", reason}}}});
}

void Server::send_thumbnail(Peer* peer, int64_t photo_id, const std::vector<uint8_t>& jpeg,
                            uint32_t width, uint32_t height) {
  if (!peer_alive(peer)) return;
  std::vector<uint8_t> frame(kFrameHeaderBytes + jpeg.size());
  write_frame_header(frame, "LTHM", width, height, ++thumbnail_seq_,
                     static_cast<uint32_t>(photo_id), 1);
  std::memcpy(frame.data() + kFrameHeaderBytes, jpeg.data(), jpeg.size());
  peer->send(std::string_view(reinterpret_cast<const char*>(frame.data()), frame.size()),
             uWS::OpCode::BINARY);
}

void Server::reply_result(const Responder& responder, const nlohmann::json& result) {
  if (responder.id.is_null() || !peer_alive(responder.peer)) return;
  const nlohmann::json reply = {{"jsonrpc", "2.0"}, {"id", responder.id}, {"result", result}};
  responder.peer->send(reply.dump(), uWS::OpCode::TEXT);
}

void Server::reply_error(const Responder& responder, int code, const std::string& message) {
  if (responder.id.is_null() || !peer_alive(responder.peer)) return;
  const nlohmann::json reply = {
      {"jsonrpc", "2.0"}, {"id", responder.id}, {"error", {{"code", code}, {"message", message}}}};
  responder.peer->send(reply.dump(), uWS::OpCode::TEXT);
}

bool Server::peer_alive(Peer* peer) const {
  return peer != nullptr && std::find(peers_.begin(), peers_.end(), peer) != peers_.end();
}

void Server::warn(const std::string& message, int64_t photo_id) {
  std::fprintf(stderr, "[warn] %s\n", message.c_str());
  nlohmann::json params = {{"level", "warn"}, {"message", message}};
  if (photo_id > 0) params["photoId"] = photo_id;
  broadcast({{"jsonrpc", "2.0"}, {"method", "engine.log"}, {"params", params}});
}

void Server::warn_all(const std::vector<std::string>& messages, int64_t photo_id) {
  for (const std::string& message : messages) {
    warn(message, photo_id);
  }
}

std::vector<PhotoSummary> Server::open_photos() const {
  std::vector<PhotoSummary> out;
  out.reserve(photos_.size());
  for (const auto& [id, photo] : photos_) {
    out.push_back({id, photo.path, std::filesystem::path(photo.path).filename().string(),
                   photo.camera, photo.width, photo.height});
  }
  std::sort(out.begin(), out.end(),
            [](const PhotoSummary& left, const PhotoSummary& right) { return left.id < right.id; });
  return out;
}

int64_t Server::current_photo() const {
  if (last_opened_photo_ > 0) return last_opened_photo_;
  return photos_.empty() ? 0 : photos_.begin()->first;
}

PhotoSummary Server::photo_summary(int64_t photo_id) const {
  const PhotoState& photo = require_photo(photo_id);
  return {photo.id,     photo.path,  std::filesystem::path(photo.path).filename().string(),
          photo.camera, photo.width, photo.height};
}

Stack Server::photo_stack(int64_t photo_id) const {
  return require_photo(photo_id).history.current();
}

void Server::set_photo_stack(int64_t photo_id, Stack next, std::string_view source) {
  PhotoState& photo = require_photo(photo_id);
  std::vector<std::string> warnings;
  Stack sanitized = sanitize_stack(next, warnings);
  warn_all(warnings, photo_id);
  // Python hands over the client label ("mcp:run_python"); the wire's `source` is the part
  // before the colon, so stack.changed keeps its closed enum.
  const std::string_view client = source;
  const std::string_view kind = client.substr(0, client.find(':'));
  commit(photo, std::move(sanitized), false, kind, nullptr, client);
}

nlohmann::json Server::agent_stack_state(int64_t photo_id) {
  PhotoState& photo = require_photo(photo_id);
  nlohmann::json state = stack_state(photo);
  state["photoId"] = photo_id;
  if (state.contains("histogram")) return state;

  // An agent always gets a histogram (PROMPT.md 3.4), even when no UI view exists yet.
  const OffscreenFrame frame = render_offscreen(photo_id, 512);
  const Histogram histogram = compute_histogram(
      frame.rgba, frame.geometry.width, frame.geometry.content_x, frame.geometry.content_y,
      frame.geometry.content_width, frame.geometry.content_height);
  state["histogram"] = histogram_to_json(histogram);
  return state;
}

bool Server::undo(int64_t photo_id) {
  PhotoState& photo = require_photo(photo_id);
  if (!photo.history.undo()) return false;
  save_sidecar(photo);
  broadcast_stack_changed(photo, "history", nullptr);
  return true;
}

bool Server::redo(int64_t photo_id) {
  PhotoState& photo = require_photo(photo_id);
  if (!photo.history.redo()) return false;
  save_sidecar(photo);
  broadcast_stack_changed(photo, "history", nullptr);
  return true;
}

std::vector<uint8_t> Server::render_preview_jpeg(int64_t photo_id, uint32_t max_size,
                                                 std::optional<PreviewRegion> region) {
  const OffscreenFrame frame = render_offscreen(photo_id, max_size);
  const ViewGeometry& geometry = frame.geometry;
  uint32_t x = geometry.content_x;
  uint32_t y = geometry.content_y;
  uint32_t width = geometry.content_width;
  uint32_t height = geometry.content_height;
  if (region.has_value()) {
    const double x0 = std::clamp(region->x0, 0.0, 1.0);
    const double y0 = std::clamp(region->y0, 0.0, 1.0);
    const double x1 = std::clamp(region->x1, x0, 1.0);
    const double y1 = std::clamp(region->y1, y0, 1.0);
    x = geometry.content_x + static_cast<uint32_t>(x0 * width);
    y = geometry.content_y + static_cast<uint32_t>(y0 * height);
    width = std::max(1U, static_cast<uint32_t>((x1 - x0) * geometry.content_width));
    height = std::max(1U, static_cast<uint32_t>((y1 - y0) * geometry.content_height));
  }
  const Rgb8Image image = rgba_to_rgb(frame.rgba, geometry.width, x, y, width, height);
  return encode_jpeg(image, kPreviewQuality);
}

nlohmann::json Server::catalog_list(int limit) {
  CatalogQuery query;
  query.sort = "importedAt";
  query.descending = true;
  query.limit = limit;
  nlohmann::json photos = nlohmann::json::array();
  for (const CatalogPhoto& photo : catalog_.list(query).photos) {
    nlohmann::json entry = photo.to_json();
    entry["open"] = photos_.contains(photo.id);
    photos.push_back(entry);
  }
  return photos;
}

}  // namespace latent

#include "server/server.h"

#include "catalog/thumbnail.h"
#include "generative/generative.h"
#include "generative/image_io.h"
#include "image/jpeg.h"
#include "image/png.h"
#include "merge/frame_info.h"
#include "merge/merge.h"
#include "merge/source_image.h"
#include "ops/mask.h"
#include "ops/registry.h"
#include "ops/sha256.h"
#include "ops/sidecar.h"
#include "pipeline/histogram.h"
#include "raw/raw_decode.h"
#include "raw/raw_metadata.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <algorithm>
#include <array>
#include <condition_variable>
#include <filesystem>
#include <fstream>
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
// merge.preview's default long edge: big enough to judge a stitch, small enough that the
// whole preview comes out of the raws' embedded JPEGs.
constexpr int kMergePreviewLongEdge = 1024;
constexpr size_t kImportProgressEvery = 8;
constexpr int kDefaultScriptTimeoutMs = 30000;
// mask.preview without a viewId, and the input a detector is handed: both proxy sizes,
// both long-edge, both small enough that a detect never stalls the loop for long.
constexpr uint32_t kMaskPreviewSize = 1024;
constexpr uint32_t kMaskDetectInputSize = 1024;
// LTHM carries the photo id in a u32 (protocol/frames.md); a larger rowid cannot be
// tagged, so the request is refused instead of answered with a truncated frame.
constexpr int64_t kMaxThumbnailPhotoId = 0xFFFFFFFF;
// Exporting a photo nobody opened uploads it under an id no catalog rowid can be: rowids
// start at 1, so a negative one cannot collide with an open photo's texture.
constexpr int64_t kExportScratchPhotoId = -1;
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

double optional_opacity(const nlohmann::json& params, double fallback) {
  if (!params.is_object() || !params.contains("opacity") || params["opacity"].is_null()) {
    return fallback;
  }
  if (!params["opacity"].is_number()) {
    throw RpcError(kInvalidParams, "params.opacity must be a number");
  }
  const double opacity = params["opacity"].get<double>();
  if (opacity < 0 || opacity > kFullOpacity) {
    throw RpcError(kInvalidParams, "params.opacity must be between 0 and 100");
  }
  return opacity;
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

// [x, y, width, height] of the image inside the proxy, in proxy pixels — what both
// ViewRenderResult and MaskPreviewResult answer with. Mask component coordinates are
// normalised over this rect, so a client that assumed it was the whole frame draws its
// overlay in the wrong place as soon as crop or rotate changes the aspect.
nlohmann::json content_rect(const ViewGeometry& geometry) {
  return nlohmann::json::array(
      {geometry.content_x, geometry.content_y, geometry.content_width, geometry.content_height});
}

// `imageTransform`: image-normalised -> view pixel, row-major 3x3 applied to (x, y, 1)
// with a homogeneous divide. Projective rather than affine because the Transform sliders'
// keystone is, and it carries the viewport's zoom and pan as well, so one matrix takes a
// pointer to a mask coordinate and a mask coordinate back to a canvas pixel.
nlohmann::json image_transform(const GeometryMap& map) {
  return nlohmann::json(image_transform_wire(map));
}

// `view.render`'s optional viewport. Absent leaves the view where it was, which is what
// every client that does not zoom sends.
std::optional<Viewport> viewport_param(const nlohmann::json& params) {
  if (!params.contains("viewport") || params["viewport"].is_null()) return std::nullopt;
  if (!params["viewport"].is_object()) {
    throw RpcError(kInvalidParams, "params.viewport must be an object");
  }
  const nlohmann::json& given = params["viewport"];
  Viewport viewport;
  viewport.scale = given.value("scale", 1.0);
  if (!std::isfinite(viewport.scale) || viewport.scale < kMinViewportScale ||
      viewport.scale > kMaxViewportScale) {
    throw RpcError(kInvalidParams, "params.viewport.scale is out of range");
  }
  const bool has_centre = given.contains("centerX") && given.contains("centerY");
  viewport.center_x = given.value("centerX", 0.5);
  viewport.center_y = given.value("centerY", 0.5);
  if (!std::isfinite(viewport.center_x) || !std::isfinite(viewport.center_y)) {
    throw RpcError(kInvalidParams, "params.viewport centre must be finite");
  }
  // Fit is not a scale of 1 with a centre: it is "centre the image", which is what every
  // render did before the viewport existed and what Ctrl+0 goes back to.
  viewport.fit = !has_centre || viewport.scale <= kMinViewportScale;
  return viewport;
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
// or a script's stack.set can never put an unrenderable op in the truth. The same pass
// canonicalises masks: every component validated, defaults filled in, engine-owned fields
// (the stroke list, an AI raster's path) carried through untouched.
Stack sanitize_stack(const Stack& input, std::vector<std::string>& warnings) {
  Stack out;
  out.reserve(input.size());
  for (const Op& op : input) {
    const OpDefinition* definition = find_op_definition(op.name);
    if (definition == nullptr) {
      warnings.push_back("dropping unknown op '" + op.name + "'");
      continue;
    }
    Op copy = op;
    if (copy.id.empty()) copy.id = make_op_id();
    copy.params = normalize_params_for(copy.name, op.params, warnings);
    copy.opacity = std::clamp(copy.opacity, 0.0, kFullOpacity);
    if (copy.mask.has_value()) {
      if (!definition->maskable()) {
        // A geometry op moves pixels instead of changing them, so there is nothing for a
        // mask to blend into (PROMPT.md 3.7, ops.describe `maskable`).
        warnings.push_back("op '" + copy.name + "' is not maskable: its mask is ignored");
        copy.mask.reset();
      } else {
        copy.mask = normalize_mask(*copy.mask);
      }
    }
    out.push_back(std::move(copy));
  }
  return out;
}

// What mask.detect renders for the detector: every enabled op below `op_id`, minus the
// geometry ops. Without a geometry op the view's content rect is the whole frame, so the
// render is the uncropped photo and a detector's coordinates are image-normalised.
Stack detect_input_stack(const Stack& stack, std::string_view op_id) {
  Stack below;
  for (const Op& op : stack) {
    if (op.id == op_id) break;
    if (is_geometry_op(op.name)) continue;
    below.push_back(op);
  }
  return below;
}

// A component's raster cache key: its params, the model that produced it and the source
// image. A model change or a re-edited photo reads as a different raster, which is what
// makes `stale` mean something (PROMPT.md 3.7).
std::string detect_raster_hash(const MaskComponent& component, const std::string& model,
                               const std::string& source_hash) {
  const std::string text = component.params.dump() + "|" +
                           std::string(mask_kind_name(component.kind)) + "|" + model + "|" +
                           source_hash;
  return sha256_hex({reinterpret_cast<const uint8_t*>(text.data()), text.size()});
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

// `make_thumbnail` reads the file through LibRaw, and LibRaw refuses a Photo Merge result
// (merge/source_image.h). This is the same job for either kind of source.
Thumbnail make_any_thumbnail(const std::string& path, const std::string& cache, uint32_t size) {
  if (!is_source_tiff(path)) return make_thumbnail(path, cache, size);

  const SourceMetadata source = read_source_metadata(path);
  const Rgb8Image image = box_resize_to_fit(
      linear_to_srgb(to_linear(decode_raw(path)), static_cast<float>(source.scale)), size);
  Thumbnail thumbnail;
  thumbnail.width = image.width;
  thumbnail.height = image.height;
  thumbnail.jpeg = encode_jpeg(image, kPreviewQuality);

  std::error_code error;
  std::filesystem::create_directories(std::filesystem::path(cache).parent_path(), error);
  std::ofstream file(cache, std::ios::binary | std::ios::trunc);
  // An unwritable cache is not worth failing the request for, same as make_thumbnail.
  if (file) {
    file.write(reinterpret_cast<const char*>(thumbnail.jpeg.data()),
               static_cast<std::streamsize>(thumbnail.jpeg.size()));
  }
  return thumbnail;
}

}  // namespace

Server::Server(Renderer& renderer, ServerOptions options)
    : renderer_(renderer),
      options_(std::move(options)),
      catalog_(options_.catalog_path.empty() ? Catalog::default_path() : options_.catalog_path),
      mask_detector_(make_mask_detector()) {}

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

  // The one HTTP route the daemon serves: the PNG a merge.preview job just wrote. A
  // renderer loaded from http://localhost cannot read file://, and a preview is a picture
  // nobody should pay a new binary frame type for, so it is fetched over this listener.
  app.get("/preview/:name", [this](uWS::HttpResponse<false>* response, uWS::HttpRequest* request) {
    serve_preview(response, request->getParameter("name"));
  });
  app.ws<PerSocketData>("/*", std::move(behavior));
  app.listen("127.0.0.1", options_.port,
             [this](us_listen_socket_t* token) { listen_socket_ = token; });
  if (listen_socket_ == nullptr) {
    throw std::runtime_error("cannot listen on 127.0.0.1:" + std::to_string(options_.port));
  }

  const int bound = us_socket_local_port(0, reinterpret_cast<us_socket_t*>(listen_socket_));
  // Merge previews answer with an absolute URL, so the port has to outlive this scope.
  bound_port_ = bound;
  std::printf("listening on ws://127.0.0.1:%d\n", bound);
  std::printf("catalog %s\n", catalog_.path().c_str());
  std::fflush(stdout);

  // Flag, then environment (a packaged build's AppRun sets it), then the build tree.
  const char* package_dir_env = std::getenv("LATENT_PYTHON_PACKAGE_DIR");
  std::string package_dir = options_.python_package_dir;
  if (package_dir.empty() && package_dir_env != nullptr) package_dir = package_dir_env;
  if (package_dir.empty()) package_dir = LATENT_PYTHON_PACKAGE_DIR;
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
  if (method == "merge.hdr") return handle_merge(MergeKind::Hdr, params, false);
  if (method == "merge.panorama") return handle_merge(MergeKind::Panorama, params, false);
  if (method == "merge.hdrPanorama") return handle_merge(MergeKind::HdrPanorama, params, false);
  if (method == "merge.preview") return handle_merge(merge_kind_from_params(params), params, true);
  if (method == "mask.preview") return handle_mask_preview(params, peer);
  if (method == "mask.detect") return handle_mask_detect(params, peer);
  if (method == "generative.run") return handle_generative_run(params);
  if (method == "generative.status") return handle_generative_status(responder);
  if (method == "mask.stroke") return handle_mask_stroke(params, peer);
  if (method == "export.run") return handle_export_run(params);
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
      // A Photo Merge result is not a raw and LibRaw will not open it; its row comes from
      // the sidecar the merge wrote (merge/source_image.h).
      const RawMetadata metadata =
          is_source_tiff(file) ? read_source_row(file) : read_raw_metadata(file);
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
      // Masks written before image space name no space and hold content-rect coordinates.
      // This is the one place that knows both the stack's geometry and the photo's size,
      // so it is where they are converted; the next save writes them back as `image`.
      migrate_mask_space(sidecar->stack, photo.width, photo.height);
      photo.history = History(sanitize_stack(sidecar->stack, warnings));
      photo.sidecar_loaded = true;
    }
    photos_.emplace(photo_id, std::move(photo));
    warn_all(warnings, photo_id);
    std::printf("photo %lld %s %ux%u decoded in %.0f ms\n", static_cast<long long>(photo_id),
                raw->camera.c_str(), raw->width, raw->height, raw->decode_ms);
    std::fflush(stdout);

    const PhotoState& opened = photos_.at(photo_id);
    // The sidecar names AI rasters by path; without them a `ready` component would render
    // as "select everything" instead of what the model found.
    load_mask_rasters(opened);
    // Same rule for a generative op: without its cached PNG it would render as if the fill
    // had never happened, which is worse than showing a stale one.
    load_generative_results(opened);
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
  if (params.contains("mask") && !params["mask"].is_null()) op.mask = params["mask"];
  op.opacity = optional_opacity(params, kFullOpacity);
  // sanitize_stack validates the mask and drops it when the op is a geometry op.
  Stack single = sanitize_stack({op}, warnings);
  op = single.front();
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
  // A full replacement, never a merge: a mask is a list, and merging two lists by index
  // is not a thing a caller could reason about. `null` clears it.
  if (params.contains("mask")) {
    if (params["mask"].is_null()) {
      target->mask.reset();
    } else if (!definition->maskable()) {
      warnings.push_back("op '" + target->name + "' is not maskable: its mask is ignored");
    } else {
      target->mask = normalize_mask(params["mask"]);
    }
  }
  if (params.contains("opacity")) target->opacity = optional_opacity(params, target->opacity);
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

  // `geometry: "full"` is the crop tool's frame: the whole image, the crop op's rect and
  // straighten bypassed. Anything else than the two declared words is a bad request.
  bool bypass_crop = false;
  if (params.contains("geometry") && !params["geometry"].is_null()) {
    const std::string mode = require_string(params, "geometry");
    if (mode != "stack" && mode != "full") {
      throw RpcError(kInvalidParams, "params.geometry must be 'stack' or 'full'");
    }
    bypass_crop = mode == "full";
  }

  const std::optional<Viewport> viewport = viewport_param(params);
  if (viewport) renderer_.set_viewport(view.id, *viewport);

  ViewGeometry geometry = renderer_.view_geometry(view.id);
  view.frame.resize(kFrameHeaderBytes + static_cast<size_t>(geometry.width) * geometry.height * 4);
  const RenderTiming timing = renderer_.render(view.id, found->second.history.current(), view.frame,
                                               kFrameHeaderBytes, bypass_crop);
  // The render is what resolves the geometry — a crop edit or the bypass changes the image
  // rect inside the frame — so the rect goes out after it, never the one from before.
  geometry = renderer_.view_geometry(view.id);
  ++view.seq;
  view.has_frame = true;
  write_frame_header(view.frame, "LFRM", geometry.width, geometry.height, view.seq, view.id, 0);
  peer->send(std::string_view(reinterpret_cast<const char*>(view.frame.data()), view.frame.size()),
             uWS::OpCode::BINARY);
  // The revision the pixels came from, so a client that coalesced drags can tell whether
  // the frame it holds is the newest state or one render behind. `contentRect` is where
  // the image sits inside that frame: crop and rotate change its aspect, so the letterbox
  // is not something the client can derive from the photo's own size.
  const Viewport resolved = renderer_.view_viewport(view.id);
  return {{"seq", view.seq},
          {"width", geometry.width},
          {"height", geometry.height},
          {"contentRect", content_rect(geometry)},
          {"imageTransform", image_transform(renderer_.view_map(view.id))},
          {"viewport",
           {{"scale", resolved.scale},
            {"centerX", resolved.center_x},
            {"centerY", resolved.center_y},
            {"fit", resolved.fit}}},
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
      const Thumbnail thumbnail = make_any_thumbnail(path, cache, size);
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
        const Thumbnail thumbnail = make_any_thumbnail(entry.path, entry.cache, size);
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

Op& Server::require_masked_op(Stack& stack, const nlohmann::json& params) {
  const std::string op_id = require_string(params, "opId");
  Op* op = find_op(stack, op_id);
  if (op == nullptr) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");
  if (!op->mask.has_value() || !op->mask->contains("components") ||
      (*op->mask)["components"].empty()) {
    throw RpcError(kInvalidParams, "op '" + op_id + "' has no mask");
  }
  return *op;
}

nlohmann::json Server::handle_mask_preview(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  Stack stack = photo.history.current();
  const Op& op = require_masked_op(stack, params);
  const std::string op_id = op.id;

  std::string component_id;
  if (params.contains("componentId") && !params["componentId"].is_null()) {
    component_id = require_string(params, "componentId");
    const Mask mask = mask_from_json(*op.mask);
    const MaskComponent* component = find_component(mask, component_id);
    if (component == nullptr) {
      throw RpcError(kInvalidParams, "unknown componentId '" + component_id + "'");
    }
    // A component nobody has rasterised yet has no raster to hand out; it is not an empty
    // one (protocol MaskPreviewResult).
    if (!component->contributes()) {
      throw RpcError(kInvalidParams, "component '" + component_id + "' is " +
                                         std::string(mask_state_name(component->state)));
    }
    if (mask_kind_is_ai(component->kind) &&
        !renderer_.has_mask_raster(photo.id, component_id,
                                   component->params.value("raster", std::string()))) {
      throw RpcError(kInvalidParams, "component '" + component_id + "' has no cached raster");
    }
  }

  uint32_t view_id = 0;
  if (params.contains("viewId") && !params["viewId"].is_null()) {
    const ViewState& view = view_for(params);
    if (view.photo_id != photo.id) {
      throw RpcError(kInvalidParams, "viewId belongs to another photo");
    }
    view_id = view.id;
  }

  std::vector<uint8_t> frame;
  ViewGeometry geometry;
  GeometryMap map;
  const MaskReadout readout =
      send_mask_frame(peer, photo, view_id, op_id, component_id, frame, geometry, map);
  // The raster is view-space — it is what the overlay blits — but the component's own
  // coordinates are image-space, so the matrix goes out beside the rect.
  return {{"width", readout.width},
          {"height", readout.height},
          {"contentRect", content_rect(geometry)},
          {"imageTransform", image_transform(map)},
          {"coverage", readout.coverage}};
}

MaskReadout Server::send_mask_frame(Peer* peer, PhotoState& photo, uint32_t view_id,
                                    const std::string& op_id, const std::string& component_id,
                                    std::vector<uint8_t>& frame, ViewGeometry& geometry,
                                    GeometryMap& map) {
  uint32_t target = view_id;
  const bool temporary = target == 0;
  if (temporary) {
    // No view open yet: an overlay-sized throwaway, the same shape render_offscreen uses.
    const double aspect = static_cast<double>(photo.width) / std::max(1U, photo.height);
    uint32_t width = kMaskPreviewSize;
    auto height = std::max(1U, static_cast<uint32_t>(std::lround(width / aspect)));
    if (height > width) {
      height = kMaskPreviewSize;
      width = std::max(1U, static_cast<uint32_t>(std::lround(height * aspect)));
    }
    target = next_view_id_++;
    renderer_.open_view(target, photo.id, width, height);
  }

  MaskReadout readout;
  try {
    geometry = renderer_.view_geometry(target);
    frame.assign(kFrameHeaderBytes + (static_cast<size_t>(geometry.width) * geometry.height), 0);
    readout = renderer_.read_mask(target, photo.history.current(), op_id, component_id, frame,
                                  kFrameHeaderBytes);
    // After the read: it is the render inside it that resolves the stage.
    geometry = renderer_.view_geometry(target);
    map = renderer_.view_map(target);
  } catch (...) {
    if (temporary) renderer_.close_view(target);
    throw;
  }
  if (temporary) renderer_.close_view(target);

  // format 2 = r8, and the target field carries the view the raster was sized for — 0
  // when the caller named none (protocol/frames.md, LMSK).
  write_frame_header(frame, "LMSK", readout.width, readout.height, ++mask_seq_, view_id, 2);
  if (peer_alive(peer)) {
    peer->send(std::string_view(reinterpret_cast<const char*>(frame.data()), frame.size()),
               uWS::OpCode::BINARY);
  }
  return readout;
}

nlohmann::json Server::handle_mask_detect(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  const std::string op_id = require_string(params, "opId");
  const std::string component_id = require_string(params, "componentId");
  const nlohmann::json hint = object_param(params, "hint");
  return {{"jobId", start_mask_detect(photo, op_id, component_id, hint, peer)}};
}

int64_t Server::start_mask_detect(PhotoState& photo, const std::string& op_id,
                                  const std::string& component_id, const nlohmann::json& hint,
                                  Peer* origin) {
  Stack next = photo.history.current();
  Op* op = find_op(next, op_id);
  if (op == nullptr) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");
  if (!op->mask.has_value()) throw RpcError(kInvalidParams, "op '" + op_id + "' has no mask");
  Mask mask = mask_from_json(*op->mask);
  MaskComponent* component = find_component(mask, component_id);
  if (component == nullptr) {
    throw RpcError(kInvalidParams, "unknown componentId '" + component_id + "'");
  }
  if (!mask_kind_is_ai(component->kind)) {
    throw RpcError(kInvalidParams, "component kind '" +
                                       std::string(mask_kind_name(component->kind)) +
                                       "' rasterises inline, not through mask.detect");
  }

  const int64_t job_id = next_job_id_++;
  for (auto entry = hint.begin(); entry != hint.end(); ++entry) {
    component->params[entry.key()] = entry.value();
  }
  component->params.erase("error");
  component->state = MaskState::Pending;
  component->job_id = job_id;

  MaskDetectRequest request;
  request.kind = component->kind;
  request.params = component->params;
  op->mask = mask_to_json(mask);
  // Taken before the commit below moves `next` out from under us.
  const Stack input_stack = detect_input_stack(next, op_id);
  // Engine bookkeeping, not a user edit: pending replaces the current snapshot instead of
  // costing an undo step. The result below commits for real, so it reaches the sidecar.
  commit(photo, std::move(next), true, "ui", origin);

  // What the detector sees: the stack *below* this op, with every geometry op dropped, so
  // the boxes and points it answers with are already in the image space the mask is stored
  // in. Rendering the cropped picture instead would put a subject's box at the wrong place
  // the moment the crop moved.
  try {
    const OffscreenFrame input = render_offscreen(photo.id, kMaskDetectInputSize, input_stack);
    request.image = rgba_to_rgb(input.rgba, input.geometry.width, input.geometry.content_x,
                                input.geometry.content_y, input.geometry.content_width,
                                input.geometry.content_height);
  } catch (const std::exception& error) {
    warn(std::string("mask.detect could not render its input: ") + error.what(), photo.id);
  }

  job_started(job_id);
  publish_progress(job_id, 0, "mask", 0, 1, "running", std::string(mask_kind_name(request.kind)));
  const int64_t photo_id = photo.id;
  MaskDetector* detector = mask_detector_.get();
  worker_.submit([this, detector, request, photo_id, op_id, component_id, job_id] {
    MaskDetectResult result;
    try {
      result = detector->detect(request);
    } catch (const std::exception& error) {
      result.ok = false;
      result.message = error.what();
    }
    post([this, photo_id, op_id, component_id, job_id, result] {
      finish_mask_detect(photo_id, op_id, component_id, job_id, result);
    });
  });
  return job_id;
}

void Server::finish_mask_detect(int64_t photo_id, const std::string& op_id,
                                const std::string& component_id, int64_t job_id,
                                const MaskDetectResult& result) {
  job_finished(job_id);
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) {
    publish_progress(job_id, 0, "mask", 1, 1, "cancelled", "photo closed");
    return;
  }
  PhotoState& photo = found->second;
  Stack next = photo.history.current();
  Op* op = find_op(next, op_id);
  if (op == nullptr || !op->mask.has_value()) {
    publish_progress(job_id, 0, "mask", 1, 1, "cancelled", "op is gone");
    return;
  }
  Mask mask = mask_from_json(*op->mask);
  MaskComponent* component = find_component(mask, component_id);
  if (component == nullptr) {
    publish_progress(job_id, 0, "mask", 1, 1, "cancelled", "component is gone");
    return;
  }
  // A second mask.detect on the same component wins; this one's result is thrown away
  // rather than overwriting a newer pending state.
  if (component->job_id != job_id) {
    publish_progress(job_id, 0, "mask", 1, 1, "cancelled", "superseded");
    return;
  }

  std::string error;
  if (!result.ok) {
    component->state = MaskState::Failed;
    component->params["error"] = result.message;
    error = result.message;
  } else {
    // The raster's identity is its path: the hash in the filename already covers the
    // params, the model and the source image (detect_raster_hash).
    const std::string relative = mask_raster_relative_path(
        component_id, detect_raster_hash(*component, result.model, photo.hash));
    try {
      write_gray_png(sidecar_dir_for(photo.path) + "/" + relative, result.raster);
    } catch (const std::exception& failure) {
      warn(std::string("mask raster not cached on disk: ") + failure.what(), photo.id);
    }
    renderer_.put_mask_raster(photo.id, component_id, relative, result.raster);
    component->params["model"] = result.model;
    component->params["sourceHash"] = photo.hash;
    component->params["raster"] = relative;
    component->params.erase("error");
    component->state = MaskState::Ready;
  }
  component->job_id = 0;
  op->mask = mask_to_json(mask);
  commit(photo, std::move(next), false, "ui", nullptr);
  publish_progress(job_id, 0, "mask", 1, 1, result.ok ? "done" : "error",
                   result.ok ? std::string(mask_kind_name(component->kind)) : error, error);
}

nlohmann::json Server::handle_mask_stroke(const nlohmann::json& params, Peer* peer) {
  PhotoState& photo = photo_for(params);
  const std::string component_id = require_string(params, "componentId");
  if (!params.contains("points") || !params["points"].is_array() || params["points"].empty()) {
    throw RpcError(kInvalidParams, "params.points must be a non-empty array");
  }

  Stack next = photo.history.current();
  Op& op = require_masked_op(next, params);
  Mask mask = mask_from_json(*op.mask);
  MaskComponent* component = find_component(mask, component_id);
  if (component == nullptr) {
    throw RpcError(kInvalidParams, "unknown componentId '" + component_id + "'");
  }
  if (component->kind != MaskKind::Brush) {
    throw RpcError(kInvalidParams, "only a brush component takes strokes, not '" +
                                       std::string(mask_kind_name(component->kind)) + "'");
  }

  BrushStroke stroke;
  stroke.erase = optional_flag(params, "erase");
  stroke.size = component->params.value("size", 0.08);
  stroke.flow = component->params.value("flow", 100.0);
  if (params.contains("size")) {
    if (!params["size"].is_number()) throw RpcError(kInvalidParams, "params.size must be a number");
    stroke.size = params["size"].get<double>();
  }
  if (params.contains("flow")) {
    if (!params["flow"].is_number()) throw RpcError(kInvalidParams, "params.flow must be a number");
    stroke.flow = params["flow"].get<double>();
  }
  for (const nlohmann::json& point : params["points"]) {
    if (!point.is_array() || point.size() < 2 || point.size() > 3) {
      throw RpcError(kInvalidParams, "a point is [x, y] or [x, y, pressure]");
    }
    StrokePoint at;
    at.x = point[0].is_number() ? point[0].get<double>() : 0;
    at.y = point[1].is_number() ? point[1].get<double>() : 0;
    if (!point[0].is_number() || !point[1].is_number()) {
      throw RpcError(kInvalidParams, "a point holds numbers");
    }
    if (point.size() == 3) {
      if (!point[2].is_number()) throw RpcError(kInvalidParams, "pressure must be a number");
      at.pressure = point[2].get<double>();
    }
    stroke.points.push_back(at);
  }

  append_brush_stroke(component->params, stroke);
  // The engine owns the file the sidecar points at; the UI never names it.
  component->params[std::string(kBrushStrokePathKey)] = brush_stroke_relative_path(component_id);
  // Re-validating here is what turns a bad point into -32602 instead of a broken sidecar.
  op.mask = normalize_mask(mask_to_json(mask));
  commit(photo, std::move(next), optional_flag(params, "transient"), "ui", peer);
  return stack_state(photo);
}

void Server::load_mask_rasters(const PhotoState& photo) {
  for (const Op& op : photo.history.current()) {
    if (!op.mask.has_value()) continue;
    const Mask mask = mask_from_json(*op.mask);
    for (const MaskComponent& component : mask.components) {
      if (!mask_kind_is_ai(component.kind)) continue;
      const std::string relative = component.params.value("raster", std::string());
      if (relative.empty()) continue;
      try {
        std::optional<GrayImage> raster =
            read_gray_png(sidecar_dir_for(photo.path) + "/" + relative);
        if (!raster.has_value()) continue;
        renderer_.put_mask_raster(photo.id, component.id, relative, std::move(*raster));
      } catch (const std::exception& error) {
        warn(std::string("mask raster not reloaded: ") + error.what(), photo.id);
      }
    }
  }
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
        make_any_thumbnail(row->path, cache, kDefaultThumbnailSize);
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
                              const std::string& message, const std::string& error) {
  nlohmann::json params = {{"jobId", job_id},
                           {"kind", kind},
                           {"done", done},
                           {"total", total},
                           {"finished", state != "running"},
                           {"state", state}};
  if (parent_job_id > 0) params["parentJobId"] = parent_job_id;
  if (!message.empty()) params["message"] = message;
  if (!error.empty()) params["error"] = error;
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
  // `stale` is derived from the stack below each generative op, so it is added on the way
  // out and never stored: a sidecar that recorded it would be wrong the moment it loaded.
  annotate_generative_stale(state["stack"], photo.history.current());
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

  // Brush strokes ride the stack so they undo, and are mirrored beside the sidecar under
  // the path the component names (PROMPT.md 3.3): one file per component, rewritten whole.
  for (const Op& op : sidecar.stack) {
    if (!op.mask.has_value()) continue;
    for (const nlohmann::json& component : (*op.mask)["components"]) {
      if (component.value("kind", std::string()) != "brush") continue;
      const nlohmann::json& params = component["params"];
      const std::string relative = params.value(std::string(kBrushStrokePathKey), std::string());
      if (relative.empty()) continue;
      const std::string path = sidecar_dir_for(photo.path) + "/" + relative;
      try {
        std::error_code failure;
        std::filesystem::create_directories(std::filesystem::path(path).parent_path(), failure);
        std::ofstream file(path, std::ios::binary | std::ios::trunc);
        if (!file) throw std::runtime_error("cannot write " + path);
        file << params.value(std::string(kBrushStrokeDataKey), nlohmann::json::array()).dump(1)
             << "\n";
      } catch (const std::exception& error) {
        warn(std::string("brush strokes not written: ") + error.what(), photo.id);
      }
    }
  }
}

Server::OffscreenFrame Server::render_offscreen(int64_t photo_id, uint32_t max_size) {
  return render_offscreen(photo_id, max_size, require_photo(photo_id).history.current());
}

Server::OffscreenFrame Server::render_offscreen(int64_t photo_id, uint32_t max_size,
                                                const Stack& stack) {
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
    renderer_.render(view_id, stack, out.rgba, 0);
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

int64_t Server::detect_mask(int64_t photo_id, const std::string& op_id,
                            const std::string& component_id) {
  PhotoState& photo = require_photo(photo_id);
  return start_mask_detect(photo, op_id, component_id, nlohmann::json::object(), nullptr);
}

std::vector<uint8_t> Server::render_mask_png(int64_t photo_id, const std::string& op_id,
                                             const std::string& component_id, uint32_t max_size) {
  PhotoState& photo = require_photo(photo_id);
  const double aspect = static_cast<double>(photo.width) / std::max(1U, photo.height);
  uint32_t width = std::clamp(max_size, 32U, 4096U);
  auto height = std::max(1U, static_cast<uint32_t>(std::lround(width / aspect)));
  if (height > width) {
    height = std::clamp(max_size, 32U, 4096U);
    width = std::max(1U, static_cast<uint32_t>(std::lround(height * aspect)));
  }

  const uint32_t view_id = next_view_id_++;
  renderer_.open_view(view_id, photo_id, width, height);
  GrayImage image;
  try {
    const ViewGeometry geometry = renderer_.view_geometry(view_id);
    std::vector<uint8_t> raster(static_cast<size_t>(geometry.width) * geometry.height, 0);
    renderer_.read_mask(view_id, photo.history.current(), op_id, component_id, raster, 0);
    // The agent gets the picture, not the letterbox the view padded it with.
    image.width = geometry.content_width;
    image.height = geometry.content_height;
    image.pixels.resize(static_cast<size_t>(image.width) * image.height);
    for (uint32_t y = 0; y < image.height; ++y) {
      const size_t from =
          (static_cast<size_t>(geometry.content_y + y) * geometry.width) + geometry.content_x;
      std::memcpy(image.pixels.data() + (static_cast<size_t>(y) * image.width),
                  raster.data() + from, image.width);
    }
  } catch (...) {
    renderer_.close_view(view_id);
    throw;
  }
  renderer_.close_view(view_id);
  return encode_gray_png(image);
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

nlohmann::json Server::handle_export_run(const nlohmann::json& params) {
  return start_export(params);
}

nlohmann::json Server::start_export(const nlohmann::json& params) {
  ExportOptions options;
  try {
    options = export_options_from_json(params);
  } catch (const OpError& error) {
    throw RpcError(kInvalidParams, error.what());
  }
  if (options.format == ExportFormat::Avif && !export_avif_available()) {
    throw RpcError(kInvalidParams, "this build of latentd has no AVIF encoder");
  }

  // Resolving the paths up front turns an unknown id into -32602 instead of a job that
  // reports a failure per photo it never had.
  std::vector<std::string> paths;
  paths.reserve(options.photo_ids.size());
  for (int64_t photo_id : options.photo_ids) {
    const auto open = photos_.find(photo_id);
    if (open != photos_.end()) {
      paths.push_back(open->second.path);
      continue;
    }
    const std::optional<CatalogPhoto> row = catalog_.get(photo_id);
    if (!row.has_value()) {
      throw RpcError(kInvalidParams, "unknown photoId " + std::to_string(photo_id));
    }
    paths.push_back(row->path);
  }

  const std::vector<ExportTarget> targets = plan_export(options, options.photo_ids, paths);
  const int64_t job_id = next_job_id_++;
  job_started(job_id);
  publish_progress(job_id, 0, "export", 0, static_cast<int64_t>(targets.size()), "running", "");
  worker_.submit([this, job_id, options, targets] { export_job(job_id, options, targets); });

  nlohmann::json files = nlohmann::json::array();
  for (const ExportTarget& target : targets) {
    files.push_back(target.output_path);
  }
  // `files` is not on the wire (protocol ExportRunResult); it is what the Python and MCP
  // surfaces answer with, so an agent knows where to look without watching job.progress.
  return {{"jobId", job_id}, {"total", targets.size()}, {"files", files}};
}

Rgb16Image Server::render_one_export(const ExportTarget& target,
                                     const ExportRenderOptions& options) {
  Rgb16Image image;
  bool open = false;
  run_on_server_thread([&] {
    const auto found = photos_.find(target.photo_id);
    open = found != photos_.end() && renderer_.has_photo(target.photo_id);
    if (!open) return;
    image = renderer_.render_export(target.photo_id, found->second.history.current(), options);
  });
  if (open) return image;

  // Not open: decode here, on the worker, because a 24 MP raw is over a second and the
  // server thread has a socket to answer. Only the upload and the render hop over.
  const DecodedRaw raw = decode_raw(target.source_path);
  Stack stack;
  const std::optional<Sidecar> sidecar = read_sidecar(sidecar_path_for(target.source_path));
  if (sidecar.has_value()) stack = sidecar->stack;

  // The AI mask rasters the sidecar points at. photo.open does this through
  // load_mask_rasters; an export of a photo nobody opened has to do it itself, or every
  // AI component would contribute nothing and the masked ops would render unmasked.
  std::vector<std::pair<std::string, GrayImage>> rasters;
  for (const Op& op : stack) {
    if (!op.mask.has_value()) continue;
    for (const MaskComponent& component : mask_from_json(*op.mask).components) {
      if (!mask_kind_is_ai(component.kind)) continue;
      const std::string relative = component.params.value("raster", std::string());
      if (relative.empty()) continue;
      std::optional<GrayImage> raster =
          read_gray_png(sidecar_dir_for(target.source_path) + "/" + relative);
      if (raster.has_value()) rasters.emplace_back(component.id, std::move(*raster));
    }
  }

  run_on_server_thread([&] {
    renderer_.load_photo(kExportScratchPhotoId, raw);
    try {
      for (auto& [component_id, raster] : rasters) {
        renderer_.put_mask_raster(kExportScratchPhotoId, component_id, component_id,
                                  std::move(raster));
      }
      image = renderer_.render_export(kExportScratchPhotoId, stack, options);
    } catch (...) {
      renderer_.unload_photo(kExportScratchPhotoId);
      throw;
    }
    renderer_.unload_photo(kExportScratchPhotoId);
  });
  return image;
}

void Server::export_job(int64_t job_id, const ExportOptions& options,
                        const std::vector<ExportTarget>& targets) {
  ExportRenderOptions render_options;
  render_options.resize = options.resize;
  render_options.sharpen = options.sharpen;
  render_options.color_space = options.color_space;
  const auto total = static_cast<int64_t>(targets.size());

  ExportCallbacks callbacks;
  callbacks.cancelled = [this, job_id] { return worker_.stopping() || job_cancelled(job_id); };
  callbacks.progress = [this, job_id, total](size_t done, size_t, const std::string& path) {
    publish_progress(job_id, 0, "export", static_cast<int64_t>(done), total, "running", path);
  };
  // warn() broadcasts, and broadcasting is the server thread's job; this runs on the worker.
  callbacks.warn = [this](const std::string& message) {
    post([this, message] { warn(message, 0); });
  };
  callbacks.render = [this, &render_options](const ExportTarget& target) {
    return render_one_export(target, render_options);
  };

  ExportOutcome outcome;
  std::string failure;
  try {
    outcome = run_export(options, targets, callbacks);
  } catch (const std::exception& error) {
    // Only the things run_export does outside the per-photo try reach here: the ICC, and
    // creating the output directory.
    failure = error.what();
  }
  if (failure.empty()) failure = outcome.error;
  std::string state = failure.empty() ? "done" : "error";
  if (outcome.cancelled) state = "cancelled";
  publish_progress(job_id, 0, "export", static_cast<int64_t>(outcome.done), total, state,
                   std::to_string(outcome.written) + " of " + std::to_string(total) + " written",
                   failure);
  job_finished(job_id);
}

// ---- generative ops (PROMPT.md 3.5) -----------------------------------------------------

namespace {

// The probe render the mask's bounding box is measured on, and the long edge the crop is
// aimed at — what Flux Fill and Qwen-Image-Edit are trained around.
constexpr uint32_t kGenerativeProbeSize = 1024;
constexpr uint32_t kGenerativeCropSize = 1536;
// Context around the hole, as a share of the frame's long edge. A model given nothing but
// the hole has nothing to continue.
constexpr double kGenerativePadding = 0.06;

// One render of `stack` into a throwaway view, plus `op_id`'s mask read out of the same
// view so the two are pixel-aligned by construction.
struct ProbeFrame {
  ViewGeometry geometry;
  std::vector<uint8_t> rgba;
  std::vector<uint8_t> coverage;
};

ProbeFrame probe_generative(Renderer& renderer, uint32_t view_id, int64_t photo_id,
                            uint32_t long_edge, uint32_t photo_width, uint32_t photo_height,
                            const Stack& stack, const std::string& op_id) {
  const double aspect = static_cast<double>(photo_width) / std::max(1U, photo_height);
  uint32_t width = std::clamp(long_edge, 64U, 4096U);
  auto height = std::max(1U, static_cast<uint32_t>(std::lround(width / aspect)));
  if (height > width) {
    height = std::clamp(long_edge, 64U, 4096U);
    width = std::max(1U, static_cast<uint32_t>(std::lround(height * aspect)));
  }

  renderer.open_view(view_id, photo_id, width, height);
  ProbeFrame frame;
  try {
    frame.geometry = renderer.view_geometry(view_id);
    const size_t pixels = static_cast<size_t>(frame.geometry.width) * frame.geometry.height;
    frame.rgba.resize(pixels * 4);
    renderer.render(view_id, stack, frame.rgba, 0);
    frame.coverage.assign(pixels, 0);
    renderer.read_mask(view_id, stack, op_id, {}, frame.coverage, 0);
  } catch (...) {
    renderer.close_view(view_id);
    throw;
  }
  renderer.close_view(view_id);
  return frame;
}

MaskWindow window_of(const ViewGeometry& geometry) {
  MaskWindow window;
  window.stride = geometry.width;
  window.content_x = static_cast<uint32_t>(std::max(geometry.content_x, 0));
  window.content_y = static_cast<uint32_t>(std::max(geometry.content_y, 0));
  window.content_width = geometry.content_width;
  window.content_height = geometry.content_height;
  return window;
}

GrayImage crop_coverage(const ProbeFrame& frame, const CropBox& box) {
  const MaskWindow window = window_of(frame.geometry);
  GrayImage image;
  image.width = box.width;
  image.height = box.height;
  image.pixels.assign(static_cast<size_t>(box.width) * box.height, 0);
  for (uint32_t y = 0; y < box.height; ++y) {
    const size_t from =
        (static_cast<size_t>(window.content_y + box.y + y) * window.stride) + window.content_x +
        box.x;
    if (from + box.width > frame.coverage.size()) break;
    std::memcpy(image.pixels.data() + (static_cast<size_t>(y) * box.width),
                frame.coverage.data() + from, box.width);
  }
  return image;
}

}  // namespace

nlohmann::json Server::handle_generative_run(const nlohmann::json& params) {
  PhotoState& photo = photo_for(params);
  return {{"jobId", start_generative(photo, require_string(params, "opId"))}};
}

std::optional<nlohmann::json> Server::handle_generative_status(const Responder& responder) {
  worker_.submit([this, responder] {
    nlohmann::json status = generative_status();
    post([this, responder, status] { reply_result(responder, status); });
  });
  return std::nullopt;
}

int64_t Server::start_generative(PhotoState& photo, const std::string& op_id) {
  const Stack stack = photo.history.current();
  const Op* op = find_op(stack, op_id);
  if (op == nullptr) throw RpcError(kInvalidParams, "unknown opId '" + op_id + "'");
  if (!is_generative_op(op->name)) {
    throw RpcError(kInvalidParams, "op '" + op_id + "' is not a generative op");
  }
  if (!op->mask.has_value() || !op->mask->contains("components") ||
      (*op->mask)["components"].empty()) {
    throw RpcError(kInvalidParams, "a generative op needs a mask: it is the region to repaint");
  }

  // What the model sees is exactly what the composite will mix into: the ops below this
  // one, plus this op with its result stripped so the last run cannot paint itself into
  // its own input.
  Stack input = generative_input_stack(stack, op_id);
  Op probe = *op;
  probe.result.clear();
  probe.result_rect.clear();
  input.push_back(std::move(probe));

  const ProbeFrame first =
      probe_generative(renderer_, next_view_id_++, photo.id, kGenerativeProbeSize, photo.width,
                       photo.height, input, op_id);
  const std::optional<GenerativeRect> bounds =
      mask_bounds(first.coverage, window_of(first.geometry), kGenerativePadding);
  if (!bounds.has_value()) {
    throw RpcError(kInvalidParams, "the op's mask is empty: there is nothing to repaint");
  }

  // A second, larger render when the hole is small: the crop is what the model works on,
  // so it is the crop that should land near 1536 px, not the whole frame.
  const uint32_t render_size = view_size_for_crop(*bounds, kGenerativeProbeSize, kGenerativeCropSize);
  const ProbeFrame frame =
      render_size == kGenerativeProbeSize
          ? first
          : probe_generative(renderer_, next_view_id_++, photo.id, render_size, photo.width,
                             photo.height, input, op_id);
  const CropBox box =
      crop_box(*bounds, frame.geometry.content_width, frame.geometry.content_height);
  const GenerativeRect rect =
      rect_of(box, frame.geometry.content_width, frame.geometry.content_height);

  Rgb8Image crop = rgba_to_rgb(
      frame.rgba, frame.geometry.width,
      static_cast<uint32_t>(std::max(frame.geometry.content_x, 0)) + box.x,
      static_cast<uint32_t>(std::max(frame.geometry.content_y, 0)) + box.y, box.width, box.height);
  GrayImage coverage = crop_coverage(frame, box);
  const uint32_t long_edge = std::max(crop.width, crop.height);
  if (long_edge > kGenerativeCropSize) {
    const double scale = static_cast<double>(kGenerativeCropSize) / long_edge;
    const auto width = std::max(8U, static_cast<uint32_t>(std::lround(crop.width * scale)) & ~7U);
    const auto height = std::max(8U, static_cast<uint32_t>(std::lround(crop.height * scale)) & ~7U);
    crop = box_resize(crop, width, height);
    coverage = resample_gray(coverage, width, height);
  }

  const int64_t job_id = next_job_id_++;
  GenerativeRequest request;
  request.task = op->name == "remove" ? "remove" : "fill";
  request.prompt = op->params.value("prompt", std::string());
  request.model = op->params.value("model", std::string());
  request.seed = static_cast<int64_t>(op->params.value("seed", 0.0));
  request.image = encode_rgb_png(crop);
  request.mask = encode_gray_png(coverage);
  request.work_dir = (std::filesystem::temp_directory_path() /
                      ("latent-generative-" + std::to_string(job_id)))
                         .string();
  std::error_code directory_error;
  std::filesystem::create_directories(request.work_dir, directory_error);

  const std::string backend_name = op->params.value("backend", std::string("auto"));
  const std::string input_hash = generative_input_hash(stack, op_id);
  const std::vector<double> stored_rect = rect.to_vector();
  const int64_t photo_id = photo.id;
  job_started(job_id);
  publish_progress(job_id, 0, "generative", 0, 100, "running", request.task);
  // Nothing about the op changes until the job lands: a run that fails leaves the last
  // result exactly as it was, and a run that succeeds is the only thing that writes one.
  worker_.submit([this, request, backend_name, photo_id, op_id, job_id, input_hash,
                  stored_rect] {
    GenerativeResult result;
    try {
      const std::unique_ptr<GenerativeBackend> backend = make_generative_backend(backend_name);
      result = backend->inpaint(request, [this, job_id](double fraction, const std::string& note) {
        if (job_cancelled(job_id)) return false;
        const auto done = static_cast<int64_t>(std::lround(std::max(fraction, 0.0) * 100));
        publish_progress(job_id, 0, "generative", done, 100, "running", note);
        return true;
      });
    } catch (const std::exception& error) {
      result.ok = false;
      result.code = "engine_error";
      result.message = error.what();
    }
    std::error_code cleanup;
    std::filesystem::remove_all(request.work_dir, cleanup);
    post([this, photo_id, op_id, job_id, input_hash, stored_rect, result] {
      finish_generative(photo_id, op_id, job_id, input_hash, stored_rect, result);
    });
  });
  return job_id;
}

void Server::finish_generative(int64_t photo_id, const std::string& op_id, int64_t job_id,
                               const std::string& input_hash, const std::vector<double>& rect,
                               const GenerativeResult& result) {
  const bool cancelled = job_cancelled(job_id);
  job_finished(job_id);
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) {
    publish_progress(job_id, 0, "generative", 1, 1, "cancelled", "photo closed");
    return;
  }
  PhotoState& photo = found->second;
  if (!result.ok) {
    const std::string state = cancelled || result.code == "cancelled" ? "cancelled" : "error";
    const std::string message =
        result.hint.empty() ? result.message : result.message + " — " + result.hint;
    publish_progress(job_id, 0, "generative", 1, 1, state, message, message);
    return;
  }

  Stack next = photo.history.current();
  Op* op = find_op(next, op_id);
  if (op == nullptr) {
    publish_progress(job_id, 0, "generative", 1, 1, "cancelled", "op is gone");
    return;
  }

  const std::string relative = generative_result_relative_path(op_id);
  const std::string path = sidecar_dir_for(photo.path) + "/" + relative;
  try {
    write_file(path, result.png);
  } catch (const std::exception& error) {
    warn(std::string("generative result not cached on disk: ") + error.what(), photo.id);
  }
  const std::optional<Rgb8Image> image = decode_rgb_png(result.png);
  if (!image.has_value()) {
    const std::string message = "the backend returned something that is not a PNG";
    publish_progress(job_id, 0, "generative", 1, 1, "error", message, message);
    return;
  }
  // The path is the upload's identity, and it never changes for an op — so the pixels are
  // handed over under a key that changes with them: the path plus this run's input hash.
  op->result = relative;
  op->input_hash = input_hash;
  op->result_rect = rect;
  renderer_.put_generative_result(photo.id, op_id, relative, *image);

  commit(photo, std::move(next), false, "ui", nullptr);
  publish_progress(job_id, 0, "generative", 1, 1, "done",
                   result.model.empty() ? result.workflow : result.model);
}

void Server::load_generative_results(const PhotoState& photo) {
  for (const Op& op : photo.history.current()) {
    if (!is_generative_op(op.name) || op.result.empty()) continue;
    try {
      const std::optional<Rgb8Image> image =
          read_rgb_png(sidecar_dir_for(photo.path) + "/" + op.result);
      if (!image.has_value()) continue;
      renderer_.put_generative_result(photo.id, op.id, op.result, *image);
    } catch (const std::exception& error) {
      warn(std::string("generative result not reloaded: ") + error.what(), photo.id);
    }
  }
}

int64_t Server::run_generative(int64_t photo_id, const std::string& op_id) {
  return start_generative(require_photo(photo_id), op_id);
}

nlohmann::json Server::generative_state() {
  return generative_status();
}

namespace {

// Lightroom's own counts (reference/lightroom/hdr-panorama.md), plus the panorama cap the
// compose step can hold in memory (merge/pano.h).
size_t min_sources(MergeKind kind) {
  return kind == MergeKind::HdrPanorama ? 4 : 2;
}

size_t max_sources(MergeKind kind) {
  switch (kind) {
    case MergeKind::Hdr:
      return 7;
    case MergeKind::Panorama:
      return 12;
    case MergeKind::HdrPanorama:
      break;
  }
  return 48;
}

// The catalog's shutter column is a display string ("1/400"), so the merged row's has to
// be one too. raw_metadata.cpp formats it the same way from the same LibRaw field.
std::string shutter_text(double seconds) {
  if (seconds <= 0) return {};
  std::array<char, 32> buffer{};
  if (seconds >= 1.0) {
    std::snprintf(buffer.data(), buffer.size(), "%.1f", seconds);
    return std::string(buffer.data());
  }
  std::snprintf(buffer.data(), buffer.size(), "1/%d", static_cast<int>(std::lround(1.0 / seconds)));
  return std::string(buffer.data());
}

// `<first source>-HDR.tif` next to the sources, stepping a counter rather than replacing a
// merge that is already there.
std::string default_merge_path(const std::string& first, MergeKind kind) {
  const std::filesystem::path source(first);
  const std::filesystem::path directory = source.parent_path();
  const std::string stem = source.stem().string() + "-" + merge_suffix(kind);
  std::error_code error;
  for (int attempt = 0; attempt < 1000; ++attempt) {
    const std::string suffix = attempt == 0 ? "" : "-" + std::to_string(attempt + 1);
    const std::filesystem::path candidate = directory / (stem + suffix + ".tif");
    if (!std::filesystem::exists(candidate, error)) return candidate.string();
  }
  throw RpcError(kInvalidParams, "cannot find a free name next to " + first);
}

}  // namespace

nlohmann::json Server::start_merge(const nlohmann::json& params) {
  const bool preview = optional_flag(params, "preview");
  return handle_merge(merge_kind_from_params(params), params, preview);
}

MergeKind Server::merge_kind_from_params(const nlohmann::json& params) {
  const std::string kind = require_string(params, "kind");
  if (kind != "hdr" && kind != "panorama" && kind != "hdrPanorama") {
    throw RpcError(kInvalidParams, "params.kind must be hdr, panorama or hdrPanorama");
  }
  return merge_kind_from_name(kind);
}

nlohmann::json Server::handle_merge(MergeKind kind, const nlohmann::json& params, bool preview) {
  const std::vector<int64_t> photo_ids = id_array(params, "photoIds");
  if (photo_ids.size() < min_sources(kind) || photo_ids.size() > max_sources(kind)) {
    throw RpcError(kInvalidParams, std::string("merge to ") + merge_kind_name(kind) + " takes " +
                                       std::to_string(min_sources(kind)) + " to " +
                                       std::to_string(max_sources(kind)) + " photos, got " +
                                       std::to_string(photo_ids.size()));
  }

  MergeRequest request;
  request.kind = kind;
  request.preview = preview;
  for (int64_t photo_id : photo_ids) {
    const CatalogPhoto row = require_row(photo_id);
    if (!std::filesystem::is_regular_file(row.path)) {
      throw RpcError(kInvalidParams, "photo " + std::to_string(photo_id) + " is gone: " + row.path);
    }
    request.paths.push_back(row.path);
  }
  if (params.contains("deghost")) {
    request.hdr.deghost = deghost_from_name(require_string(params, "deghost"));
  }
  request.hdr.auto_align = optional_flag(params, "autoAlign", true);
  if (params.contains("projection")) {
    request.pano.projection = projection_from_name(require_string(params, "projection"));
  }
  request.pano.boundary_warp = std::clamp(optional_int(params, "boundaryWarp", 0), 0, 100);
  request.pano.auto_crop = optional_flag(params, "autoCrop", true);

  if (preview) {
    request.long_edge = static_cast<uint32_t>(
        std::clamp(optional_int(params, "longEdge", kMergePreviewLongEdge), 128, 4096));
  } else if (params.contains("outputPath")) {
    request.output_path = require_string(params, "outputPath");
  } else {
    request.output_path = default_merge_path(request.paths.front(), kind);
  }

  const int64_t job_id = next_job_id_++;
  job_started(job_id);
  publish_merge_progress(job_id, 0, static_cast<int64_t>(request.paths.size()) + 2, "running",
                         preview ? "preview queued" : "queued");
  worker_.submit([this, job_id, request] { merge_job(job_id, request); });
  return {{"jobId", job_id}};
}

void Server::merge_job(int64_t job_id, MergeRequest request) {
  using clock = std::chrono::steady_clock;
  const auto started = clock::now();
  const auto sources = static_cast<int64_t>(request.paths.size());
  // One tick per decode, one for the merge, one for the write.
  const int64_t total = sources + 2;
  const auto elapsed_ms = [started] {
    return std::chrono::duration<double, std::milli>(clock::now() - started).count();
  };

  try {
    SourceMetadata metadata;
    metadata.merge = merge_kind_name(request.kind);
    std::vector<MergeFrame> frames;
    frames.reserve(request.paths.size());
    int64_t done = 0;
    for (const std::string& path : request.paths) {
      if (worker_.stopping() || job_cancelled(job_id)) throw std::runtime_error("cancelled");
      const std::string name = std::filesystem::path(path).filename().string();
      publish_merge_progress(job_id, done, total, "running", "decoding " + name);

      const FrameInfo info = read_frame_info(path);
      // The preview merges the embedded JPEG, which is display-referred and carries the
      // camera's own tone curve: undoing the sRGB transfer gets it close enough to linear
      // for a picture, and nowhere near close enough for the file the merge writes.
      LinearImage image = request.preview
                              ? srgb_to_linear(load_raw_preview(path, request.long_edge))
                              : to_linear(decode_raw(path));
      const double focal = focal_pixels(info, image.width);
      frames.push_back(MergeFrame{std::move(image), exposure_value(info), focal});
      metadata.sources.push_back(name);
      if (done == 0) {
        metadata.camera = info.camera;
        metadata.white_balance = info.white_balance;
        metadata.captured_at = info.captured_at;
        metadata.aperture = info.aperture;
        metadata.iso = static_cast<int>(std::lround(info.iso));
        metadata.focal_length = info.focal_length;
        metadata.shutter = shutter_text(info.shutter);
      }
      ++done;
    }

    MergeProgress progress;
    progress.cancelled = [this, job_id] { return worker_.stopping() || job_cancelled(job_id); };
    progress.tick = [this, job_id, sources, total](int, int, const std::string& stage) {
      publish_merge_progress(job_id, sources, total, "running", stage);
    };

    LinearImage merged;
    if (request.kind == MergeKind::Hdr) {
      std::vector<HdrFrame> bracket;
      bracket.reserve(frames.size());
      for (MergeFrame& frame : frames) {
        bracket.push_back(HdrFrame{std::move(frame.image), frame.ev});
      }
      HdrOutcome outcome = merge_hdr(std::move(bracket), request.hdr, progress);
      metadata.scale = outcome.scale;
      merged = std::move(outcome.image);
    } else if (request.kind == MergeKind::Panorama) {
      std::vector<PanoFrame> panels;
      panels.reserve(frames.size());
      for (MergeFrame& frame : frames) {
        panels.push_back(PanoFrame{std::move(frame.image), frame.focal_px});
      }
      PanoOutcome outcome = merge_panorama(std::move(panels), request.pano, progress);
      merged = std::move(outcome.image);
    } else {
      HdrPanoOptions options;
      options.hdr = request.hdr;
      options.pano = request.pano;
      HdrPanoOutcome outcome = merge_hdr_panorama(std::move(frames), options, progress);
      metadata.scale = outcome.scale;
      merged = std::move(outcome.image);
    }
    frames.clear();

    const uint32_t width = merged.width;
    const uint32_t height = merged.height;
    if (request.preview) {
      const std::string name = "merge-" + std::to_string(job_id) + ".png";
      const std::string path = preview_directory() + "/" + name;
      publish_merge_progress(job_id, total - 1, total, "running", "writing preview");
      // The preview is a picture, not a source: the radiance scale is folded back in, so
      // an HDR merge previews at its reference exposure instead of as a dark frame with
      // one bright corner, and the result is encoded for a screen.
      write_rgb_png(path, linear_to_srgb(merged, static_cast<float>(metadata.scale)));
      const nlohmann::json result = {
          {"previewPath", path},
          {"previewUrl", "http://127.0.0.1:" + std::to_string(bound_port_) + "/preview/" + name},
          {"width", width},
          {"height", height},
          {"durationMs", elapsed_ms()}};
      publish_merge_progress(job_id, total, total, "done", "preview ready", result);
      job_finished(job_id);
      return;
    }

    publish_merge_progress(job_id, total - 1, total, "running", "writing " + request.output_path);
    write_source_tiff(request.output_path, merged, metadata);
    merged.rgb.clear();
    merged.rgb.shrink_to_fit();
    const double duration = elapsed_ms();
    const std::string path = request.output_path;
    post([this, job_id, path, metadata, width, height, duration] {
      finish_merge(job_id, path, metadata, width, height, duration);
    });
  } catch (const std::exception& failure) {
    const std::string message = failure.what();
    const bool cancelled = message == "cancelled";
    publish_merge_progress(job_id, 0, total, cancelled ? "cancelled" : "error",
                           cancelled ? "cancelled" : message, nlohmann::json(),
                           cancelled ? std::string() : message);
    job_finished(job_id);
  }
}

void Server::finish_merge(int64_t job_id, const std::string& path, const SourceMetadata& metadata,
                          uint32_t width, uint32_t height, double duration_ms) {
  const int64_t total = static_cast<int64_t>(metadata.sources.size()) + 2;
  try {
    const int64_t photo_id = catalog_.register_photo(path, read_source_row(path), false);
    catalog_.set_hash(photo_id, sha256_file_hex(path));
    notify_catalog_changed({photo_id}, "import");
    const nlohmann::json result = {{"photoId", photo_id},
                                   {"path", path},
                                   {"width", width},
                                   {"height", height},
                                   {"durationMs", duration_ms}};
    publish_merge_progress(job_id, total, total, "done",
                           std::to_string(metadata.sources.size()) + " photos merged", result);
  } catch (const std::exception& failure) {
    publish_merge_progress(job_id, total, total, "error", failure.what(), nlohmann::json(),
                           failure.what());
  }
  job_finished(job_id);
}

void Server::publish_merge_progress(int64_t job_id, int64_t done, int64_t total,
                                    std::string_view state, const std::string& message,
                                    const nlohmann::json& result, const std::string& error) {
  nlohmann::json params = {{"jobId", job_id},
                           {"kind", "merge"},
                           {"done", done},
                           {"total", total},
                           {"finished", state != "running"},
                           {"state", state}};
  if (!message.empty()) params["message"] = message;
  if (!error.empty()) params["error"] = error;
  if (!result.is_null()) params["result"] = result;
  post([this, params] {
    broadcast({{"jsonrpc", "2.0"}, {"method", "job.progress"}, {"params", params}});
  });
}

std::string Server::preview_directory() {
  const char* cache_home = std::getenv("XDG_CACHE_HOME");
  std::filesystem::path root;
  if (cache_home != nullptr && cache_home[0] != '\0') {
    root = std::filesystem::path(cache_home) / "latent" / "merge-previews";
  } else {
    const char* home = std::getenv("HOME");
    const std::filesystem::path base =
        home == nullptr ? std::filesystem::current_path() : std::filesystem::path(home);
    root = base / ".cache" / "latent" / "merge-previews";
  }
  std::error_code error;
  std::filesystem::create_directories(root, error);
  return root.string();
}

void Server::serve_preview(uWS::HttpResponse<false>* response, std::string_view name) {
  // Only a bare filename inside the preview directory: this listener is not a file server.
  const bool safe = !name.empty() && name.find('/') == std::string_view::npos &&
                    name.find('\\') == std::string_view::npos &&
                    name.find("..") == std::string_view::npos;
  std::ifstream file;
  if (safe) {
    file.open(preview_directory() + "/" + std::string(name), std::ios::binary | std::ios::ate);
  }
  if (!safe || !file) {
    response->writeStatus("404 Not Found")->end("no such preview");
    return;
  }
  const std::streamsize size = file.tellg();
  std::string body(static_cast<size_t>(std::max<std::streamsize>(size, 0)), '\0');
  file.seekg(0);
  file.read(body.data(), size);
  response->writeHeader("Content-Type", "image/png")
      ->writeHeader("Cache-Control", "no-store")
      ->end(body);
}

}  // namespace latent

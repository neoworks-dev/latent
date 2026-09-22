// ComfyUI through the `comfy` CLI, exactly the five steps of PROMPT.md 3.5 step 4:
// write the crop and the mask, upload both, substitute the compiled graph by node id, run
// it with `--wait --no-watch` and consume the NDJSON, then read the output PNG back.
//
// The compiled graph in engine/workflows/ is a template and is never edited on disk; the
// filled copy lives in the job's own temp directory and dies with it.
#include "ai/model_store.h"
#include "generative/backend.h"
#include "generative/comfy_cli.h"
#include "generative/image_io.h"
#include "generative/workflow.h"
#include "ops/op.h"

#include <chrono>
#include <cmath>
#include <cstdlib>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string_view>
#include <vector>

namespace latent {

namespace {

// Names on ComfyUI's input directory. `comfy upload` overwrites by default and reports the
// bare filename back, so a name that is unique per job is enough to keep two runs apart.
std::string upload_name(const std::string& kind, int64_t serial) {
  return "latent-" + std::to_string(serial) + "-" + kind + ".png";
}

std::vector<uint8_t> read_bytes(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return {};
  return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

// The first output the graph's SaveImage produced, whichever shape the envelope used.
std::string output_entry(const nlohmann::json& data, const std::string& save_node) {
  const nlohmann::json by_node = data.value("outputs_by_node", nlohmann::json::object());
  if (!save_node.empty() && by_node.is_object() && by_node.contains(save_node)) {
    const nlohmann::json& entries = by_node[save_node];
    if (entries.is_array() && !entries.empty() && entries[0].is_string()) {
      return entries[0].get<std::string>();
    }
  }
  const nlohmann::json outputs = data.value("outputs", nlohmann::json::array());
  if (outputs.is_array() && !outputs.empty() && outputs[0].is_string()) {
    return outputs[0].get<std::string>();
  }
  return {};
}

// `executed` carries the filename, the subfolder and the type without any URL to parse, so
// it is the reliable way to find the picture when `outputs` came back as a view URL.
std::string executed_path(const nlohmann::json& event, const std::string& workspace) {
  if (workspace.empty()) return {};
  const nlohmann::json outputs = event.value("outputs", nlohmann::json::array());
  if (!outputs.is_array()) return {};
  for (const nlohmann::json& entry : outputs) {
    if (!entry.is_object()) continue;
    const std::string filename = entry.value("filename", std::string());
    if (filename.empty()) continue;
    std::filesystem::path path =
        std::filesystem::path(workspace) / entry.value("type", std::string("output"));
    const std::string subfolder = entry.value("subfolder", std::string());
    if (!subfolder.empty()) path /= subfolder;
    return (path / filename).string();
  }
  return {};
}

class ComfyBackend : public GenerativeBackend {
 public:
  std::string name() const override { return "comfy"; }

  GenerativeResult run(const GenerativeRequest& request,
                       const GenerativeProgress& progress) override {
    const auto started = std::chrono::steady_clock::now();
    GenerativeResult result;
    try {
      execute(request, progress, result);
    } catch (const std::exception& error) {
      result.ok = false;
      result.code = result.code.empty() ? "engine_error" : result.code;
      result.message = error.what();
    }
    result.elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
            .count();
    return result;
  }

 private:
  void execute(const GenerativeRequest& request, const GenerativeProgress& progress,
               GenerativeResult& result) {
    const std::string workspace = comfy_workspace_path();
    const std::vector<Workflow> workflows = load_workflows();
    // `model` names either a graph or a weight file; a graph wins, because naming one is
    // the only way to pick between two graphs for the same task.
    const std::optional<Workflow> chosen =
        choose_workflow(workflows, request.task, request.model, workspace);
    if (!chosen.has_value()) {
      result.code = "no_workflow";
      result.message = "no ComfyUI graph is installed for '" + request.task + "'";
      result.hint = "check engine/workflows/ and $LATENT_WORKFLOW_DIR";
      return;
    }
    const Workflow& workflow = *chosen;
    result.workflow = workflow.name;
    const bool model_is_workflow = request.model == workflow.name;
    result.model = model_is_workflow || request.model.empty() ? workflow.label : request.model;

    static int64_t serial = 0;
    ++serial;
    const std::string crop_path = request.work_dir + "/" + upload_name("crop", serial);
    write_file(crop_path, request.image);
    // A whole-frame task sends no mask, and `comfy upload` would fail on a path that is not
    // there. The graph has no mask binding either, so nothing downstream misses it.
    const bool has_mask = !request.mask.empty();
    const std::string mask_path =
        has_mask ? request.work_dir + "/" + upload_name("mask", serial) : std::string();
    if (has_mask) write_file(mask_path, request.mask);

    std::vector<std::string> upload = {"upload", crop_path};
    if (has_mask) upload.push_back(mask_path);
    const ComfyEnvelope uploaded = comfy_call(upload);
    if (!uploaded.ok) {
      result.code = uploaded.code.empty() ? "upload_failed" : uploaded.code;
      result.message = uploaded.failure();
      result.hint = uploaded.hint;
      return;
    }

    WorkflowValues values;
    values.image = uploaded_name(uploaded.data, crop_path);
    if (has_mask) values.mask = uploaded_name(uploaded.data, mask_path);
    values.prompt = request.prompt;
    values.seed = request.seed;
    values.strength = request.strength;
    if (!model_is_workflow) values.model = request.model;
    const std::string filled_path = request.work_dir + "/workflow.json";
    {
      const std::string filled = fill_workflow(workflow, values).dump(2);
      write_file(filled_path, {reinterpret_cast<const uint8_t*>(filled.data()), filled.size()});
    }

    std::string from_event;
    const std::array<std::string, 5> arguments = {"run", "--workflow", filled_path, "--wait",
                                                  "--no-watch"};
    const ComfyEnvelope ran = comfy_stream(arguments, [&](const nlohmann::json& event) {
      return on_event(event, workspace, progress, from_event);
    });
    if (!ran.ok) {
      result.code = ran.code.empty() ? "execution_error" : ran.code;
      result.message = ran.failure();
      result.hint = ran.hint.empty() ? hint_for(result.code) : ran.hint;
      return;
    }

    std::string path = from_event;
    if (path.empty())
      path = comfy_output_path(output_entry(ran.data, workflow.bindings.output), workspace);
    if (path.empty()) {
      result.code = "download_no_outputs";
      result.message = "the graph ran but produced no image";
      result.hint = "check that " + workflow.name + "'s SaveImage node id matches bindings.json";
      return;
    }
    result.png = read_bytes(path);
    if (result.png.empty()) {
      result.code = "download_failed";
      result.message = "cannot read the output ComfyUI wrote to " + path;
      return;
    }
    if (request.task == "upscale") resample_to_scale(request, result);
    result.ok = true;
  }

  // The upscale model's factor is fixed — 4x for the one the graph ships — and the op asks
  // for 2x or 4x. One resample at the end closes the gap. Resampling the input first, or
  // running the model twice, would be two passes over the same detail (issue #52).
  static void resample_to_scale(const GenerativeRequest& request, GenerativeResult& result) {
    const std::optional<Rgb8Image> source = decode_rgb_png(request.image);
    const std::optional<Rgb8Image> produced = decode_rgb_png(result.png);
    if (!source.has_value() || !produced.has_value()) return;
    const auto width = static_cast<uint32_t>(std::lround(source->width * request.scale));
    const auto height = static_cast<uint32_t>(std::lround(source->height * request.scale));
    if (width == 0 || height == 0) return;
    if (produced->width == width && produced->height == height) return;
    result.png = encode_rgb_png(box_resize(*produced, width, height));
  }

  // `data.uploads[i].cloud_name` for the file we just sent. The CLI answers with the bare
  // filename and an empty subfolder, which is exactly what LoadImage's widget wants.
  static std::string uploaded_name(const nlohmann::json& data, const std::string& local_path) {
    const std::string fallback = std::filesystem::path(local_path).filename().string();
    const nlohmann::json uploads = data.value("uploads", nlohmann::json::array());
    if (!uploads.is_array()) return fallback;
    for (const nlohmann::json& upload : uploads) {
      if (!upload.is_object()) continue;
      if (upload.value("local_path", std::string()) != local_path) continue;
      const std::string cloud = upload.value("cloud_name", fallback);
      const std::string subfolder = upload.value("subfolder", std::string());
      return subfolder.empty() ? cloud : subfolder + "/" + cloud;
    }
    return fallback;
  }

  static bool on_event(const nlohmann::json& event, const std::string& workspace,
                       const GenerativeProgress& progress, std::string& output_path) {
    const std::string type = event.value("type", std::string());
    if (type == "executed") {
      const std::string path = executed_path(event, workspace);
      if (!path.empty()) output_path = path;
    }
    if (!progress) return true;
    if (type == "queued") return progress(-1, "queued");
    if (type == "executing") return progress(-1, event.value("title", std::string("running")));
    if (type != "progress") return true;
    const double total = event.value("total", 0.0);
    const double done = event.value("completed", 0.0);
    return progress(total > 0 ? done / total : -1, "sampling");
  }

  static std::string hint_for(const std::string& code) {
    if (code == "server_not_running" || code == "connection_error") {
      return "ComfyUI is not running — start it with `comfy launch`";
    }
    if (code == "prompt_rejected" || code == "object_info_unavailable") {
      return "the graph does not match this ComfyUI install; check its custom nodes";
    }
    if (code == "cloud_unauthorized" || code == "partner_node_requires_credential") {
      return "sign in with `comfy cloud login`";
    }
    if (code == "comfy_not_installed") return "install comfy-cli, or set LATENT_COMFY";
    return {};
  }
};

// The weight files on disk, so status can list models without a running server.
std::vector<std::string> installed_models(const std::string& workspace) {
  std::vector<std::string> models;
  if (workspace.empty()) return models;
  std::error_code error;
  for (const char* folder : {"checkpoints", "unet", "diffusion_models"}) {
    const std::filesystem::path directory = std::filesystem::path(workspace) / "models" / folder;
    if (!std::filesystem::is_directory(directory, error)) continue;
    for (const auto& entry : std::filesystem::directory_iterator(directory, error)) {
      if (!entry.is_regular_file(error)) continue;
      const std::string extension = entry.path().extension().string();
      if (extension != ".safetensors" && extension != ".ckpt" && extension != ".sft") continue;
      models.push_back(entry.path().filename().string());
    }
  }
  std::sort(models.begin(), models.end());
  return models;
}

bool stub_requested() {
  const char* stub = std::getenv("LATENT_GENERATIVE_STUB");
  return stub != nullptr && std::string_view(stub) == "1";
}

}  // namespace

std::unique_ptr<GenerativeBackend> make_comfy_backend() {
  return std::make_unique<ComfyBackend>();
}

std::string resolve_generative_backend(std::string_view requested, std::string_view task) {
  if (requested == "stub" || requested == "sky" || requested == "comfy" || requested == "onnx") {
    return std::string(requested);
  }
  if (stub_requested()) return "stub";
  // A denoise prefers the local restoration model: it is trained on this problem, it needs
  // no server, and it tiles, so it runs at the photo's own resolution rather than at one
  // diffusion pass worth of pixels. Without the model installed there is still the graph.
  if (task == "denoise" && onnx_denoise_installed()) return "onnx";
  return "comfy";
}

std::unique_ptr<GenerativeBackend> make_generative_backend(std::string_view requested,
                                                           std::string_view task) {
  const std::string resolved = resolve_generative_backend(requested, task);
  if (resolved == "stub") return make_stub_backend();
  if (resolved == "sky") return make_sky_backend();
  if (resolved == "onnx") return make_onnx_denoise_backend();
  return make_comfy_backend();
}

nlohmann::json generative_status() {
  const std::string executable = comfy_executable();
  const std::string workspace = executable.empty() ? std::string() : comfy_workspace_path();
  const std::vector<Workflow> workflows = load_workflows();

  nlohmann::json graphs = nlohmann::json::array();
  for (const Workflow& workflow : workflows) {
    nlohmann::json entry = {{"name", workflow.name},
                            {"task", workflow.task},
                            {"label", workflow.label},
                            {"ready", workflow_models_present(workflow, workspace)},
                            {"requires", workflow.required_models}};
    graphs.push_back(entry);
  }

  // The local denoise model is not a ComfyUI graph, but it is a denoise provider, and the
  // column that asks "can this op run" has one list to read. `requires` names what is
  // missing so the message is the same shape as a graph missing its checkpoint.
  const bool local_denoise = onnx_denoise_installed();
  graphs.push_back({{"name", std::string(kDenoiseModel)},
                    {"task", "denoise"},
                    {"label", "SCUNet, local (onnxruntime)"},
                    {"ready", local_denoise},
                    {"requires", local_denoise ? nlohmann::json::array()
                                               : nlohmann::json::array({kDenoiseModel})}});

  // One cheap call that answers "is a server up": it is the same probe `comfy launch`
  // would be waiting on, and it costs nothing when the server is down.
  bool running = false;
  std::string code;
  std::string message;
  if (!executable.empty()) {
    const std::array<std::string, 1> args = {"system-stats"};
    const ComfyEnvelope stats = comfy_call(args);
    running = stats.ok;
    if (!stats.ok) {
      code = stats.code;
      message = stats.failure();
    }
  }

  const bool stub = stub_requested();
  nlohmann::json status = {{"backend", stub ? "stub" : "comfy"},
                           {"backends", nlohmann::json::array({"comfy", "onnx", "sky", "stub"})},
                           {"stub", stub},
                           {"comfy",
                            {{"installed", !executable.empty()},
                             {"path", executable},
                             {"serverRunning", running},
                             {"workspace", workspace}}},
                           {"models", installed_models(workspace)},
                           {"workflows", graphs},
                           {"ready", stub || running}};
  if (!code.empty()) status["comfy"]["error"] = code;
  if (!message.empty()) status["comfy"]["message"] = message;
  if (stub) {
    status["message"] = "LATENT_GENERATIVE_STUB=1: runs return a blurred stand-in";
  } else if (executable.empty()) {
    status["message"] = "the `comfy` CLI is not installed";
    status["hint"] = "install comfy-cli, or set LATENT_COMFY to its path";
  } else if (!running) {
    status["message"] = "ComfyUI is not running";
    status["hint"] = "run `comfy launch`";
  }
  return status;
}

}  // namespace latent

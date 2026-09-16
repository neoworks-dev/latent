// The one interface a generative model sits behind (PROMPT.md 3.5). ComfyUI is the first
// implementation; a hosted API (BFL Flux Fill, Gemini image edit) is a second one later and
// needs no change to the ops, the staleness rule, the crop or the composite.
//
// Pixels cross this boundary as PNG bytes, in display sRGB: that is what Flux Fill and
// Qwen-Image-Edit expect, and what every hosted API takes.
#pragma once

#include <cstdint>

#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

struct GenerativeRequest {
  // "fill" (generative_fill) or "remove". Picks the graph.
  std::string task;
  std::string prompt;
  // Empty means the graph's own default: the model list is the ComfyUI install's, so the
  // engine cannot have an opinion about it at compile time.
  std::string model;
  int64_t seed = 0;
  // The crop of the photo, and the mask over it. White in the mask is what gets repainted.
  std::vector<uint8_t> image;
  std::vector<uint8_t> mask;
  // A temp directory the backend may write into. The caller owns and removes it.
  std::string work_dir;
};

// `fraction` is 0..1, or negative when the backend cannot tell yet. Returning false asks
// the backend to stop: it maps to job.cancel.
using GenerativeProgress = std::function<bool(double fraction, const std::string& note)>;

struct GenerativeResult {
  bool ok = false;
  // The inpainted crop, PNG, the same size as the request's image.
  std::vector<uint8_t> png;
  // What actually ran, so the op can record it and a report can name it.
  std::string model;
  std::string workflow;
  // A machine-readable failure the UI maps to a sentence: `server_not_running`,
  // `comfy_not_installed`, `no_workflow`, `cancelled`, or whatever the CLI reported.
  std::string code;
  std::string message;
  std::string hint;
  double elapsed_ms = 0;
};

class GenerativeBackend {
 public:
  virtual ~GenerativeBackend() = default;

  virtual std::string name() const = 0;
  // Runs on the worker thread (jobs/worker.h): it blocks for seconds to minutes.
  virtual GenerativeResult inpaint(const GenerativeRequest& request,
                                   const GenerativeProgress& progress) = 0;
};

// `requested` is the op's `backend` param: "comfy", "stub", or "auto" — which is the stub
// when LATENT_GENERATIVE_STUB=1 and ComfyUI otherwise.
std::unique_ptr<GenerativeBackend> make_generative_backend(std::string_view requested);

// The two implementations. A test that wants the stub asks for it by name rather than
// setting an environment variable half way through a run.
std::unique_ptr<GenerativeBackend> make_stub_backend();
std::unique_ptr<GenerativeBackend> make_comfy_backend();

// What generative.status answers with: whether the CLI is installed, whether a server is up,
// which graphs are shipped and which of them have their weights. Blocks on one or two comfy
// calls, so it belongs on the worker thread, not in a slider tick.
nlohmann::json generative_status();

}  // namespace latent

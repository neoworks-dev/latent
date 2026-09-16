// onnxruntime plumbing: one process-wide environment, the session options the reference
// implementation in `scripts/models/` used, and the two-line tensor helpers every model
// here needs.
//
// Sessions are opened per job and dropped again. VRAM, not disk, is the limit: all four
// mask models resident plus BiRefNet's 822 MB transient exhausts a 16 GB card
// (PROMPT.md 8.1.1). Only the SAM 2 encoder *output* is worth keeping, and that is the
// detector's business, not this file's.
#pragma once

#include <cstdint>
#include <onnxruntime_cxx_api.h>

#include <span>
#include <string>
#include <vector>

namespace latent {

class OrtRuntime {
 public:
  static OrtRuntime& instance();

  // CUDA EP with a CPU fallback. Throws Ort::Exception when the graph itself is bad.
  Ort::Session open(const std::string& path);

  // False once a session has had to fall back to the CPU provider.
  bool cuda() const { return cuda_; }

 private:
  OrtRuntime();

  Ort::Env env_;
  bool cuda_ = true;
};

// Both wrap caller-owned storage: the vector must outlive the Session::Run call.
Ort::Value float_tensor(std::span<float> data, std::span<const int64_t> shape);
Ort::Value int64_tensor(std::span<int64_t> data, std::span<const int64_t> shape);

// Copies a float32 output out of onnxruntime's arena, which the next Run reuses.
std::vector<float> copy_floats(const Ort::Value& value);
std::vector<int64_t> tensor_shape(const Ort::Value& value);

}  // namespace latent

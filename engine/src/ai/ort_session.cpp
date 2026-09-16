#include "ai/ort_session.h"

#include <cstdio>

namespace latent {

namespace {

Ort::SessionOptions base_options() {
  Ort::SessionOptions options;
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  // ORT 1.30 logs "No registered plugin EP device found for 'CUDAExecutionProvider'" at
  // every session creation. It refers to the new plugin-EP mechanism; the classic CUDA EP
  // still registers and runs (scripts/models/README.md, Gotchas). Errors only.
  options.SetLogSeverityLevel(ORT_LOGGING_LEVEL_ERROR);
  return options;
}

Ort::MemoryInfo& cpu_memory() {
  static Ort::MemoryInfo memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  return memory;
}

}  // namespace

OrtRuntime::OrtRuntime() : env_(ORT_LOGGING_LEVEL_ERROR, "latent") {}

OrtRuntime& OrtRuntime::instance() {
  // Deliberately never destroyed. Releasing an OrtEnv that has hosted a CUDA session
  // corrupts the heap at process exit roughly one run in three ("corrupted double-linked
  // list", SIGABRT after main returned); the CUDA EP's own teardown has already run by
  // then. The daemon keeps one environment for its whole life either way, so outliving
  // main costs nothing and the smoke test's "latentd exits 0" stays true.
  static OrtRuntime* runtime = new OrtRuntime();
  return *runtime;
}

Ort::Session OrtRuntime::open(const std::string& path) {
  if (cuda_) {
    try {
      Ort::SessionOptions options = base_options();
      // The four knobs scripts/models/common.py sets. EXHAUSTIVE is what makes SAM 2's
      // first encoder run ~450 ms and every later one ~100 ms.
      OrtCUDAProviderOptions cuda;
      cuda.device_id = 0;
      cuda.cudnn_conv_algo_search = OrtCudnnConvAlgoSearchExhaustive;
      cuda.arena_extend_strategy = 1;  // kSameAsRequested
      cuda.do_copy_in_default_stream = 1;
      options.AppendExecutionProvider_CUDA(cuda);
      return Ort::Session(env_, path.c_str(), options);
    } catch (const Ort::Exception& error) {
      cuda_ = false;
      std::fprintf(stderr,
                   "latent: onnxruntime CUDA provider unavailable (%s); mask detection falls "
                   "back to the CPU and will be many times slower\n",
                   error.what());
    }
  }
  Ort::SessionOptions options = base_options();
  return Ort::Session(env_, path.c_str(), options);
}

Ort::Value float_tensor(std::span<float> data, std::span<const int64_t> shape) {
  return Ort::Value::CreateTensor<float>(cpu_memory(), data.data(), data.size(), shape.data(),
                                         shape.size());
}

Ort::Value int64_tensor(std::span<int64_t> data, std::span<const int64_t> shape) {
  return Ort::Value::CreateTensor<int64_t>(cpu_memory(), data.data(), data.size(), shape.data(),
                                           shape.size());
}

std::vector<float> copy_floats(const Ort::Value& value) {
  const Ort::TensorTypeAndShapeInfo info = value.GetTensorTypeAndShapeInfo();
  const size_t count = info.GetElementCount();
  const float* data = value.GetTensorData<float>();
  return {data, data + count};
}

std::vector<int64_t> tensor_shape(const Ort::Value& value) {
  const Ort::TensorTypeAndShapeInfo info = value.GetTensorTypeAndShapeInfo();
  return info.GetShape();
}

}  // namespace latent

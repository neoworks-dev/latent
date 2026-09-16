// PROMPT.md section 8, step 5: onnxruntime C++ with the CUDA execution provider.
// Loads a model, prints its inputs/outputs, runs one inference on zero-filled inputs
// of the declared shapes (dynamic dims -> 1, or 1024 for spatial dims), times it.
#include <chrono>
#include <cstdio>
#include <onnxruntime_cxx_api.h>

#include <exception>
#include <numeric>
#include <string>
#include <vector>

namespace {

std::vector<int64_t> concrete_shape(const std::vector<int64_t>& declared, const std::string& name) {
  std::vector<int64_t> shape = declared;
  for (size_t i = 0; i < shape.size(); ++i) {
    if (shape[i] > 0) continue;
    // Batch-like leading dim -> 1; trailing spatial dims -> 1024 (SAM 2 encoder size).
    shape[i] = (i >= shape.size() - 2 && shape.size() >= 3) ? 1024 : 1;
  }
  std::printf("  input %s shape:", name.c_str());
  for (int64_t d : shape)
    std::printf(" %lld", static_cast<long long>(d));
  std::printf("\n");
  return shape;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: probe_onnx <model.onnx> [runs]\n");
    return 2;
  }
  const int runs = argc > 2 ? std::atoi(argv[2]) : 5;
  using clock = std::chrono::steady_clock;
  try {
    Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "latent-probe");
    Ort::SessionOptions options;
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    OrtCUDAProviderOptions cuda{};
    cuda.device_id = 0;
    options.AppendExecutionProvider_CUDA(cuda);

    auto t0 = clock::now();
    Ort::Session session(env, argv[1], options);
    auto t1 = clock::now();
    std::printf("session created in %.0f ms (CUDA EP)\n",
                std::chrono::duration<double, std::milli>(t1 - t0).count());

    Ort::AllocatorWithDefaultOptions allocator;
    Ort::MemoryInfo memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

    std::vector<std::string> input_names;
    std::vector<const char*> input_name_ptrs;
    std::vector<std::vector<float>> input_storage;
    std::vector<Ort::Value> inputs;
    for (size_t i = 0; i < session.GetInputCount(); ++i) {
      input_names.push_back(session.GetInputNameAllocated(i, allocator).get());
      // GetTensorTypeAndShapeInfo() is a non-owning view into the TypeInfo; the TypeInfo
      // must outlive it or the element type reads as garbage.
      const Ort::TypeInfo type_info = session.GetInputTypeInfo(i);
      auto info = type_info.GetTensorTypeAndShapeInfo();
      if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
        std::fprintf(stderr, "input %s is not float32; probe only handles float models\n",
                     input_names.back().c_str());
        return 3;
      }
      std::vector<int64_t> shape = concrete_shape(info.GetShape(), input_names.back());
      const size_t count =
          std::accumulate(shape.begin(), shape.end(), size_t{1}, std::multiplies<>());
      input_storage.emplace_back(count, 0.0f);
      inputs.push_back(Ort::Value::CreateTensor<float>(memory, input_storage.back().data(), count,
                                                       shape.data(), shape.size()));
    }
    for (const auto& name : input_names)
      input_name_ptrs.push_back(name.c_str());

    std::vector<std::string> output_names;
    std::vector<const char*> output_name_ptrs;
    for (size_t i = 0; i < session.GetOutputCount(); ++i) {
      output_names.push_back(session.GetOutputNameAllocated(i, allocator).get());
      output_name_ptrs.push_back(output_names.back().c_str());
      std::printf("  output %s\n", output_names.back().c_str());
    }

    // First run includes CUDA kernel compilation/warmup; report it separately.
    auto t2 = clock::now();
    auto outputs = session.Run(Ort::RunOptions{nullptr}, input_name_ptrs.data(), inputs.data(),
                               inputs.size(), output_name_ptrs.data(), output_name_ptrs.size());
    auto t3 = clock::now();
    std::printf("first run %.0f ms\n", std::chrono::duration<double, std::milli>(t3 - t2).count());

    auto t4 = clock::now();
    for (int i = 0; i < runs; ++i) {
      outputs = session.Run(Ort::RunOptions{nullptr}, input_name_ptrs.data(), inputs.data(),
                            inputs.size(), output_name_ptrs.data(), output_name_ptrs.size());
    }
    auto t5 = clock::now();
    std::printf("steady-state %.1f ms avg over %d runs\n",
                std::chrono::duration<double, std::milli>(t5 - t4).count() / runs, runs);

    auto shape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    std::printf("  output[0] shape:");
    for (int64_t d : shape)
      std::printf(" %lld", static_cast<long long>(d));
    std::printf("\nRESULT PASS\n");
    return 0;
  } catch (const Ort::Exception& error) {
    std::fprintf(stderr, "probe_onnx failed: %s\n", error.what());
    return 1;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "probe_onnx failed: %s\n", error.what());
    return 1;
  }
}

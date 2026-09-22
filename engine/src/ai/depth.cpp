#include "ai/depth.h"

#include "ai/model_store.h"
#include "ai/ort_session.h"
#include "ai/preprocess.h"

#include <cmath>
#include <cstdlib>

#include <algorithm>
#include <stdexcept>
#include <string_view>

namespace latent {

namespace {

// The stub works at a fixed size and the map is resampled per view, so its shape does not
// change when the window does — the same rule the mask stub follows.
constexpr uint32_t kStubLongEdge = 1024;

std::array<float, 3> statistic(const nlohmann::json& config, const char* key,
                               const std::array<float, 3>& fallback) {
  if (!config.contains(key) || !config[key].is_array() || config[key].size() != 3) {
    return fallback;
  }
  return {config[key][0].get<float>(), config[key][1].get<float>(), config[key][2].get<float>()};
}

// A floor receding to a horizon with one thing standing on it: enough geometry for the
// relight passes to have something to shade and something to cast a shaft past.
Gray16Image stub_scene(uint32_t width, uint32_t height) {
  Gray16Image image;
  image.width = width;
  image.height = height;
  image.pixels.assign(static_cast<size_t>(width) * height, 0);
  for (uint32_t y = 0; y < height; ++y) {
    const double v = (y + 0.5) / height;
    const double floor_nearness = std::clamp((v - 0.45) / 0.55, 0.0, 1.0);
    for (uint32_t x = 0; x < width; ++x) {
      const double u = (x + 0.5) / width;
      const double dx = (u - 0.5) / 0.18;
      const double dy = (v - 0.55) / 0.35;
      const bool standing = (dx * dx) + (dy * dy) < 1.0;
      const double nearness = standing ? 0.6 : floor_nearness;
      image.pixels[(static_cast<size_t>(y) * width) + x] =
          static_cast<uint16_t>(std::lround(nearness * 65535));
    }
  }
  return image;
}

class StubDepthEstimator : public DepthEstimator {
 public:
  std::string name() const override { return "stub-scene"; }

  DepthResult estimate(const DepthRequest& request) override {
    const double aspect = request.image.width == 0 || request.image.height == 0
                              ? 1.0
                              : static_cast<double>(request.image.width) / request.image.height;
    uint32_t width = kStubLongEdge;
    auto height = static_cast<uint32_t>(std::lround(kStubLongEdge / std::max(aspect, 1e-3)));
    if (height > kStubLongEdge) {
      height = kStubLongEdge;
      width = static_cast<uint32_t>(std::lround(kStubLongEdge * aspect));
    }
    DepthResult result;
    result.ok = true;
    result.model = name();
    result.map = stub_scene(std::max(width, 1U), std::max(height, 1U));
    return result;
  }
};

class OrtDepthEstimator : public DepthEstimator {
 public:
  std::string name() const override { return std::string(kDepthModel); }

  DepthResult estimate(const DepthRequest& request) override {
    DepthResult result;
    if (request.image.width == 0 || request.image.height == 0) {
      result.message = "depth.estimate has no image to look at";
      return result;
    }
    if (!model_installed(kDepthModel)) {
      result.message = missing_model_message(kDepthModel);
      return result;
    }
    try {
      DepthAnythingV2 model(model_dir(kDepthModel));
      result.map =
          plane_to_gray16(model.depth(request.image), request.image.width, request.image.height);
      result.model = std::string(kDepthModel);
      result.ok = true;
    } catch (const Ort::Exception& error) {
      result.message = std::string("onnxruntime: ") + error.what();
    } catch (const std::exception& error) {
      result.message = error.what();
    }
    return result;
  }
};

}  // namespace

void normalize_depth(std::vector<float>& plane) {
  if (plane.empty()) return;
  std::vector<float> sorted = plane;
  const size_t low_index = static_cast<size_t>(0.01 * static_cast<double>(sorted.size() - 1));
  const size_t high_index = static_cast<size_t>(0.99 * static_cast<double>(sorted.size() - 1));
  std::nth_element(sorted.begin(), sorted.begin() + static_cast<ptrdiff_t>(low_index),
                   sorted.end());
  const float low = sorted[low_index];
  std::nth_element(sorted.begin(), sorted.begin() + static_cast<ptrdiff_t>(high_index),
                   sorted.end());
  const float high = sorted[high_index];
  const float span = high - low;
  if (span < 1e-6F) {
    std::fill(plane.begin(), plane.end(), 0.0F);
    return;
  }
  for (float& value : plane) {
    value = std::clamp((value - low) / span, 0.0F, 1.0F);
  }
}

DepthAnythingV2::DepthAnythingV2(const std::string& directory) : session_(nullptr) {
  const nlohmann::json config = read_json_file(directory + "/config.json");
  image_size_ = config.value("image_size", 518U);
  mean_ = statistic(config, "image_mean", kImageNetMean);
  deviation_ = statistic(config, "image_std", kImageNetStd);
  input_name_ = config.value("input_name", std::string("pixel_values"));
  output_name_ = config.value("output_name", std::string("predicted_depth"));
  session_ = OrtRuntime::instance().open(directory + "/" +
                                         config.value("model_path", std::string("model.onnx")));
}

std::vector<float> DepthAnythingV2::depth(const Rgb8Image& image) {
  std::vector<float> pixels =
      preprocess_square(image, image_size_, mean_, deviation_, Filter::Bilinear);
  const std::array<int64_t, 4> shape{1, 3, image_size_, image_size_};
  std::array<Ort::Value, 1> inputs{float_tensor(pixels, shape)};
  const std::array<const char*, 1> input_names{input_name_.c_str()};
  const std::array<const char*, 1> output_names{output_name_.c_str()};

  const std::vector<Ort::Value> outputs =
      session_.Run(Ort::RunOptions{nullptr}, input_names.data(), inputs.data(), inputs.size(),
                   output_names.data(), output_names.size());
  // [1, h, w]: the head drops the channel axis, unlike every mask graph here.
  const std::vector<int64_t> dimensions = tensor_shape(outputs[0]);
  if (dimensions.size() != 3) {
    throw std::runtime_error("depth-anything: the graph did not return [b, h, w]");
  }
  std::vector<float> inverse_depth = copy_floats(outputs[0]);
  normalize_depth(inverse_depth);
  return resample_plane(inverse_depth, static_cast<uint32_t>(dimensions[2]),
                        static_cast<uint32_t>(dimensions[1]), image.width, image.height,
                        Filter::Bilinear);
}

std::unique_ptr<DepthEstimator> make_depth_estimator() {
  const char* stub = std::getenv("LATENT_DEPTH_STUB");
  if (stub != nullptr && std::string_view(stub) == "1") {
    return std::make_unique<StubDepthEstimator>();
  }
  return std::make_unique<OrtDepthEstimator>();
}

}  // namespace latent

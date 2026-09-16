#include "ai/dedicated.h"

#include "ai/model_store.h"
#include "ai/ort_session.h"
#include "ai/preprocess.h"

#include <cmath>

#include <algorithm>
#include <array>
#include <stdexcept>

namespace latent {

namespace {

std::array<float, 3> statistic(const nlohmann::json& config, const char* key,
                               const std::array<float, 3>& fallback) {
  if (!config.contains(key) || !config[key].is_array() || config[key].size() != 3) {
    return fallback;
  }
  return {config[key][0].get<float>(), config[key][1].get<float>(), config[key][2].get<float>()};
}

}  // namespace

BiRefNetLite::BiRefNetLite(const std::string& directory) : session_(nullptr) {
  const nlohmann::json config = read_json_file(directory + "/config.json");
  image_size_ = config.value("image_size", 1024U);
  mean_ = statistic(config, "image_mean", kImageNetMean);
  deviation_ = statistic(config, "image_std", kImageNetStd);
  input_name_ = config.value("input_name", std::string("input_image"));
  output_name_ = config.value("output_name", std::string("output_image"));
  session_ = OrtRuntime::instance().open(directory + "/" +
                                         config.value("model_path", std::string("model.onnx")));
}

std::vector<float> BiRefNetLite::alpha(const Rgb8Image& image) {
  std::vector<float> pixels =
      preprocess_square(image, image_size_, mean_, deviation_, Filter::Bilinear);
  const std::array<int64_t, 4> shape{1, 3, image_size_, image_size_};
  std::array<Ort::Value, 1> inputs{float_tensor(pixels, shape)};
  const std::array<const char*, 1> input_names{input_name_.c_str()};
  const std::array<const char*, 1> output_names{output_name_.c_str()};

  const std::vector<Ort::Value> outputs =
      session_.Run(Ort::RunOptions{nullptr}, input_names.data(), inputs.data(), inputs.size(),
                   output_names.data(), output_names.size());
  std::vector<float> logits = copy_floats(outputs[0]);
  for (float& value : logits) {
    value = sigmoid(value);
  }
  return resample_plane(logits, image_size_, image_size_, image.width, image.height,
                        Filter::Bilinear);
}

SegFormerAde::SegFormerAde(const std::string& directory) : session_(nullptr) {
  const nlohmann::json config = read_json_file(directory + "/config.json");
  image_size_ = config.value("image_size", 512U);
  sky_class_ = config.value("class_sky", 2);
  person_class_ = config.value("class_person", 12);
  mean_ = statistic(config, "image_mean", kImageNetMean);
  deviation_ = statistic(config, "image_std", kImageNetStd);
  session_ = OrtRuntime::instance().open(directory + "/" +
                                         config.value("model_path", std::string("model.onnx")));
}

std::vector<float> SegFormerAde::class_probability(const Rgb8Image& image, int class_id) {
  std::vector<float> pixels =
      preprocess_square(image, image_size_, mean_, deviation_, Filter::Bilinear);
  const std::array<int64_t, 4> shape{1, 3, image_size_, image_size_};
  std::array<Ort::Value, 1> inputs{float_tensor(pixels, shape)};
  static constexpr std::array<const char*, 1> kInputs{"pixel_values"};
  static constexpr std::array<const char*, 1> kOutputs{"logits"};

  const std::vector<Ort::Value> outputs =
      session_.Run(Ort::RunOptions{nullptr}, kInputs.data(), inputs.data(), inputs.size(),
                   kOutputs.data(), kOutputs.size());
  const std::vector<int64_t> shape_out = tensor_shape(outputs[0]);
  if (shape_out.size() != 4) {
    throw std::runtime_error("segformer: the graph did not return [b, classes, h, w]");
  }
  const auto classes = static_cast<size_t>(shape_out[1]);
  const auto height = static_cast<uint32_t>(shape_out[2]);
  const auto width = static_cast<uint32_t>(shape_out[3]);
  if (class_id < 0 || static_cast<size_t>(class_id) >= classes) {
    throw std::runtime_error("segformer: class id out of range");
  }

  // Softmax over the class axis, which turns the winner-take-all map into a soft mask the
  // feather can work with. The subtracted maximum is the usual overflow guard.
  const std::vector<float> logits = copy_floats(outputs[0]);
  const size_t plane = static_cast<size_t>(width) * height;
  std::vector<float> probability(plane);
  for (size_t pixel = 0; pixel < plane; ++pixel) {
    float highest = logits[pixel];
    for (size_t klass = 1; klass < classes; ++klass) {
      highest = std::max(highest, logits[(klass * plane) + pixel]);
    }
    float total = 0.0F;
    for (size_t klass = 0; klass < classes; ++klass) {
      total += std::exp(logits[(klass * plane) + pixel] - highest);
    }
    probability[pixel] =
        std::exp(logits[(static_cast<size_t>(class_id) * plane) + pixel] - highest) / total;
  }
  return resample_plane(probability, width, height, image.width, image.height, Filter::Bilinear);
}

}  // namespace latent

#include "ai/sam2.h"

#include "ai/model_store.h"
#include "ai/ort_session.h"
#include "ai/preprocess.h"

#include <algorithm>
#include <array>
#include <stdexcept>

namespace latent {

namespace {

constexpr std::array<const char*, 1> kEncoderInputs{"image"};
constexpr std::array<const char*, 3> kEncoderOutputs{"high_res_feats_0", "high_res_feats_1",
                                                     "image_embed"};
constexpr std::array<const char*, 7> kDecoderInputs{
    "image_embed",  "high_res_feats_0", "high_res_feats_1", "point_coords",
    "point_labels", "mask_input",       "has_mask_input"};
constexpr std::array<const char*, 2> kDecoderOutputs{"masks", "iou_predictions"};

std::string session_path(const std::string& directory, const nlohmann::json& config,
                         const char* key, const char* fallback) {
  return directory + "/" + config.value(key, std::string(fallback));
}

}  // namespace

Sam2::Sam2(const std::string& directory) : encoder_(nullptr), decoder_(nullptr) {
  const nlohmann::json config = read_json_file(directory + "/config.json");
  image_size_ = config.value("image_size", 1024U);
  mask_size_ = config.value("mask_size", 256U);
  encoder_ =
      OrtRuntime::instance().open(session_path(directory, config, "encoder_path", "encoder.onnx"));
  decoder_ =
      OrtRuntime::instance().open(session_path(directory, config, "decoder_path", "decoder.onnx"));
}

Sam2Embedding Sam2::encode(const Rgb8Image& image) {
  // No normalisation node in the graph — the first op is patch_embed/proj/Conv — so the
  // resize, the /255 and the ImageNet statistics are all the caller's job.
  std::vector<float> input =
      preprocess_square(image, image_size_, kImageNetMean, kImageNetStd, Filter::Bilinear);
  const std::array<int64_t, 4> shape{1, 3, image_size_, image_size_};
  std::array<Ort::Value, 1> inputs{float_tensor(input, shape)};

  const std::vector<Ort::Value> outputs =
      encoder_.Run(Ort::RunOptions{nullptr}, kEncoderInputs.data(), inputs.data(), inputs.size(),
                   kEncoderOutputs.data(), kEncoderOutputs.size());
  Sam2Embedding embedding;
  embedding.high_res_feats_0 = copy_floats(outputs[0]);
  embedding.high_res_feats_1 = copy_floats(outputs[1]);
  embedding.image_embed = copy_floats(outputs[2]);
  return embedding;
}

std::vector<float> Sam2::decode(const Sam2Embedding& embedding,
                                const std::vector<Sam2Point>& prompt, uint32_t width,
                                uint32_t height) {
  if (prompt.empty()) throw std::runtime_error("sam2: a prompt needs at least one point");
  if (width == 0 || height == 0) throw std::runtime_error("sam2: the image has no pixels");

  // Prompt coordinates live in the encoder's input space, which is the squashed square.
  const auto points = static_cast<int64_t>(prompt.size());
  std::vector<float> coords(prompt.size() * 2);
  std::vector<float> labels(prompt.size());
  for (size_t i = 0; i < prompt.size(); ++i) {
    coords[i * 2] = prompt[i].x * static_cast<float>(image_size_) / static_cast<float>(width);
    coords[(i * 2) + 1] =
        prompt[i].y * static_cast<float>(image_size_) / static_cast<float>(height);
    labels[i] = static_cast<float>(prompt[i].label);
  }
  // No refinement pass, so there is no mask to feed back.
  std::vector<float> mask_input(static_cast<size_t>(mask_size_) * mask_size_, 0.0F);
  std::vector<float> has_mask_input{0.0F};

  auto embed = embedding.image_embed;
  auto feats_0 = embedding.high_res_feats_0;
  auto feats_1 = embedding.high_res_feats_1;
  const std::array<int64_t, 4> embed_shape{1, 256, 64, 64};
  const std::array<int64_t, 4> feats_0_shape{1, 32, 256, 256};
  const std::array<int64_t, 4> feats_1_shape{1, 64, 128, 128};
  const std::array<int64_t, 3> coords_shape{1, points, 2};
  const std::array<int64_t, 2> labels_shape{1, points};
  const std::array<int64_t, 4> mask_shape{1, 1, mask_size_, mask_size_};
  const std::array<int64_t, 1> has_mask_shape{1};

  std::array<Ort::Value, 7> inputs{float_tensor(embed, embed_shape),
                                   float_tensor(feats_0, feats_0_shape),
                                   float_tensor(feats_1, feats_1_shape),
                                   float_tensor(coords, coords_shape),
                                   float_tensor(labels, labels_shape),
                                   float_tensor(mask_input, mask_shape),
                                   float_tensor(has_mask_input, has_mask_shape)};

  const std::vector<Ort::Value> outputs =
      decoder_.Run(Ort::RunOptions{nullptr}, kDecoderInputs.data(), inputs.data(), inputs.size(),
                   kDecoderOutputs.data(), kDecoderOutputs.size());

  const std::vector<float> iou = copy_floats(outputs[1]);
  const size_t best = std::distance(iou.begin(), std::max_element(iou.begin(), iou.end()));

  const size_t plane = static_cast<size_t>(mask_size_) * mask_size_;
  const std::vector<float> masks = copy_floats(outputs[0]);
  const std::span<const float> logits(masks.data() + (best * plane), plane);
  std::vector<float> upsampled =
      resample_plane(logits, mask_size_, mask_size_, width, height, Filter::Bilinear);
  // The graph clips the logits to +/-32, so the sigmoid is all but binary except along the
  // boundary, which is exactly the soft edge the feather wants.
  for (float& value : upsampled) {
    value = sigmoid(value);
  }
  return upsampled;
}

}  // namespace latent

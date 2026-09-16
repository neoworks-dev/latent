#include "ai/florence2.h"

#include "ai/model_store.h"
#include "ai/ort_session.h"
#include "ai/preprocess.h"

#include <algorithm>
#include <stdexcept>

namespace latent {

namespace {

constexpr int kQuantizeBins = 1000;

// Returns the number of <loc_###> bins read, or 0 when `at` does not start one.
size_t read_loc_token(const std::string& text, size_t at, int& bin) {
  static constexpr std::string_view kPrefix = "<loc_";
  if (text.compare(at, kPrefix.size(), kPrefix) != 0) return 0;
  size_t digits = at + kPrefix.size();
  int value = 0;
  while (digits < text.size() && text[digits] >= '0' && text[digits] <= '9') {
    value = (value * 10) + (text[digits] - '0');
    ++digits;
  }
  if (digits == at + kPrefix.size() || digits >= text.size() || text[digits] != '>') return 0;
  bin = value;
  return digits + 1 - at;
}

std::string session_path(const std::string& directory, const nlohmann::json& config,
                         const char* key, const char* fallback) {
  return directory + "/" + config.value(key, std::string(fallback));
}

}  // namespace

DetectionBox dequantize_box(const std::array<int, 4>& bins, uint32_t width, uint32_t height) {
  const float per_bin_x = static_cast<float>(width) / kQuantizeBins;
  const float per_bin_y = static_cast<float>(height) / kQuantizeBins;
  return {static_cast<float>(static_cast<int>((bins[0] + 0.5F) * per_bin_x)),
          static_cast<float>(static_cast<int>((bins[1] + 0.5F) * per_bin_y)),
          static_cast<float>(static_cast<int>((bins[2] + 0.5F) * per_bin_x)),
          static_cast<float>(static_cast<int>((bins[3] + 0.5F) * per_bin_y))};
}

std::vector<DetectionBox> parse_boxes(const std::string& text, uint32_t width, uint32_t height) {
  std::vector<DetectionBox> boxes;
  size_t at = 0;
  while (at < text.size()) {
    std::array<int, 4> bins{};
    size_t cursor = at;
    size_t read = 0;
    for (; read < bins.size(); ++read) {
      const size_t length = read_loc_token(text, cursor, bins[read]);
      if (length == 0) break;
      cursor += length;
    }
    if (read == bins.size()) {
      boxes.push_back(dequantize_box(bins, width, height));
      at = cursor;
      continue;
    }
    ++at;
  }
  return boxes;
}

Florence2::Florence2(const std::string& directory)
    : tokenizer_(BpeTokenizer::from_directory(directory)),
      vision_(nullptr),
      embed_(nullptr),
      encoder_(nullptr),
      decoder_(nullptr) {
  const nlohmann::json config = read_json_file(directory + "/config.json");
  image_size_ = config.value("image_size", 768U);
  hidden_size_ = config.value("hidden_size", int64_t{768});
  image_token_id_ = config.value("image_token_id", int64_t{51289});
  bos_token_id_ = config.value("bos_token_id", int64_t{0});
  eos_token_id_ = config.value("eos_token_id", int64_t{2});
  decoder_start_token_id_ = config.value("decoder_start_token_id", int64_t{2});

  OrtRuntime& runtime = OrtRuntime::instance();
  vision_ = runtime.open(
      session_path(directory, config, "vision_encoder_path", "onnx/vision_encoder.onnx"));
  embed_ =
      runtime.open(session_path(directory, config, "embed_tokens_path", "onnx/embed_tokens.onnx"));
  encoder_ =
      runtime.open(session_path(directory, config, "encoder_path", "onnx/encoder_model.onnx"));
  decoder_ =
      runtime.open(session_path(directory, config, "decoder_path", "onnx/decoder_model.onnx"));
}

std::vector<float> Florence2::encode_image(const Rgb8Image& image, int64_t& token_count) {
  // preprocessor_config.json: resize to exactly 768x768, resample 3 = bicubic, no centre
  // crop, so the aspect ratio is squashed just like SAM 2's.
  std::vector<float> pixels =
      preprocess_square(image, image_size_, kImageNetMean, kImageNetStd, Filter::Bicubic);
  const std::array<int64_t, 4> shape{1, 3, image_size_, image_size_};
  std::array<Ort::Value, 1> inputs{float_tensor(pixels, shape)};
  static constexpr std::array<const char*, 1> kInputs{"pixel_values"};
  static constexpr std::array<const char*, 1> kOutputs{"image_features"};

  const std::vector<Ort::Value> outputs =
      vision_.Run(Ort::RunOptions{nullptr}, kInputs.data(), inputs.data(), inputs.size(),
                  kOutputs.data(), kOutputs.size());
  const std::vector<int64_t> features_shape = tensor_shape(outputs[0]);
  if (features_shape.size() != 3) {
    throw std::runtime_error("florence-2: the vision encoder did not return [b, tokens, hidden]");
  }
  token_count = features_shape[1];
  return copy_floats(outputs[0]);
}

std::string Florence2::generate(const std::vector<float>& image_features, int64_t image_tokens,
                                const std::string& prompt) {
  // 577 image placeholders, then BOS, the prompt with no special tokens of its own, EOS.
  std::vector<int64_t> ids(static_cast<size_t>(image_tokens), image_token_id_);
  ids.push_back(bos_token_id_);
  for (int64_t id : tokenizer_.encode(prompt)) {
    ids.push_back(id);
  }
  ids.push_back(eos_token_id_);
  const auto sequence = static_cast<int64_t>(ids.size());

  std::vector<float> embeds;
  {
    const std::array<int64_t, 2> ids_shape{1, sequence};
    std::array<Ort::Value, 1> inputs{int64_tensor(ids, ids_shape)};
    static constexpr std::array<const char*, 1> kInputs{"input_ids"};
    static constexpr std::array<const char*, 1> kOutputs{"inputs_embeds"};
    const std::vector<Ort::Value> outputs =
        embed_.Run(Ort::RunOptions{nullptr}, kInputs.data(), inputs.data(), inputs.size(),
                   kOutputs.data(), kOutputs.size());
    embeds = copy_floats(outputs[0]);
  }
  // transformers scatters the vision embeds onto `input_ids == <image>`; the placeholders
  // are contiguous and first, so a copy over the head of the tensor is the same thing.
  if (embeds.size() < image_features.size()) {
    throw std::runtime_error("florence-2: embed_tokens returned a shorter sequence than the image");
  }
  std::copy(image_features.begin(), image_features.end(), embeds.begin());

  std::vector<int64_t> attention(ids.size(), 1);
  std::vector<float> hidden;
  {
    const std::array<int64_t, 3> embeds_shape{1, sequence, hidden_size_};
    const std::array<int64_t, 2> attention_shape{1, sequence};
    std::array<Ort::Value, 2> inputs{float_tensor(embeds, embeds_shape),
                                     int64_tensor(attention, attention_shape)};
    static constexpr std::array<const char*, 2> kInputs{"inputs_embeds", "attention_mask"};
    static constexpr std::array<const char*, 1> kOutputs{"encoder_hidden_states"};
    const std::vector<Ort::Value> outputs =
        encoder_.Run(Ort::RunOptions{nullptr}, kInputs.data(), inputs.data(), inputs.size(),
                     kOutputs.data(), kOutputs.size());
    hidden = copy_floats(outputs[0]);
  }

  static constexpr std::array<const char*, 3> kDecoderInputs{
      "decoder_input_ids", "encoder_hidden_states", "encoder_attention_mask"};
  static constexpr std::array<const char*, 1> kDecoderOutputs{"logits"};
  const std::array<int64_t, 3> hidden_shape{1, sequence, hidden_size_};
  const std::array<int64_t, 2> attention_shape{1, sequence};

  std::vector<int64_t> tokens{decoder_start_token_id_};
  for (int step = 0; step < kFlorenceMaxNewTokens; ++step) {
    const std::array<int64_t, 2> tokens_shape{1, static_cast<int64_t>(tokens.size())};
    std::array<Ort::Value, 3> inputs{int64_tensor(tokens, tokens_shape),
                                     float_tensor(hidden, hidden_shape),
                                     int64_tensor(attention, attention_shape)};
    const std::vector<Ort::Value> outputs =
        decoder_.Run(Ort::RunOptions{nullptr}, kDecoderInputs.data(), inputs.data(), inputs.size(),
                     kDecoderOutputs.data(), kDecoderOutputs.size());
    const std::vector<int64_t> logits_shape = tensor_shape(outputs[0]);
    if (logits_shape.size() != 3) {
      throw std::runtime_error("florence-2: the decoder did not return [b, tokens, vocab]");
    }
    const int64_t vocabulary = logits_shape[2];
    const float* last = outputs[0].GetTensorData<float>() + ((logits_shape[1] - 1) * vocabulary);
    const int64_t next = std::distance(last, std::max_element(last, last + vocabulary));
    tokens.push_back(next);
    if (next == eos_token_id_ && tokens.size() > 2) break;
  }
  return tokenizer_.decode(tokens);
}

std::optional<DetectionBox> Florence2::detect(const Rgb8Image& image, const std::string& phrase) {
  const size_t first = phrase.find_first_not_of(" \t\n\r");
  const size_t last = phrase.find_last_not_of(" \t\n\r");
  const std::string trimmed =
      first == std::string::npos ? std::string() : phrase.substr(first, last - first + 1);

  int64_t image_tokens = 0;
  const std::vector<float> features = encode_image(image, image_tokens);
  const std::string generated =
      generate(features, image_tokens, "Locate " + trimmed + " in the image.");
  const std::vector<DetectionBox> boxes = parse_boxes(generated, image.width, image.height);
  if (boxes.empty()) return std::nullopt;
  return boxes.front();
}

}  // namespace latent

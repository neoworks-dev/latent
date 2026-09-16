// Florence-2 base: an English phrase in, a box out. SAM 2 has no text input, so this is
// what makes `mask.detect { kind: "text" }` work at all (PROMPT.md 3.5).
//
// Four graphs and a greedy loop. The decoder is stateless — no KV cache, by decision: a
// full re-run costs 2.7 ms per token and a detection answer is 8-12 tokens, so the whole
// loop is ~21 ms and the C++ side never carries 24 KV tensors between calls
// (scripts/models/README.md).
//
// Florence never abstains, which is why only `text` routes through it: `sky` on a studio
// backdrop comes back as 57 % of the frame. The dedicated models own the other kinds.
#pragma once

#include "ai/bpe_tokenizer.h"
#include "image/jpeg.h"

#include <cstdint>
#include <onnxruntime_cxx_api.h>

#include <array>
#include <optional>
#include <string>
#include <vector>

namespace latent {

// x0, y0, x1, y1 in the source image's own pixels, ready for SAM 2.
using DetectionBox = std::array<float, 4>;

// `<loc_###>` bins are 1/1000 of an axis; the box is the bin centre, truncated.
DetectionBox dequantize_box(const std::array<int, 4>& bins, uint32_t width, uint32_t height);

// Every "<label><loc><loc><loc><loc>" group in a generated string. An empty label repeats
// the previous one, which is how <OD> emits two boxes for one category.
std::vector<DetectionBox> parse_boxes(const std::string& text, uint32_t width, uint32_t height);

class Florence2 {
 public:
  explicit Florence2(const std::string& directory);

  // <OPEN_VOCABULARY_DETECTION>: "Locate {phrase} in the image." Returns the first box, or
  // nothing when the model answered without one.
  std::optional<DetectionBox> detect(const Rgb8Image& image, const std::string& phrase);

 private:
  std::vector<float> encode_image(const Rgb8Image& image, int64_t& token_count);
  std::string generate(const std::vector<float>& image_features, int64_t image_tokens,
                       const std::string& prompt);

  BpeTokenizer tokenizer_;
  uint32_t image_size_ = 768;
  int64_t hidden_size_ = 768;
  int64_t image_token_id_ = 51289;
  int64_t bos_token_id_ = 0;
  int64_t eos_token_id_ = 2;
  int64_t decoder_start_token_id_ = 2;
  Ort::Session vision_;
  Ort::Session embed_;
  Ort::Session encoder_;
  Ort::Session decoder_;
};

// A detection answer is 8-12 tokens; 20 is slack, not a budget.
inline constexpr int kFlorenceMaxNewTokens = 20;

}  // namespace latent

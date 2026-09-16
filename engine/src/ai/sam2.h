// SAM 2 hiera-base-plus: a box or a few points in, one soft mask out.
//
// Two graphs. The encoder is the expensive half (~100 ms) and depends only on the image,
// so its three outputs are cached by the detector and reused for every further prompt on
// the same photo. The decoder is 6 ms and cannot batch: `num_labels` must be 1, because
// `has_mask_input` is rank 1 and fails to broadcast at /Mul_14 for N > 1
// (scripts/models/README.md). Several objects are a loop.
#pragma once

#include "image/jpeg.h"

#include <cstdint>
#include <onnxruntime_cxx_api.h>

#include <string>
#include <vector>

namespace latent {

// What the encoder produced for one image, ~17 MB of float32.
struct Sam2Embedding {
  std::vector<float> image_embed;       // [1, 256, 64, 64]
  std::vector<float> high_res_feats_0;  // [1, 32, 256, 256]
  std::vector<float> high_res_feats_1;  // [1, 64, 128, 128]
};

// The decoder's point vocabulary.
enum class Sam2Label : int8_t {
  Background = 0,
  Foreground = 1,
  BoxTopLeft = 2,
  BoxBottomRight = 3,
};

struct Sam2Point {
  // Pixels in the source image; the encoder's 1024x1024 space is this class's business.
  float x = 0;
  float y = 0;
  Sam2Label label = Sam2Label::Foreground;
};

class Sam2 {
 public:
  explicit Sam2(const std::string& directory);

  Sam2Embedding encode(const Rgb8Image& image);

  // One prompt -> the best-IoU candidate as a 0..1 soft mask at the image's own size.
  // The logits are resized before they are squashed, so the edge keeps its sub-pixel
  // detail and the mask has something to feather from.
  std::vector<float> decode(const Sam2Embedding& embedding, const std::vector<Sam2Point>& prompt,
                            uint32_t width, uint32_t height);

 private:
  uint32_t image_size_ = 1024;
  uint32_t mask_size_ = 256;
  Ort::Session encoder_;
  Ort::Session decoder_;
};

}  // namespace latent

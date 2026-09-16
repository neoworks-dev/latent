// The two single-purpose models. Florence-2 -> SAM 2 was measured against both and lost:
// Florence never abstains, so "sky" on a studio backdrop came back as 57 % of the frame and
// "the main subject" degenerated to a rectangle around whatever filled it
// (PROMPT.md 8.1.1). These two answer the same questions in a tenth of the time and get
// them right.
#pragma once

#include "image/jpeg.h"

#include <cstdint>
#include <onnxruntime_cxx_api.h>

#include <array>
#include <string>
#include <vector>

namespace latent {

// BiRefNet-lite: a salient-object alpha matte. `subject` is the matte, `background` is
// 1 - matte, which keeps hair and fur soft in a way inverting a hard mask cannot.
class BiRefNetLite {
 public:
  explicit BiRefNetLite(const std::string& directory);

  // 0..1 alpha at the image's own size. The graph stops at the last decoder conv, so its
  // output is logits — the sigmoid is this function's job, and skipping it silently grows
  // the mask instead of erroring.
  std::vector<float> alpha(const Rgb8Image& image);

 private:
  uint32_t image_size_ = 1024;
  std::array<float, 3> mean_{};
  std::array<float, 3> deviation_{};
  std::string input_name_;
  std::string output_name_;
  Ort::Session session_;
};

// SegFormer-B2 fine-tuned on ADE20K: 150 classes at a quarter resolution.
// Licence is the NVIDIA Source Code License-NC — fine for a personal tool, a blocker if
// Latent is ever sold.
class SegFormerAde {
 public:
  explicit SegFormerAde(const std::string& directory);

  // Softmax probability of one class, upsampled to the image's own size. Upsampling before
  // the decision is what keeps the edge off the 128x128 grid.
  std::vector<float> class_probability(const Rgb8Image& image, int class_id);

  int sky_class() const { return sky_class_; }
  int person_class() const { return person_class_; }

 private:
  uint32_t image_size_ = 512;
  int sky_class_ = 2;
  int person_class_ = 12;
  std::array<float, 3> mean_{};
  std::array<float, 3> deviation_{};
  Ort::Session session_;
};

}  // namespace latent

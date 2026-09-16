// The pixel types Photo Merge works in. Merging happens on the CPU in linear float RGB:
// the maths is a weighted average over a handful of full-res frames, which is memory
// bound rather than ALU bound, so a GPU pass would buy little and cost a second upload
// path. Budget is ~12 bytes per pixel per frame (PROMPT.md 6 has the GPU's own numbers).
#pragma once

#include "image/jpeg.h"
#include "raw/raw_decode.h"

#include <cstdint>

#include <vector>

namespace latent {

// Linear, scene-referred RGB, three floats per pixel, row-major and tightly packed.
// 1.0 is the source raw's white level. The primaries are whatever decode_raw produced —
// today linear sRGB, see raw_decode.cpp — and merging never changes them.
struct LinearImage {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<float> rgb;

  size_t pixel_count() const { return static_cast<size_t>(width) * height; }
  bool empty() const { return rgb.empty(); }
  float* at(uint32_t x, uint32_t y) {
    return rgb.data() + (static_cast<size_t>(y) * width + x) * 3;
  }
  const float* at(uint32_t x, uint32_t y) const {
    return rgb.data() + (static_cast<size_t>(y) * width + x) * 3;
  }
};

// One channel of the same, for alignment. Kept separate because every search below reads
// luminance only and a third of the bytes is a third of the cache misses.
struct GrayF {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<float> v;

  float at(uint32_t x, uint32_t y) const { return v[static_cast<size_t>(y) * width + x]; }
};

LinearImage make_linear(uint32_t width, uint32_t height);

// LibRaw's 16-bit output, divided by the white level. Camera white balance is already in
// it (decode_raw sets use_camera_wb), so the frames of a bracket share a neutral.
LinearImage to_linear(const DecodedRaw& raw);

// An embedded JPEG preview is display-referred sRGB; merge.preview undoes the OETF so the
// same merge code runs on it. Approximate by construction — the camera's preview carries
// its own tone curve, which no transfer function undoes.
LinearImage srgb_to_linear(const Rgb8Image& image);

// Rounds down to 8-bit sRGB for a preview PNG. `scale` divides before the OETF.
Rgb8Image linear_to_srgb(const LinearImage& image, float scale);

GrayF luminance(const LinearImage& image);

// 2x box filter. Odd sizes drop the last row/column rather than replicate it: the
// alignment pyramid only needs the shapes to halve consistently.
LinearImage halve(const LinearImage& image);
GrayF halve(const GrayF& image);

// Box filter to fit `max_edge` on the long side, returning the input when it already does.
LinearImage resize_to_fit(const LinearImage& image, uint32_t max_edge);

// Bilinear fetch. Returns false (and leaves `out` alone) outside the image, which is what
// makes a warped frame's coverage mask fall out of the sampling loop.
bool sample_bilinear(const LinearImage& image, double x, double y, float* out);

}  // namespace latent

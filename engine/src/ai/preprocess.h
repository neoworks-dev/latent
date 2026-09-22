// The pixel arithmetic every mask model shares: one resampler, one normaliser, one way
// back to an r8 raster. Kept apart from the sessions so it can be tested without a GPU,
// a model or onnxruntime.
//
// The resampler is PIL's `ImagingResample` (separable, filter support scaled by the
// downsampling ratio, weights normalised per output pixel), which is what the Python
// reference in `scripts/models/` runs and what torchvision's antialiased `Resize` agrees
// with. When it upsamples, the bilinear filter degenerates to plain bilinear with
// `align_corners=False` — the convention `scripts/models/README.md` requires for the
// 256x256 SAM 2 logits and the 128x128 SegFormer planes.
#pragma once

#include "image/gray.h"
#include "image/jpeg.h"

#include <cstdint>

#include <array>
#include <span>
#include <vector>

namespace latent {

enum class Filter : uint8_t { Bilinear, Bicubic };

// One float plane, row-major, resized. Returns the input when the size already matches.
std::vector<float> resample_plane(std::span<const float> plane, uint32_t src_width,
                                  uint32_t src_height, uint32_t dst_width, uint32_t dst_height,
                                  Filter filter);

// Interleaved RGB8 -> contiguous NCHW float32 [1, 3, size, size], squashed to a square (no
// letterbox: every one of these models was trained that way), scaled to 0..1 and normalised
// per channel. The caller restores the aspect ratio when it maps prompts and masks back.
std::vector<float> preprocess_square(const Rgb8Image& image, uint32_t size,
                                     const std::array<float, 3>& mean,
                                     const std::array<float, 3>& deviation, Filter filter);

// ImageNet statistics, which all four mask models were trained with.
inline constexpr std::array<float, 3> kImageNetMean{0.485F, 0.456F, 0.406F};
inline constexpr std::array<float, 3> kImageNetStd{0.229F, 0.224F, 0.225F};

// A 0..1 plane to the r8 raster the rest of the engine speaks. Values outside the range
// are clamped, so a caller can hand over raw probabilities.
GrayImage plane_to_gray(std::span<const float> plane, uint32_t width, uint32_t height);

// The same at 16 bits, for the depth map: a mask is coverage and tolerates 1/255, a depth
// map is differentiated and compared against itself and does not (ai/depth.h).
Gray16Image plane_to_gray16(std::span<const float> plane, uint32_t width, uint32_t height);

float sigmoid(float value);

}  // namespace latent

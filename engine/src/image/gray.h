// One byte per pixel, row-major, tightly packed: the shape every mask raster has on the
// CPU side, whether it came from a brush stroke list, a PNG cache or a model.
// 0 = outside the mask, 255 = fully inside.
#pragma once

#include <cstdint>

#include <vector>

namespace latent {

struct GrayImage {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> pixels;
};

}  // namespace latent

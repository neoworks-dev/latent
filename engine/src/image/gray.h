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

// Two bytes per pixel, same layout. The depth map is stored like this and a mask raster is
// not: a mask is a coverage a brush feathers anyway, while depth is a smooth surface that
// gets differentiated for a normal and compared against itself for shadows, and one part in
// 255 across a sky reads as terraces in both (ai/depth.h).
struct Gray16Image {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint16_t> pixels;
};

}  // namespace latent

// JPEG in and out for thumbnails, agent previews and (later) export. TurboJPEG 3 API,
// which reports errors by return value instead of libjpeg's setjmp error manager.
#pragma once

#include <cstdint>

#include <span>
#include <string>
#include <vector>

namespace latent {

struct Rgb8Image {
  uint32_t width = 0;
  uint32_t height = 0;
  // Interleaved RGB, 8 bits per channel, tightly packed.
  std::vector<uint8_t> pixels;
};

// Throws std::runtime_error with TurboJPEG's message on failure.
std::vector<uint8_t> encode_jpeg(const Rgb8Image& image, int quality);
Rgb8Image decode_jpeg(std::span<const uint8_t> jpeg);

// Header only: the size of a JPEG without decoding its pixels.
struct ImageSize {
  uint32_t width = 0;
  uint32_t height = 0;
};
ImageSize jpeg_dimensions(std::span<const uint8_t> jpeg);

// Box filter to fit inside `max_edge` on the long side. Returns the input unchanged when
// it is already small enough. Good enough for thumbnails; the GPU path does real resizing.
Rgb8Image box_resize_to_fit(const Rgb8Image& image, uint32_t max_edge);

// rgba8 (the frame format) to rgb8, optionally cropping a rectangle out of it.
Rgb8Image rgba_to_rgb(std::span<const uint8_t> rgba, uint32_t row_pixels, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height);

}  // namespace latent

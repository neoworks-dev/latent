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

// Reorients an image by LibRaw's `imgdata.sizes.flip`, dcraw's bitmask: bit 2 transposes,
// bit 1 mirrors vertically, bit 0 mirrors horizontally. The three values a camera actually
// produces are 3 (180 degrees), 5 (90 CCW) and 6 (90 CW); 0 returns the input unchanged.
// LibRaw applies this inside dcraw_process, but hands the embedded preview back exactly as
// the file stores it, so a thumbnail built from that preview has to do it here.
Rgb8Image rotate_for_flip(const Rgb8Image& image, int flip);

// rgba8 (the frame format) to rgb8, optionally cropping a rectangle out of it.
Rgb8Image rgba_to_rgb(std::span<const uint8_t> rgba, uint32_t row_pixels, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height);

}  // namespace latent

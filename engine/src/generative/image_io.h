// RGB PNG in and out, plus the box resize the crop handed to a model needs. The engine's
// other PNG path (image/png.h) only moves 8-bit grey mask rasters; this one lives beside
// the generative code because that is the only thing that needs colour PNGs, and keeping
// it here is what lets the generative work land without touching the export encoders.
#pragma once

#include "image/jpeg.h"

#include <cstdint>

#include <optional>
#include <span>
#include <string>
#include <vector>

namespace latent {

// Throws std::runtime_error with libpng's message on failure.
std::vector<uint8_t> encode_rgb_png(const Rgb8Image& image);
void write_rgb_png(const std::string& path, const Rgb8Image& image);

// std::nullopt when the bytes are not a PNG this libpng can read. Anything with an alpha
// channel or a palette is converted to plain RGB, which is what the composite uploads.
std::optional<Rgb8Image> decode_rgb_png(std::span<const uint8_t> png);
std::optional<Rgb8Image> read_rgb_png(const std::string& path);

// Writes bytes verbatim, creating the parent directory. The result of a job is stored as
// the backend produced it, so re-encoding cannot lose a bit of it.
void write_file(const std::string& path, std::span<const uint8_t> bytes);

// Box filter, both directions, no cap on the ratio. Returns the input when the size
// already matches.
Rgb8Image box_resize(const Rgb8Image& image, uint32_t width, uint32_t height);

}  // namespace latent

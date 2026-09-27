// Greyscale PNG in and out, 8-bit and 16-bit. The one place the engine needs it is the mask raster
// cache under `<raster dir>/masks/` (ops/mask.h): an AI component's raster is
// expensive to produce and has to survive a restart, so it lands on disk as a PNG rather
// than as base64 inside the sidecar.
#pragma once

#include "image/gray.h"

#include <cstdint>

#include <optional>
#include <string>
#include <vector>

namespace latent {

// Throws std::runtime_error on an I/O or libpng failure.
void write_gray_png(const std::string& path, const GrayImage& image);

// The same bytes, in memory: what MCP's render_preview(mask=...) hands back as an image
// block, and what a test can compare without touching the filesystem.
std::vector<uint8_t> encode_gray_png(const GrayImage& image);

// std::nullopt when the file does not exist; throws when it exists and is not a PNG this
// engine can read.
std::optional<GrayImage> read_gray_png(const std::string& path);

// The same pair for a 16-bit map: the depth cache (`<raster dir>/depth.png`). Written
// and read through libpng's linear-Y format, so the file is a true 16-bit grey PNG and the
// round trip is exact.
void write_gray16_png(const std::string& path, const Gray16Image& image);
std::optional<Gray16Image> read_gray16_png(const std::string& path);

// 16 bits down to 8, for anything that only has to look at the map: the depth preview frame
// on the wire, and the `depth` mask kind's raster.
GrayImage to_gray8(const Gray16Image& image);

// Nearest-neighbour resample of a mask raster into `width` x `height`. Masks are smooth
// and get feathered anyway, so a box filter would only cost time.
GrayImage resample_gray(const GrayImage& image, uint32_t width, uint32_t height);

}  // namespace latent

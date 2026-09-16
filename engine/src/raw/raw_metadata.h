// Catalog-level raw access: the EXIF-ish fields a browser needs, and a small preview.
// Neither call demosaics the file, so importing a folder is I/O bound, not CPU bound.
#pragma once

#include "image/jpeg.h"

#include <cstdint>

#include <string>

namespace latent {

struct RawMetadata {
  uint32_t width = 0;
  uint32_t height = 0;
  std::string camera;
  std::string lens;
  // ISO 8601 without a zone (EXIF has none), empty when the file carries no timestamp.
  std::string captured_at;
  int iso = 0;
  std::string shutter;
  double aperture = 0;
  double focal_length = 0;
};

// True for raf/nef/arw/cr2/cr3/dng/orf/rw2/pef, case-insensitive.
bool is_raw_extension(const std::string& path);

// Throws std::runtime_error with LibRaw's message when the file will not open.
RawMetadata read_raw_metadata(const std::string& path);

// The embedded JPEG preview when the file has one, else a half-size demosaic. Result is
// display-referred rgb8, already fitted into `max_edge` on the long side.
Rgb8Image load_raw_preview(const std::string& path, uint32_t max_edge);

}  // namespace latent

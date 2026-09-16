// One encoder per export format. Everything takes the same buffer — 16-bit RGB already in
// the output colour space, straight off the GPU — and returns the file's bytes, so the job
// runner writes exactly one file per photo and never streams half of one.
//
// JPEG is libjpeg-turbo (via image/jpeg.h) with the ICC spliced in as APP2; PNG is 16-bit
// RGB through libpng; TIFF is libtiff, 16-bit, deflate; AVIF is libavif at 10 bits, and is
// only compiled in when vcpkg supplied it (LATENT_HAVE_AVIF).
#pragma once

#include "export/export_options.h"

#include <cstdint>

#include <span>
#include <string>
#include <vector>

namespace latent {

// Interleaved RGB, 16 bits per channel, row-major, tightly packed.
struct Rgb16Image {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint16_t> pixels;

  size_t expected_size() const { return static_cast<size_t>(width) * height * 3; }
};

struct EncodeOptions {
  ExportFormat format = ExportFormat::Jpeg;
  int quality = 90;
  uint32_t dpi = 0;
  std::vector<uint8_t> icc;
};

// Throws std::runtime_error with the library's own message on failure.
std::vector<uint8_t> encode_export(const Rgb16Image& image, const EncodeOptions& options);

// True when this build can write AVIF. The UI learns the same thing from the schema, so
// this is for the engine's own error message and for the tests.
bool export_avif_available();

// Writes `bytes` through a temporary file and renames it into place, so a cancelled or
// crashed export never leaves a half-written image where a full one is expected.
void write_export_file(const std::string& path, std::span<const uint8_t> bytes);

}  // namespace latent

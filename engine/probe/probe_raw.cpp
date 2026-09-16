// PROMPT.md section 8, step 2: LibRaw decode timing and a PNG of the result.
#include "raw_decode.h"

#include <cmath>
#include <cstdio>
#include <png.h>

#include <exception>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

// 8-bit sRGB-ish preview (gamma 1/2.2) of the linear 16-bit decode, downscaled by `step`.
void write_preview_png(const probe::DecodedRaw& raw, const std::string& path, uint32_t step) {
  const uint32_t width = raw.width / step;
  const uint32_t height = raw.height / step;
  std::vector<uint8_t> row(width * 3);
  FILE* file = std::fopen(path.c_str(), "wb");
  if (file == nullptr) throw std::runtime_error("cannot open " + path);
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  png_infop info = png_create_info_struct(png);
  png_init_io(png, file);
  png_set_IHDR(png, info, width, height, 8, PNG_COLOR_TYPE_RGB, PNG_INTERLACE_NONE,
               PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
  png_write_info(png, info);
  std::vector<uint8_t> lut(65536);
  for (uint32_t v = 0; v < 65536; ++v) {
    lut[v] = static_cast<uint8_t>(255.0 * std::pow(v / 65535.0, 1.0 / 2.2) + 0.5);
  }
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const size_t src =
          (static_cast<size_t>(y) * step * raw.width + static_cast<size_t>(x) * step) * 4;
      row[x * 3 + 0] = lut[raw.rgba[src + 0]];
      row[x * 3 + 1] = lut[raw.rgba[src + 1]];
      row[x * 3 + 2] = lut[raw.rgba[src + 2]];
    }
    png_write_row(png, row.data());
  }
  png_write_end(png, nullptr);
  png_destroy_write_struct(&png, &info);
  std::fclose(file);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: probe_raw <file.raw> [preview.png]\n");
    return 2;
  }
  try {
    probe::DecodedRaw raw = probe::decode_raw(argv[1]);
    std::printf("camera     %s\n", raw.camera.c_str());
    std::printf("size       %ux%u (%.1f MP)\n", raw.width, raw.height,
                raw.width * raw.height / 1e6);
    std::printf("decode     %.0f ms (open + unpack + demosaic)\n", raw.decode_ms);
    std::printf("rgb->rgba  %.0f ms (%zu MB)\n", raw.expand_ms, raw.rgba.size() * 2 / 1000000);
    if (argc >= 3) {
      write_preview_png(raw, argv[2], 4);
      std::printf("preview    %s\n", argv[2]);
    }
    std::printf("RESULT     PASS\n");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "probe_raw failed: %s\n", error.what());
    return 1;
  }
}

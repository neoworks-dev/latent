#include "image/jpeg.h"

#include <turbojpeg.h>

#include <algorithm>
#include <memory>
#include <stdexcept>

namespace latent {

namespace {

struct TjDeleter {
  void operator()(void* handle) const { tj3Destroy(handle); }
};
using TjHandle = std::unique_ptr<void, TjDeleter>;

struct TjBufferDeleter {
  void operator()(unsigned char* buffer) const { tj3Free(buffer); }
};
using TjBuffer = std::unique_ptr<unsigned char, TjBufferDeleter>;

TjHandle make_handle(int init_type) {
  TjHandle handle(tj3Init(init_type));
  if (!handle) throw std::runtime_error("turbojpeg: cannot create handle");
  return handle;
}

[[noreturn]] void fail(const TjHandle& handle, const char* what) {
  throw std::runtime_error(std::string(what) + ": " + tj3GetErrorStr(handle.get()));
}

}  // namespace

std::vector<uint8_t> encode_jpeg(const Rgb8Image& image, int quality) {
  const size_t expected = static_cast<size_t>(image.width) * image.height * 3;
  if (image.width == 0 || image.height == 0 || image.pixels.size() < expected) {
    throw std::runtime_error("encode_jpeg: image is empty or short");
  }
  const TjHandle handle = make_handle(TJINIT_COMPRESS);
  tj3Set(handle.get(), TJPARAM_QUALITY, std::clamp(quality, 1, 100));
  tj3Set(handle.get(), TJPARAM_SUBSAMP, TJSAMP_420);

  unsigned char* raw = nullptr;
  size_t size = 0;
  const int status = tj3Compress8(handle.get(), image.pixels.data(), static_cast<int>(image.width),
                                  0, static_cast<int>(image.height), TJPF_RGB, &raw, &size);
  const TjBuffer owned(raw);
  if (status != 0) fail(handle, "tj3Compress8");
  return std::vector<uint8_t>(owned.get(), owned.get() + size);
}

Rgb8Image decode_jpeg(std::span<const uint8_t> jpeg) {
  const TjHandle handle = make_handle(TJINIT_DECOMPRESS);
  if (tj3DecompressHeader(handle.get(), jpeg.data(), jpeg.size()) != 0) {
    fail(handle, "tj3DecompressHeader");
  }
  Rgb8Image out;
  out.width = static_cast<uint32_t>(tj3Get(handle.get(), TJPARAM_JPEGWIDTH));
  out.height = static_cast<uint32_t>(tj3Get(handle.get(), TJPARAM_JPEGHEIGHT));
  if (out.width == 0 || out.height == 0) throw std::runtime_error("decode_jpeg: empty image");
  out.pixels.resize(static_cast<size_t>(out.width) * out.height * 3);
  if (tj3Decompress8(handle.get(), jpeg.data(), jpeg.size(), out.pixels.data(), 0, TJPF_RGB) != 0) {
    fail(handle, "tj3Decompress8");
  }
  return out;
}

ImageSize jpeg_dimensions(std::span<const uint8_t> jpeg) {
  const TjHandle handle = make_handle(TJINIT_DECOMPRESS);
  if (tj3DecompressHeader(handle.get(), jpeg.data(), jpeg.size()) != 0) {
    fail(handle, "tj3DecompressHeader");
  }
  return {static_cast<uint32_t>(tj3Get(handle.get(), TJPARAM_JPEGWIDTH)),
          static_cast<uint32_t>(tj3Get(handle.get(), TJPARAM_JPEGHEIGHT))};
}

Rgb8Image box_resize_to_fit(const Rgb8Image& image, uint32_t max_edge) {
  const uint32_t longest = std::max(image.width, image.height);
  if (longest <= max_edge || max_edge == 0 || longest == 0) return image;

  Rgb8Image out;
  const double scale = static_cast<double>(max_edge) / longest;
  out.width = std::max(1U, static_cast<uint32_t>(image.width * scale));
  out.height = std::max(1U, static_cast<uint32_t>(image.height * scale));
  out.pixels.resize(static_cast<size_t>(out.width) * out.height * 3);

  for (uint32_t y = 0; y < out.height; ++y) {
    const uint32_t y0 = y * image.height / out.height;
    const uint32_t y1 = std::max(y0 + 1, (y + 1) * image.height / out.height);
    for (uint32_t x = 0; x < out.width; ++x) {
      const uint32_t x0 = x * image.width / out.width;
      const uint32_t x1 = std::max(x0 + 1, (x + 1) * image.width / out.width);
      uint32_t sums[3] = {0, 0, 0};
      uint32_t count = 0;
      for (uint32_t sy = y0; sy < y1; ++sy) {
        for (uint32_t sx = x0; sx < x1; ++sx) {
          const size_t at = (static_cast<size_t>(sy) * image.width + sx) * 3;
          sums[0] += image.pixels[at];
          sums[1] += image.pixels[at + 1];
          sums[2] += image.pixels[at + 2];
          ++count;
        }
      }
      const size_t out_at = (static_cast<size_t>(y) * out.width + x) * 3;
      out.pixels[out_at] = static_cast<uint8_t>(sums[0] / count);
      out.pixels[out_at + 1] = static_cast<uint8_t>(sums[1] / count);
      out.pixels[out_at + 2] = static_cast<uint8_t>(sums[2] / count);
    }
  }
  return out;
}

Rgb8Image rotate_for_flip(const Rgb8Image& image, int flip) {
  if (flip <= 0 || flip > 7) return image;
  const size_t expected = static_cast<size_t>(image.width) * image.height * 3;
  if (image.width == 0 || image.height == 0 || image.pixels.size() < expected) return image;

  const bool transpose = (flip & 4) != 0;
  const bool mirror_rows = (flip & 2) != 0;
  const bool mirror_columns = (flip & 1) != 0;

  Rgb8Image out;
  out.width = transpose ? image.height : image.width;
  out.height = transpose ? image.width : image.height;
  out.pixels.resize(expected);

  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      // Transposing first, then mirroring in the source's own axes, is dcraw's order —
      // reversing it turns 90 CW into 90 CCW.
      uint32_t source_x = transpose ? y : x;
      uint32_t source_y = transpose ? x : y;
      if (mirror_columns) source_x = image.width - 1 - source_x;
      if (mirror_rows) source_y = image.height - 1 - source_y;
      const size_t from = (static_cast<size_t>(source_y) * image.width + source_x) * 3;
      const size_t to = (static_cast<size_t>(y) * out.width + x) * 3;
      out.pixels[to] = image.pixels[from];
      out.pixels[to + 1] = image.pixels[from + 1];
      out.pixels[to + 2] = image.pixels[from + 2];
    }
  }
  return out;
}

Rgb8Image rgba_to_rgb(std::span<const uint8_t> rgba, uint32_t row_pixels, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height) {
  const size_t needed = (static_cast<size_t>(y + height - 1) * row_pixels + x + width) * 4;
  if (width == 0 || height == 0 || rgba.size() < needed) {
    throw std::runtime_error("rgba_to_rgb: rectangle is outside the buffer");
  }
  Rgb8Image out;
  out.width = width;
  out.height = height;
  out.pixels.resize(static_cast<size_t>(width) * height * 3);
  for (uint32_t row = 0; row < height; ++row) {
    const uint8_t* source = rgba.data() + (static_cast<size_t>(y + row) * row_pixels + x) * 4;
    uint8_t* target = out.pixels.data() + static_cast<size_t>(row) * width * 3;
    for (size_t column = 0; column < width; ++column) {
      target[column * 3] = source[column * 4];
      target[column * 3 + 1] = source[column * 4 + 1];
      target[column * 3 + 2] = source[column * 4 + 2];
    }
  }
  return out;
}

}  // namespace latent

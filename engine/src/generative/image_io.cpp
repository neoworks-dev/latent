#include "generative/image_io.h"

#include <png.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace latent {

namespace {

// libpng 1.6's simplified API, the same one image/png.cpp uses: no setjmp, no row pointers.
constexpr int kNoConvertTo8Bit = 0;

void require_pixels(const Rgb8Image& image) {
  if (image.width == 0 || image.height == 0) throw std::runtime_error("empty image");
  if (image.pixels.size() < static_cast<size_t>(image.width) * image.height * 3) {
    throw std::runtime_error("image smaller than its size claims");
  }
}

png_image reader(std::span<const uint8_t> png) {
  png_image in{};
  in.version = PNG_IMAGE_VERSION;
  if (png_image_begin_read_from_memory(&in, png.data(), png.size()) == 0) {
    png_image_free(&in);
    return png_image{};
  }
  // Whatever came back — grey, palette, RGBA — is read as RGB; the composite has no alpha
  // to blend with, the mask is what decides coverage.
  in.format = PNG_FORMAT_RGB;
  return in;
}

}  // namespace

std::vector<uint8_t> encode_rgb_png(const Rgb8Image& image) {
  require_pixels(image);
  png_image out{};
  out.version = PNG_IMAGE_VERSION;
  out.width = image.width;
  out.height = image.height;
  out.format = PNG_FORMAT_RGB;

  png_alloc_size_t size = 0;
  if (png_image_write_to_memory(&out, nullptr, &size, kNoConvertTo8Bit, image.pixels.data(), 0,
                                nullptr) == 0) {
    const std::string message = out.message;
    png_image_free(&out);
    throw std::runtime_error("cannot size the PNG: " + message);
  }
  std::vector<uint8_t> bytes(size);
  const int written = png_image_write_to_memory(&out, bytes.data(), &size, kNoConvertTo8Bit,
                                                image.pixels.data(), 0, nullptr);
  const std::string message = out.message;
  png_image_free(&out);
  if (written == 0) throw std::runtime_error("cannot encode the PNG: " + message);
  bytes.resize(size);
  return bytes;
}

void write_rgb_png(const std::string& path, const Rgb8Image& image) {
  write_file(path, encode_rgb_png(image));
}

std::optional<Rgb8Image> decode_rgb_png(std::span<const uint8_t> png) {
  png_image in = reader(png);
  if (in.version != PNG_IMAGE_VERSION || in.width == 0 || in.height == 0) return std::nullopt;
  Rgb8Image image;
  image.width = in.width;
  image.height = in.height;
  image.pixels.resize(static_cast<size_t>(in.width) * in.height * 3);
  const int read = png_image_finish_read(&in, nullptr, image.pixels.data(), 0, nullptr);
  png_image_free(&in);
  if (read == 0) return std::nullopt;
  return image;
}

std::optional<Rgb8Image> read_rgb_png(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return std::nullopt;
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                                   std::istreambuf_iterator<char>());
  if (bytes.empty()) return std::nullopt;
  return decode_rgb_png(bytes);
}

void write_file(const std::string& path, std::span<const uint8_t> bytes) {
  std::error_code error;
  std::filesystem::create_directories(std::filesystem::path(path).parent_path(), error);
  const std::string temporary = path + ".tmp";
  {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    if (!file) throw std::runtime_error("cannot write " + temporary);
    file.write(reinterpret_cast<const char*>(bytes.data()),
               static_cast<std::streamsize>(bytes.size()));
    if (!file) throw std::runtime_error("write failed for " + temporary);
  }
  std::filesystem::rename(temporary, path, error);
  if (error) throw std::runtime_error("cannot replace " + path + ": " + error.message());
}

Rgb8Image box_resize(const Rgb8Image& image, uint32_t width, uint32_t height) {
  if (width == 0 || height == 0) throw std::runtime_error("cannot resize to nothing");
  if (image.width == width && image.height == height) return image;
  require_pixels(image);

  Rgb8Image out;
  out.width = width;
  out.height = height;
  out.pixels.resize(static_cast<size_t>(width) * height * 3);
  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t y0 = (static_cast<uint64_t>(y) * image.height) / height;
    const uint32_t y1 = std::max(
        y0 + 1, static_cast<uint32_t>((static_cast<uint64_t>(y + 1) * image.height) / height));
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t x0 = (static_cast<uint64_t>(x) * image.width) / width;
      const uint32_t x1 = std::max(
          x0 + 1, static_cast<uint32_t>((static_cast<uint64_t>(x + 1) * image.width) / width));
      uint32_t sums[3] = {0, 0, 0};
      uint32_t counted = 0;
      for (uint32_t sy = y0; sy < std::min(y1, image.height); ++sy) {
        for (uint32_t sx = x0; sx < std::min(x1, image.width); ++sx) {
          const size_t at = ((static_cast<size_t>(sy) * image.width) + sx) * 3;
          sums[0] += image.pixels[at];
          sums[1] += image.pixels[at + 1];
          sums[2] += image.pixels[at + 2];
          ++counted;
        }
      }
      const size_t to = ((static_cast<size_t>(y) * width) + x) * 3;
      const uint32_t divisor = std::max(counted, 1U);
      out.pixels[to] = static_cast<uint8_t>(sums[0] / divisor);
      out.pixels[to + 1] = static_cast<uint8_t>(sums[1] / divisor);
      out.pixels[to + 2] = static_cast<uint8_t>(sums[2] / divisor);
    }
  }
  return out;
}

}  // namespace latent

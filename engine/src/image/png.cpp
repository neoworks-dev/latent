#include "image/png.h"

#include <cstring>
#include <png.h>

#include <algorithm>
#include <filesystem>
#include <stdexcept>

namespace latent {

namespace {

// libpng 1.6's simplified API: no setjmp, no row pointers, no error struct to keep alive
// across a longjmp. The engine only ever moves whole 8-bit grey rasters, which is exactly
// what it is for.
constexpr int kNoConvertTo8Bit = 0;

}  // namespace

void write_gray_png(const std::string& path, const GrayImage& image) {
  if (image.width == 0 || image.height == 0) throw std::runtime_error("empty mask raster");
  if (image.pixels.size() < static_cast<size_t>(image.width) * image.height) {
    throw std::runtime_error("mask raster smaller than its size claims");
  }
  std::error_code error;
  std::filesystem::create_directories(std::filesystem::path(path).parent_path(), error);

  png_image out{};
  out.version = PNG_IMAGE_VERSION;
  out.width = image.width;
  out.height = image.height;
  out.format = PNG_FORMAT_GRAY;
  const int written = png_image_write_to_file(&out, path.c_str(), kNoConvertTo8Bit,
                                              image.pixels.data(), 0, nullptr);
  const std::string message = out.message;
  png_image_free(&out);
  if (written == 0) throw std::runtime_error("cannot write " + path + ": " + message);
}

std::vector<uint8_t> encode_gray_png(const GrayImage& image) {
  if (image.width == 0 || image.height == 0) throw std::runtime_error("empty mask raster");
  png_image out{};
  out.version = PNG_IMAGE_VERSION;
  out.width = image.width;
  out.height = image.height;
  out.format = PNG_FORMAT_GRAY;

  png_alloc_size_t size = 0;
  if (png_image_write_to_memory(&out, nullptr, &size, kNoConvertTo8Bit, image.pixels.data(), 0,
                                nullptr) == 0) {
    const std::string message = out.message;
    png_image_free(&out);
    throw std::runtime_error("cannot size the mask PNG: " + message);
  }
  std::vector<uint8_t> bytes(size);
  const int written = png_image_write_to_memory(&out, bytes.data(), &size, kNoConvertTo8Bit,
                                                image.pixels.data(), 0, nullptr);
  const std::string message = out.message;
  png_image_free(&out);
  if (written == 0) throw std::runtime_error("cannot encode the mask PNG: " + message);
  bytes.resize(size);
  return bytes;
}

std::optional<GrayImage> read_gray_png(const std::string& path) {
  std::error_code error;
  if (!std::filesystem::is_regular_file(path, error)) return std::nullopt;

  png_image in{};
  in.version = PNG_IMAGE_VERSION;
  if (png_image_begin_read_from_file(&in, path.c_str()) == 0) {
    const std::string message = in.message;
    png_image_free(&in);
    throw std::runtime_error("cannot read " + path + ": " + message);
  }
  in.format = PNG_FORMAT_GRAY;

  GrayImage image;
  image.width = in.width;
  image.height = in.height;
  image.pixels.resize(PNG_IMAGE_SIZE(in));
  const int read = png_image_finish_read(&in, nullptr, image.pixels.data(), 0, nullptr);
  const std::string message = in.message;
  png_image_free(&in);
  if (read == 0) throw std::runtime_error("cannot decode " + path + ": " + message);
  return image;
}

GrayImage resample_gray(const GrayImage& image, uint32_t width, uint32_t height) {
  if (image.width == width && image.height == height) return image;
  GrayImage out;
  out.width = width;
  out.height = height;
  out.pixels.assign(static_cast<size_t>(width) * height, 0);
  if (image.width == 0 || image.height == 0 || width == 0 || height == 0) return out;
  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t source_y =
        std::min(image.height - 1, static_cast<uint32_t>((y + 0.5) * image.height / height));
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t source_x =
          std::min(image.width - 1, static_cast<uint32_t>((x + 0.5) * image.width / width));
      out.pixels[(static_cast<size_t>(y) * width) + x] =
          image.pixels[(static_cast<size_t>(source_y) * image.width) + source_x];
    }
  }
  return out;
}

}  // namespace latent

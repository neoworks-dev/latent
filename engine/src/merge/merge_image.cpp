#include "merge/merge_image.h"

#include <cmath>

#include <algorithm>

namespace latent {

namespace {

// Rec.709 luma. The working space is linear sRGB today (raw_decode.cpp), so these are the
// matching coefficients; a move to Rec.2020 changes them here and nowhere else.
constexpr float kLumaR = 0.2126F;
constexpr float kLumaG = 0.7152F;
constexpr float kLumaB = 0.0722F;

float srgb_decode(uint8_t value) {
  const float v = static_cast<float>(value) / 255.0F;
  if (v <= 0.04045F) return v / 12.92F;
  return std::pow((v + 0.055F) / 1.055F, 2.4F);
}

uint8_t srgb_encode(float value) {
  const float v = std::clamp(value, 0.0F, 1.0F);
  const float encoded = v <= 0.0031308F ? v * 12.92F : 1.055F * std::pow(v, 1.0F / 2.4F) - 0.055F;
  return static_cast<uint8_t>(std::lround(encoded * 255.0F));
}

}  // namespace

LinearImage make_linear(uint32_t width, uint32_t height) {
  LinearImage image;
  image.width = width;
  image.height = height;
  image.rgb.assign(static_cast<size_t>(width) * height * 3, 0.0F);
  return image;
}

LinearImage to_linear(const DecodedRaw& raw) {
  LinearImage image = make_linear(raw.width, raw.height);
  const size_t pixels = image.pixel_count();
  for (size_t i = 0; i < pixels; ++i) {
    image.rgb[i * 3 + 0] = static_cast<float>(raw.rgba[i * 4 + 0]) / 65535.0F;
    image.rgb[i * 3 + 1] = static_cast<float>(raw.rgba[i * 4 + 1]) / 65535.0F;
    image.rgb[i * 3 + 2] = static_cast<float>(raw.rgba[i * 4 + 2]) / 65535.0F;
  }
  return image;
}

LinearImage srgb_to_linear(const Rgb8Image& source) {
  LinearImage image = make_linear(source.width, source.height);
  const size_t pixels = image.pixel_count();
  for (size_t i = 0; i < pixels * 3; ++i) {
    image.rgb[i] = srgb_decode(source.pixels[i]);
  }
  return image;
}

Rgb8Image linear_to_srgb(const LinearImage& image, float scale) {
  Rgb8Image out;
  out.width = image.width;
  out.height = image.height;
  out.pixels.resize(image.pixel_count() * 3);
  for (size_t i = 0; i < out.pixels.size(); ++i) {
    out.pixels[i] = srgb_encode(image.rgb[i] * scale);
  }
  return out;
}

GrayF luminance(const LinearImage& image) {
  GrayF gray;
  gray.width = image.width;
  gray.height = image.height;
  gray.v.resize(image.pixel_count());
  for (size_t i = 0; i < gray.v.size(); ++i) {
    gray.v[i] = kLumaR * image.rgb[i * 3 + 0] + kLumaG * image.rgb[i * 3 + 1] +
                kLumaB * image.rgb[i * 3 + 2];
  }
  return gray;
}

LinearImage halve(const LinearImage& image) {
  LinearImage out = make_linear(std::max(1U, image.width / 2), std::max(1U, image.height / 2));
  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      float* target = out.at(x, y);
      for (int channel = 0; channel < 3; ++channel) {
        const float sum = image.at(x * 2, y * 2)[channel] + image.at(x * 2 + 1, y * 2)[channel] +
                          image.at(x * 2, y * 2 + 1)[channel] +
                          image.at(x * 2 + 1, y * 2 + 1)[channel];
        target[channel] = sum * 0.25F;
      }
    }
  }
  return out;
}

GrayF halve(const GrayF& image) {
  GrayF out;
  out.width = std::max(1U, image.width / 2);
  out.height = std::max(1U, image.height / 2);
  out.v.resize(static_cast<size_t>(out.width) * out.height);
  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      out.v[static_cast<size_t>(y) * out.width + x] =
          (image.at(x * 2, y * 2) + image.at(x * 2 + 1, y * 2) + image.at(x * 2, y * 2 + 1) +
           image.at(x * 2 + 1, y * 2 + 1)) *
          0.25F;
    }
  }
  return out;
}

LinearImage resize_to_fit(const LinearImage& image, uint32_t max_edge) {
  const uint32_t longest = std::max(image.width, image.height);
  if (longest <= max_edge || max_edge == 0) return image;
  const double scale = static_cast<double>(max_edge) / longest;
  LinearImage out = make_linear(std::max(1U, static_cast<uint32_t>(image.width * scale)),
                                std::max(1U, static_cast<uint32_t>(image.height * scale)));
  const double step_x = static_cast<double>(image.width) / out.width;
  const double step_y = static_cast<double>(image.height) / out.height;
  for (uint32_t y = 0; y < out.height; ++y) {
    const auto y0 = static_cast<uint32_t>(y * step_y);
    const auto y1 = std::min(image.height, static_cast<uint32_t>((y + 1) * step_y) + 1);
    for (uint32_t x = 0; x < out.width; ++x) {
      const auto x0 = static_cast<uint32_t>(x * step_x);
      const auto x1 = std::min(image.width, static_cast<uint32_t>((x + 1) * step_x) + 1);
      float sum[3] = {0, 0, 0};
      uint32_t count = 0;
      for (uint32_t sy = y0; sy < y1; ++sy) {
        for (uint32_t sx = x0; sx < x1; ++sx) {
          const float* source = image.at(sx, sy);
          sum[0] += source[0];
          sum[1] += source[1];
          sum[2] += source[2];
          ++count;
        }
      }
      float* target = out.at(x, y);
      const float inverse = count == 0 ? 0.0F : 1.0F / static_cast<float>(count);
      target[0] = sum[0] * inverse;
      target[1] = sum[1] * inverse;
      target[2] = sum[2] * inverse;
    }
  }
  return out;
}

bool sample_bilinear(const LinearImage& image, double x, double y, float* out) {
  if (x < 0 || y < 0 || x > image.width - 1.0 || y > image.height - 1.0) return false;
  const auto x0 = static_cast<uint32_t>(x);
  const auto y0 = static_cast<uint32_t>(y);
  const uint32_t x1 = std::min(x0 + 1, image.width - 1);
  const uint32_t y1 = std::min(y0 + 1, image.height - 1);
  const auto fx = static_cast<float>(x - x0);
  const auto fy = static_cast<float>(y - y0);
  const float* p00 = image.at(x0, y0);
  const float* p10 = image.at(x1, y0);
  const float* p01 = image.at(x0, y1);
  const float* p11 = image.at(x1, y1);
  for (int channel = 0; channel < 3; ++channel) {
    const float top = p00[channel] + (p10[channel] - p00[channel]) * fx;
    const float bottom = p01[channel] + (p11[channel] - p01[channel]) * fx;
    out[channel] = top + (bottom - top) * fy;
  }
  return true;
}

}  // namespace latent

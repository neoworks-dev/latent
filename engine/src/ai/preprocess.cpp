#include "ai/preprocess.h"

#include <cmath>

#include <algorithm>
#include <stdexcept>

namespace latent {

namespace {

double bilinear_filter(double x) {
  if (x < 0.0) x = -x;
  return x < 1.0 ? 1.0 - x : 0.0;
}

// PIL's bicubic with a = -0.5, which is what `resample: 3` means in Florence-2's
// preprocessor_config.json.
double bicubic_filter(double x) {
  constexpr double kA = -0.5;
  if (x < 0.0) x = -x;
  if (x < 1.0) return (((kA + 2.0) * x) - (kA + 3.0)) * x * x + 1.0;
  if (x < 2.0) return ((((x - 5.0) * x) + 8.0) * x - 4.0) * kA;
  return 0.0;
}

double filter_support(Filter filter) {
  return filter == Filter::Bicubic ? 2.0 : 1.0;
}

double apply_filter(Filter filter, double x) {
  return filter == Filter::Bicubic ? bicubic_filter(x) : bilinear_filter(x);
}

// One output pixel's taps: where they start, how many there are, and their weights.
struct Coefficients {
  int taps = 0;
  std::vector<int> first;
  std::vector<int> count;
  std::vector<double> weights;  // `taps` per output pixel, zero-padded.
};

Coefficients precompute(uint32_t in_size, uint32_t out_size, Filter filter) {
  const double scale = static_cast<double>(in_size) / out_size;
  const double filter_scale = std::max(scale, 1.0);
  const double support = filter_support(filter) * filter_scale;

  Coefficients coefficients;
  coefficients.taps = (static_cast<int>(std::ceil(support)) * 2) + 1;
  coefficients.first.resize(out_size);
  coefficients.count.resize(out_size);
  coefficients.weights.assign(static_cast<size_t>(out_size) * coefficients.taps, 0.0);

  for (uint32_t out = 0; out < out_size; ++out) {
    const double center = (out + 0.5) * scale;
    const int first = std::max(0, static_cast<int>(center - support + 0.5));
    const int last = std::min(static_cast<int>(in_size), static_cast<int>(center + support + 0.5));
    double* weights = coefficients.weights.data() + (static_cast<size_t>(out) * coefficients.taps);
    double total = 0.0;
    for (int tap = 0; tap < last - first; ++tap) {
      const double weight = apply_filter(filter, (tap + first - center + 0.5) / filter_scale);
      weights[tap] = weight;
      total += weight;
    }
    if (total != 0.0) {
      for (int tap = 0; tap < last - first; ++tap) {
        weights[tap] /= total;
      }
    }
    coefficients.first[out] = first;
    coefficients.count[out] = last - first;
  }
  return coefficients;
}

// Resamples along x only: [height, in_width] -> [height, out_width].
std::vector<float> resample_horizontal(std::span<const float> plane, uint32_t in_width,
                                       uint32_t height, uint32_t out_width, Filter filter) {
  const Coefficients coefficients = precompute(in_width, out_width, filter);
  std::vector<float> out(static_cast<size_t>(out_width) * height);
  for (uint32_t y = 0; y < height; ++y) {
    const float* row = plane.data() + (static_cast<size_t>(y) * in_width);
    float* target = out.data() + (static_cast<size_t>(y) * out_width);
    for (uint32_t x = 0; x < out_width; ++x) {
      const double* weights =
          coefficients.weights.data() + (static_cast<size_t>(x) * coefficients.taps);
      const int first = coefficients.first[x];
      double sum = 0.0;
      for (int tap = 0; tap < coefficients.count[x]; ++tap) {
        sum += weights[tap] * row[first + tap];
      }
      target[x] = static_cast<float>(sum);
    }
  }
  return out;
}

// Resamples along y only: [in_height, width] -> [out_height, width].
std::vector<float> resample_vertical(std::span<const float> plane, uint32_t width,
                                     uint32_t in_height, uint32_t out_height, Filter filter) {
  const Coefficients coefficients = precompute(in_height, out_height, filter);
  std::vector<float> out(static_cast<size_t>(width) * out_height);
  for (uint32_t y = 0; y < out_height; ++y) {
    const double* weights =
        coefficients.weights.data() + (static_cast<size_t>(y) * coefficients.taps);
    const int first = coefficients.first[y];
    float* target = out.data() + (static_cast<size_t>(y) * width);
    for (uint32_t x = 0; x < width; ++x) {
      double sum = 0.0;
      for (int tap = 0; tap < coefficients.count[y]; ++tap) {
        sum += weights[tap] * plane[(static_cast<size_t>(first + tap) * width) + x];
      }
      target[x] = static_cast<float>(sum);
    }
  }
  return out;
}

}  // namespace

std::vector<float> resample_plane(std::span<const float> plane, uint32_t src_width,
                                  uint32_t src_height, uint32_t dst_width, uint32_t dst_height,
                                  Filter filter) {
  if (plane.size() != static_cast<size_t>(src_width) * src_height) {
    throw std::runtime_error("resample_plane: plane does not match its declared size");
  }
  if (dst_width == 0 || dst_height == 0) return {};
  if (src_width == dst_width && src_height == dst_height) {
    return {plane.begin(), plane.end()};
  }
  if (src_width == dst_width) {
    return resample_vertical(plane, src_width, src_height, dst_height, filter);
  }
  const std::vector<float> wide =
      resample_horizontal(plane, src_width, src_height, dst_width, filter);
  if (src_height == dst_height) return wide;
  return resample_vertical(wide, dst_width, src_height, dst_height, filter);
}

std::vector<float> preprocess_square(const Rgb8Image& image, uint32_t size,
                                     const std::array<float, 3>& mean,
                                     const std::array<float, 3>& deviation, Filter filter) {
  if (image.width == 0 || image.height == 0) {
    throw std::runtime_error("preprocess_square: the input image is empty");
  }
  if (image.pixels.size() < static_cast<size_t>(image.width) * image.height * 3) {
    throw std::runtime_error("preprocess_square: the input image is short of pixels");
  }

  const size_t pixel_count = static_cast<size_t>(image.width) * image.height;
  std::vector<float> plane(pixel_count);
  std::vector<float> out(static_cast<size_t>(size) * size * 3);
  for (size_t channel = 0; channel < 3; ++channel) {
    for (size_t i = 0; i < pixel_count; ++i) {
      plane[i] = static_cast<float>(image.pixels[(i * 3) + channel]);
    }
    const std::vector<float> resized =
        resample_plane(plane, image.width, image.height, size, size, filter);
    float* target = out.data() + (channel * size * size);
    for (size_t i = 0; i < resized.size(); ++i) {
      target[i] = ((resized[i] / 255.0F) - mean[channel]) / deviation[channel];
    }
  }
  return out;
}

Gray16Image plane_to_gray16(std::span<const float> plane, uint32_t width, uint32_t height) {
  if (plane.size() != static_cast<size_t>(width) * height) {
    throw std::runtime_error("plane_to_gray16: plane does not match its declared size");
  }
  Gray16Image image;
  image.width = width;
  image.height = height;
  image.pixels.resize(plane.size());
  for (size_t i = 0; i < plane.size(); ++i) {
    const float clamped = std::clamp(plane[i], 0.0F, 1.0F);
    image.pixels[i] = static_cast<uint16_t>(std::lround(clamped * 65535.0F));
  }
  return image;
}

GrayImage plane_to_gray(std::span<const float> plane, uint32_t width, uint32_t height) {
  if (plane.size() != static_cast<size_t>(width) * height) {
    throw std::runtime_error("plane_to_gray: plane does not match its declared size");
  }
  GrayImage image;
  image.width = width;
  image.height = height;
  image.pixels.resize(plane.size());
  for (size_t i = 0; i < plane.size(); ++i) {
    const float clamped = std::clamp(plane[i], 0.0F, 1.0F);
    image.pixels[i] = static_cast<uint8_t>(std::lround(clamped * 255.0F));
  }
  return image;
}

float sigmoid(float value) {
  return 1.0F / (1.0F + std::exp(-value));
}

}  // namespace latent

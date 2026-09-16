#include "ai/mask_detect.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include <algorithm>
#include <string_view>

namespace latent {

namespace {

// The stub works at a fixed size and the raster is resampled per view, so the shape does
// not change when the window does.
constexpr uint32_t kStubLongEdge = 1024;

GrayImage blank(uint32_t width, uint32_t height) {
  GrayImage image;
  image.width = width;
  image.height = height;
  image.pixels.assign(static_cast<size_t>(width) * height, 0);
  return image;
}

// A soft centre ellipse: what "the subject" looks like to something that cannot see.
GrayImage centre_ellipse(uint32_t width, uint32_t height, double radius_x, double radius_y) {
  GrayImage image = blank(width, height);
  for (uint32_t y = 0; y < height; ++y) {
    const double dy = (((y + 0.5) / height) - 0.5) / radius_y;
    for (uint32_t x = 0; x < width; ++x) {
      const double dx = (((x + 0.5) / width) - 0.5) / radius_x;
      const double reach = std::sqrt((dx * dx) + (dy * dy));
      const double t = std::clamp((1.0 - reach) / 0.15, 0.0, 1.0);
      image.pixels[(static_cast<size_t>(y) * width) + x] =
          static_cast<uint8_t>(std::lround(t * t * (3.0 - (2.0 * t)) * 255));
    }
  }
  return image;
}

// The top 40 % fading out: what a sky is, roughly, when the horizon is where it usually is.
GrayImage top_gradient(uint32_t width, uint32_t height) {
  GrayImage image = blank(width, height);
  for (uint32_t y = 0; y < height; ++y) {
    const double v = (y + 0.5) / height;
    const double t = std::clamp((0.45 - v) / 0.15, 0.0, 1.0);
    const auto level = static_cast<uint8_t>(std::lround(t * t * (3.0 - (2.0 * t)) * 255));
    std::memset(image.pixels.data() + (static_cast<size_t>(y) * width), level, width);
  }
  return image;
}

GrayImage inverted(GrayImage image) {
  for (uint8_t& pixel : image.pixels) {
    pixel = static_cast<uint8_t>(255 - pixel);
  }
  return image;
}

class StubDetector : public MaskDetector {
 public:
  std::string name() const override { return "stub-shapes"; }

  MaskDetectResult detect(const MaskDetectRequest& request) override {
    const double aspect = request.image.width == 0 || request.image.height == 0
                              ? 1.0
                              : static_cast<double>(request.image.width) / request.image.height;
    uint32_t width = kStubLongEdge;
    auto height = static_cast<uint32_t>(std::lround(kStubLongEdge / std::max(aspect, 1e-3)));
    if (height > kStubLongEdge) {
      height = kStubLongEdge;
      width = static_cast<uint32_t>(std::lround(kStubLongEdge * aspect));
    }
    width = std::max(width, 1U);
    height = std::max(height, 1U);

    MaskDetectResult result;
    result.ok = true;
    result.model = name();
    switch (request.kind) {
      case MaskKind::Sky:
        result.raster = top_gradient(width, height);
        return result;
      case MaskKind::Background:
        result.raster = inverted(centre_ellipse(width, height, 0.28, 0.38));
        return result;
      case MaskKind::Depth:
        result.raster = inverted(top_gradient(width, height));
        return result;
      default:
        result.raster = centre_ellipse(width, height, 0.28, 0.38);
        return result;
    }
  }
};

class MissingModelDetector : public MaskDetector {
 public:
  std::string name() const override { return "none"; }

  MaskDetectResult detect(const MaskDetectRequest&) override {
    MaskDetectResult result;
    result.ok = false;
    result.message = "model not installed";
    return result;
  }
};

}  // namespace

std::unique_ptr<MaskDetector> make_mask_detector() {
  const char* stub = std::getenv("LATENT_MASK_STUB");
  if (stub != nullptr && std::string_view(stub) == "1") {
    return std::make_unique<StubDetector>();
  }
  return std::make_unique<MissingModelDetector>();
}

}  // namespace latent

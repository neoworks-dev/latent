// The backend that needs nothing installed: it fills the masked area with a blurred, tinted
// copy of the crop. LATENT_GENERATIVE_STUB=1 selects it, and the tests and the screenshot
// flow run on it, so the whole path — crop, mask, job, result PNG, composite, staleness —
// is exercised on a machine with no ComfyUI and no spare VRAM.
//
// It is deliberately not subtle. A stub that looked like a real inpaint would make a broken
// ComfyUI path indistinguishable from a working one in a screenshot.
//
// The whole-frame tasks (`denoise`, `upscale`, issues #51 and #52) arrive here with no
// mask and stand in the same way: denoise softens the frame, upscale enlarges it by the
// factor the op asked for, and both come back at the size the composite expects.
#include "generative/backend.h"
#include "generative/image_io.h"

#include <chrono>
#include <cmath>

#include <algorithm>
#include <array>
#include <numbers>
#include <optional>

namespace latent {

namespace {

// How far the crop is shrunk before being scaled back up: the blur radius, in effect.
constexpr uint32_t kBlurDivisor = 12;
// The same trick for the denoise stub. Hard enough to be unmistakable at proxy resolution:
// the whole point of a stub is that a screenshot, or a smoke assertion, can tell a working
// composite from a backend that quietly did nothing.
constexpr uint32_t kStubDenoiseDivisor = 8;

// A hue per seed, so two runs of the same op are visibly two runs.
std::array<double, 3> seed_tint(int64_t seed) {
  const double angle = static_cast<double>(seed % 360) * std::numbers::pi / 180.0;
  return {0.5 + (0.5 * std::cos(angle)), 0.5 + (0.5 * std::cos(angle - 2.094)),
          0.5 + (0.5 * std::cos(angle + 2.094))};
}

class StubBackend : public GenerativeBackend {
 public:
  std::string name() const override { return "stub"; }

  GenerativeResult run(const GenerativeRequest& request,
                       const GenerativeProgress& progress) override {
    const auto started = std::chrono::steady_clock::now();
    GenerativeResult result;
    result.model = "stub-blur";
    result.workflow = "stub";

    const std::optional<Rgb8Image> image = decode_rgb_png(request.image);
    if (!image.has_value()) {
      result.code = "bad_input";
      result.message = "the crop handed to the stub backend is not a PNG";
      return result;
    }
    if (request.task == "denoise" || request.task == "upscale") {
      whole_frame(request, *image, progress, result);
      result.elapsed_ms =
          std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
              .count();
      return result;
    }
    // A grey PNG read as RGB replicates into all three channels, so red is the coverage.
    const std::optional<Rgb8Image> mask = decode_rgb_png(request.mask);
    if (!mask.has_value() || mask->width != image->width || mask->height != image->height) {
      result.code = "bad_input";
      result.message = "the mask handed to the stub backend does not match the crop";
      return result;
    }
    if (progress && !progress(0.5, "stub")) {
      result.code = "cancelled";
      result.message = "cancelled";
      return result;
    }

    Rgb8Image out = *image;
    const Rgb8Image blurred = blur(*image);
    const std::array<double, 3> tint = seed_tint(request.seed);
    for (size_t pixel = 0; pixel < static_cast<size_t>(out.width) * out.height; ++pixel) {
      const double coverage = mask->pixels[pixel * 3] / 255.0;
      if (coverage <= 0) continue;
      for (size_t channel = 0; channel < 3; ++channel) {
        const double under = out.pixels[(pixel * 3) + channel] / 255.0;
        const double over = (blurred.pixels[(pixel * 3) + channel] / 255.0) * tint[channel];
        const double mixed = under + ((over - under) * coverage);
        out.pixels[(pixel * 3) + channel] =
            static_cast<uint8_t>(std::lround(std::clamp(mixed, 0.0, 1.0) * 255));
      }
    }

    result.ok = true;
    result.png = encode_rgb_png(out);
    result.elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
            .count();
    return result;
  }

 private:
  // `denoise` and `upscale` take the whole frame and give back the whole frame. Neither
  // pretends to be a model: denoise is the same blur the fill stub uses, at a gentler
  // radius, and upscale is a box enlargement, which is exactly the "crushed plastic" a real
  // upscaler is there to avoid.
  static void whole_frame(const GenerativeRequest& request, const Rgb8Image& image,
                          const GenerativeProgress& progress, GenerativeResult& result) {
    if (progress && !progress(0.5, "stub")) {
      result.code = "cancelled";
      result.message = "cancelled";
      return;
    }
    if (request.task == "upscale") {
      const double scale = std::max(1.0, request.scale);
      const auto width = static_cast<uint32_t>(std::lround(image.width * scale));
      const auto height = static_cast<uint32_t>(std::lround(image.height * scale));
      result.model = "stub-resize";
      result.png = encode_rgb_png(box_resize(image, std::max(1U, width), std::max(1U, height)));
      result.ok = true;
      return;
    }
    const uint32_t width = std::max(1U, image.width / kStubDenoiseDivisor);
    const uint32_t height = std::max(1U, image.height / kStubDenoiseDivisor);
    result.png =
        encode_rgb_png(box_resize(box_resize(image, width, height), image.width, image.height));
    result.ok = true;
  }

  // Down and back up with the box filter that is already here: cheap, and blurry enough
  // that the patch reads as "something replaced this".
  static Rgb8Image blur(const Rgb8Image& image) {
    const uint32_t width = std::max(1U, image.width / kBlurDivisor);
    const uint32_t height = std::max(1U, image.height / kBlurDivisor);
    return box_resize(box_resize(image, width, height), image.width, image.height);
  }
};

}  // namespace

std::unique_ptr<GenerativeBackend> make_stub_backend() {
  return std::make_unique<StubBackend>();
}

}  // namespace latent

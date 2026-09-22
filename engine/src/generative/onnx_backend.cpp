// The denoise backend that runs in this process: SCUNet through onnxruntime, tiled, no
// ComfyUI and no server (issue #51, ai/denoise.h).
//
// It answers `denoise` only. Fill, remove and upscale stay with ComfyUI — they want a
// generator and a graph; a denoise wants one restoration network and nothing else, and
// asking a diffusion sampler to do it is what made the first build of AI Denoise soften
// frames instead of cleaning them.
//
// Strength is a blend between the frame as it arrived and the frame the model returned.
// SCUNet has no noise-level input — it is trained to decide how much noise is there — so
// the only honest knob is how much of its answer to keep, which is also what a user means
// by the slider.
#include "ai/denoise.h"
#include "ai/model_store.h"
#include "generative/backend.h"
#include "generative/image_io.h"

#include <chrono>
#include <cmath>

#include <algorithm>
#include <optional>
#include <string>

namespace latent {

namespace {

class OnnxDenoiseBackend : public GenerativeBackend {
 public:
  std::string name() const override { return "onnx"; }

  GenerativeResult run(const GenerativeRequest& request,
                       const GenerativeProgress& progress) override {
    const auto started = std::chrono::steady_clock::now();
    GenerativeResult result;
    result.model = std::string(kDenoiseModel);
    result.workflow = "scunet";

    if (request.task != "denoise") {
      result.code = "no_workflow";
      result.message = "the local model backend only runs `denoise`";
      return result;
    }
    if (!model_installed(kDenoiseModel)) {
      result.code = "model_missing";
      result.message = missing_model_message(kDenoiseModel);
      result.hint = "run scripts/models/fetch.py";
      return result;
    }
    const std::optional<Rgb8Image> image = decode_rgb_png(request.image);
    if (!image.has_value()) {
      result.code = "bad_input";
      result.message = "the frame handed to the denoise backend is not a PNG";
      return result;
    }

    try {
      ScuNet model(model_dir(kDenoiseModel));
      const std::optional<Rgb8Image> cleaned =
          model.denoise(*image, [&](double fraction) {
            if (!progress) return true;
            return progress(fraction, "denoising");
          });
      if (!cleaned.has_value()) {
        result.code = "cancelled";
        result.message = "cancelled";
        return result;
      }
      result.png = encode_rgb_png(blend(*image, *cleaned, request.strength));
      result.ok = true;
    } catch (const Ort::Exception& error) {
      result.code = "engine_error";
      result.message = std::string("onnxruntime: ") + error.what();
    } catch (const std::exception& error) {
      result.code = "engine_error";
      result.message = error.what();
    }
    result.elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
            .count();
    return result;
  }

 private:
  // Strength arrives as the sampler band the ComfyUI graph wants (server.cpp maps 0..100
  // into 0.05..0.5). What it means here is how much of the model's answer to keep, and
  // keeping at most half of it would make the backend look weak at 100, so the band is
  // stretched back out over the whole range.
  static Rgb8Image blend(const Rgb8Image& original, const Rgb8Image& cleaned, double strength) {
    const double keep = std::clamp((strength - 0.05) / 0.45, 0.0, 1.0);
    if (keep >= 1.0) return cleaned;
    Rgb8Image out = original;
    const size_t count = std::min(out.pixels.size(), cleaned.pixels.size());
    for (size_t i = 0; i < count; ++i) {
      const double under = original.pixels[i];
      const double over = cleaned.pixels[i];
      out.pixels[i] = static_cast<uint8_t>(
          std::lround(std::clamp(under + ((over - under) * keep), 0.0, 255.0)));
    }
    return out;
  }
};

}  // namespace

std::unique_ptr<GenerativeBackend> make_onnx_denoise_backend() {
  return std::make_unique<OnnxDenoiseBackend>();
}

bool onnx_denoise_installed() {
  return model_installed(kDenoiseModel);
}

}  // namespace latent

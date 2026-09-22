// The denoise model the `denoise` op runs on when it runs locally (issue #51): SCUNet,
// a restoration network trained on (noisy, clean) pairs under the practical degradation
// model, exported to ONNX by `scripts/models/export_denoise.py`.
//
// Why there is a second denoise backend at all: the first one was SDXL img2img at denoise
// 0.3, and a generator asked to re-roll a noisy frame does not take noise out — it redraws
// the picture, slightly softer, with the noise redistributed. A restoration network has an
// identity to fall back on and is trained on exactly this problem.
//
// The graph is fixed at one tile — SCUNet's swin blocks window their attention, so a
// dynamic-size export traces reshapes that only hold at the traced size — so this tiles,
// which a 24 MP frame would need regardless. Tiles overlap and are feathered together: a
// hard tile edge in a denoised sky is the one artefact a user notices immediately.
#pragma once

#include "image/jpeg.h"

#include <cstdint>
#include <onnxruntime_cxx_api.h>

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace latent {

class ScuNet {
 public:
  explicit ScuNet(const std::string& directory);

  // The square the graph was exported at, from config.json.
  uint32_t tile() const { return tile_; }

  // `progress` is called once per tile with 0..1 and may return false to stop, in which
  // case this returns nothing. Anything smaller than one tile is edge-padded up to it.
  std::optional<Rgb8Image> denoise(const Rgb8Image& image,
                                   const std::function<bool(double)>& progress);

 private:
  std::vector<float> run_tile(const std::vector<float>& input);

  uint32_t tile_ = 512;
  std::string input_name_;
  std::string output_name_;
  Ort::Session session_;
};

// How much of one tile the next one repeats. Enough that the feather has somewhere to
// happen and that a pixel near a seam has real context on both sides.
inline constexpr uint32_t kDenoiseTileOverlap = 32;

}  // namespace latent

#include "ai/denoise.h"

#include "ai/model_store.h"
#include "ai/ort_session.h"

#include <cmath>

#include <algorithm>
#include <array>
#include <stdexcept>

namespace latent {

namespace {

// Where a tile samples when it hangs over the edge — only possible for an image smaller
// than one tile. Mirrored, not clamped: a clamped edge is a band of identical rows, which
// is not a thing any sensor produces, and SCUNet answers it with a smear that reaches tens
// of pixels back into the real picture.
uint32_t mirrored(int64_t position, uint32_t extent) {
  if (extent <= 1) return 0;
  const auto span = static_cast<int64_t>(extent) - 1;
  int64_t at = position;
  while (at < 0 || at > span) {
    if (at < 0) at = -at;
    if (at > span) at = (2 * span) - at;
  }
  return static_cast<uint32_t>(at);
}

// The weight a tile carries at `distance` pixels from its own edge: zero right at the edge,
// one once the feather is behind it. Two overlapping tiles then sum to roughly one and the
// seam is a gradient nobody can point at rather than a line.
float feather(uint32_t position, uint32_t extent, uint32_t margin) {
  if (margin == 0) return 1.0F;
  const float from_low = static_cast<float>(position) + 0.5F;
  const float from_high = static_cast<float>(extent - position) - 0.5F;
  const float edge = std::min(from_low, from_high);
  return std::clamp(edge / static_cast<float>(margin), 0.02F, 1.0F);
}

}  // namespace

ScuNet::ScuNet(const std::string& directory) : session_(nullptr) {
  const nlohmann::json config = read_json_file(directory + "/config.json");
  tile_ = config.value("tile", 512U);
  input_name_ = config.value("/input/name"_json_pointer, std::string("image"));
  output_name_ = config.value("/output/name"_json_pointer, std::string("denoised"));
  session_ = OrtRuntime::instance().open(directory + "/" +
                                         config.value("model_path", std::string("model.onnx")));
}

std::vector<float> ScuNet::run_tile(const std::vector<float>& input) {
  std::vector<float> pixels = input;
  const std::array<int64_t, 4> shape{1, 3, tile_, tile_};
  std::array<Ort::Value, 1> inputs{float_tensor(pixels, shape)};
  const std::array<const char*, 1> input_names{input_name_.c_str()};
  const std::array<const char*, 1> output_names{output_name_.c_str()};
  const std::vector<Ort::Value> outputs =
      session_.Run(Ort::RunOptions{nullptr}, input_names.data(), inputs.data(), inputs.size(),
                   output_names.data(), output_names.size());
  const std::vector<int64_t> dimensions = tensor_shape(outputs[0]);
  if (dimensions.size() != 4 || dimensions[1] != 3) {
    throw std::runtime_error("scunet: the graph did not return [1, 3, tile, tile]");
  }
  return copy_floats(outputs[0]);
}

std::optional<Rgb8Image> ScuNet::denoise(const Rgb8Image& image,
                                         const std::function<bool(double)>& progress) {
  if (image.width == 0 || image.height == 0) return std::nullopt;
  const uint32_t tile = tile_;
  const uint32_t overlap = std::min(kDenoiseTileOverlap, tile / 4);
  const uint32_t stride = tile - overlap;
  // Where each tile starts, the last one pulled back so it ends on the far edge rather than
  // hanging over it: a tile that ran on replicated padding denoises the padding too, and it
  // shows as a band down the right and bottom of the frame.
  const auto origins = [&](uint32_t extent) {
    std::vector<uint32_t> starts;
    if (extent <= tile) {
      starts.push_back(0);
      return starts;
    }
    for (uint32_t at = 0; at + tile < extent + stride; at += stride) {
      starts.push_back(std::min(at, extent - tile));
      if (starts.back() == extent - tile) break;
    }
    return starts;
  };
  const std::vector<uint32_t> columns = origins(image.width);
  const std::vector<uint32_t> rows = origins(image.height);

  const size_t count = static_cast<size_t>(image.width) * image.height;
  std::vector<float> accumulated(count * 3, 0.0F);
  std::vector<float> weights(count, 0.0F);
  std::vector<float> patch(static_cast<size_t>(tile) * tile * 3);

  const double total = static_cast<double>(columns.size() * rows.size());
  double done = 0;
  for (const uint32_t top : rows) {
    for (const uint32_t left : columns) {
      // The mirror only matters for an image smaller than one tile; every other tile is
      // fully inside the frame by construction.
      for (uint32_t y = 0; y < tile; ++y) {
        const uint32_t source_y = mirrored(static_cast<int64_t>(top) + y, image.height);
        for (uint32_t x = 0; x < tile; ++x) {
          const uint32_t source_x = mirrored(static_cast<int64_t>(left) + x, image.width);
          const size_t from = (((static_cast<size_t>(source_y) * image.width) + source_x) * 3);
          for (uint32_t channel = 0; channel < 3; ++channel) {
            patch[(static_cast<size_t>(channel) * tile * tile) + (static_cast<size_t>(y) * tile) +
                  x] = image.pixels[from + channel] / 255.0F;
          }
        }
      }

      const std::vector<float> cleaned = run_tile(patch);
      for (uint32_t y = 0; y < tile; ++y) {
        if (top + y >= image.height) break;
        for (uint32_t x = 0; x < tile; ++x) {
          if (left + x >= image.width) break;
          const float weight = feather(x, tile, overlap) * feather(y, tile, overlap);
          const size_t into = ((static_cast<size_t>(top + y) * image.width) + left + x);
          weights[into] += weight;
          for (uint32_t channel = 0; channel < 3; ++channel) {
            accumulated[(into * 3) + channel] +=
                weight * cleaned[(static_cast<size_t>(channel) * tile * tile) +
                                 (static_cast<size_t>(y) * tile) + x];
          }
        }
      }
      done += 1;
      if (progress && !progress(done / std::max(total, 1.0))) return std::nullopt;
    }
  }

  Rgb8Image out;
  out.width = image.width;
  out.height = image.height;
  out.pixels.resize(count * 3);
  for (size_t pixel = 0; pixel < count; ++pixel) {
    const float weight = std::max(weights[pixel], 1e-5F);
    for (size_t channel = 0; channel < 3; ++channel) {
      const float value = accumulated[(pixel * 3) + channel] / weight;
      out.pixels[(pixel * 3) + channel] =
          static_cast<uint8_t>(std::lround(std::clamp(value, 0.0F, 1.0F) * 255.0F));
    }
  }
  return out;
}

}  // namespace latent

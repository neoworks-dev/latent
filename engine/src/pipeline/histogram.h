// CPU histogram of the last rendered proxy. Cheap enough at proxy size (~1 ms for 1 MP)
// and it keeps the GPU path free of a readback the UI may never ask for.
#pragma once

#include <cstdint>

#include <array>
#include <span>

#include <nlohmann/json.hpp>

namespace latent {

struct Histogram {
  static constexpr size_t kBins = 256;
  std::array<uint32_t, kBins> red{};
  std::array<uint32_t, kBins> green{};
  std::array<uint32_t, kBins> blue{};
  double clipped_shadows_pct = 0;
  double clipped_highlights_pct = 0;
};

// `pixels` is rgba8, `row_pixels` wide and `rows` tall. Only the given rectangle is
// counted, so the letterbox bars never show up as a spike at the bar colour. The rect is
// signed and is clipped to the buffer: zoomed in, the image rect starts off the top left
// corner and runs past the bottom right one.
Histogram compute_histogram(std::span<const uint8_t> pixels, uint32_t row_pixels, uint32_t rows,
                            int32_t x, int32_t y, uint32_t width, uint32_t height);

nlohmann::json histogram_to_json(const Histogram& histogram);

}  // namespace latent

#include "pipeline/histogram.h"

#include <algorithm>

namespace latent {

namespace {

constexpr uint8_t kShadowClip = 1;
constexpr uint8_t kHighlightClip = 254;

}  // namespace

Histogram compute_histogram(std::span<const uint8_t> pixels, uint32_t row_pixels, uint32_t x,
                            uint32_t y, uint32_t width, uint32_t height) {
  Histogram histogram;
  uint64_t clipped_low = 0;
  uint64_t clipped_high = 0;
  for (uint32_t row = 0; row < height; ++row) {
    const size_t start = (static_cast<size_t>(y + row) * row_pixels + x) * 4;
    if (start + static_cast<size_t>(width) * 4 > pixels.size()) break;
    for (uint32_t column = 0; column < width; ++column) {
      const uint8_t* texel = pixels.data() + start + static_cast<size_t>(column) * 4;
      ++histogram.red[texel[0]];
      ++histogram.green[texel[1]];
      ++histogram.blue[texel[2]];
      const uint8_t high = std::max({texel[0], texel[1], texel[2]});
      if (high <= kShadowClip) ++clipped_low;
      if (high >= kHighlightClip) ++clipped_high;
    }
  }
  const double total = static_cast<double>(width) * height;
  if (total <= 0) return histogram;
  histogram.clipped_shadows_pct = 100.0 * static_cast<double>(clipped_low) / total;
  histogram.clipped_highlights_pct = 100.0 * static_cast<double>(clipped_high) / total;
  return histogram;
}

nlohmann::json histogram_to_json(const Histogram& histogram) {
  return {{"bins", static_cast<int>(Histogram::kBins)},
          {"r", histogram.red},
          {"g", histogram.green},
          {"b", histogram.blue},
          {"clippedShadowsPct", histogram.clipped_shadows_pct},
          {"clippedHighlightsPct", histogram.clipped_highlights_pct}};
}

}  // namespace latent

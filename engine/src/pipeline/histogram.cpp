#include "pipeline/histogram.h"

#include <algorithm>

namespace latent {

namespace {

constexpr uint8_t kShadowClip = 1;
constexpr uint8_t kHighlightClip = 254;

}  // namespace

Histogram compute_histogram(std::span<const uint8_t> pixels, uint32_t row_pixels, uint32_t rows,
                            int32_t x, int32_t y, uint32_t width, uint32_t height) {
  Histogram histogram;
  if (row_pixels == 0) return histogram;
  // A zoomed view's image rect starts off the top left corner and runs past the bottom
  // right one, so the rect is intersected with the frame rather than trusted.
  const uint32_t buffer_rows = std::min<uint32_t>(rows, pixels.size() / (row_pixels * 4));
  const int64_t left = std::max<int64_t>(x, 0);
  const int64_t top = std::max<int64_t>(y, 0);
  const int64_t right = std::min<int64_t>(static_cast<int64_t>(x) + width, row_pixels);
  const int64_t bottom = std::min<int64_t>(static_cast<int64_t>(y) + height, buffer_rows);
  if (right <= left || bottom <= top) return histogram;

  uint64_t clipped_low = 0;
  uint64_t clipped_high = 0;
  for (int64_t row = top; row < bottom; ++row) {
    const size_t start = (static_cast<size_t>(row) * row_pixels + static_cast<size_t>(left)) * 4;
    for (int64_t column = left; column < right; ++column) {
      const uint8_t* texel = pixels.data() + start + static_cast<size_t>(column - left) * 4;
      ++histogram.red[texel[0]];
      ++histogram.green[texel[1]];
      ++histogram.blue[texel[2]];
      const uint8_t high = std::max({texel[0], texel[1], texel[2]});
      if (high <= kShadowClip) ++clipped_low;
      if (high >= kHighlightClip) ++clipped_high;
    }
  }
  const double total = static_cast<double>(right - left) * static_cast<double>(bottom - top);
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

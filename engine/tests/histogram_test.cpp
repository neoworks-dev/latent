#include "pipeline/histogram.h"

#include <cstdint>

#include <vector>

#include <catch2/catch_test_macros.hpp>

using namespace latent;

namespace {

// An rgba8 frame with a grey image rect inside a black letterbox, the way the renderer
// hands one over.
std::vector<uint8_t> frame_with_rect(uint32_t width, uint32_t height, uint32_t x, uint32_t y,
                                     uint32_t rect_width, uint32_t rect_height, uint8_t level) {
  std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4, 0);
  for (uint32_t row = 0; row < rect_height; ++row) {
    for (uint32_t column = 0; column < rect_width; ++column) {
      uint8_t* texel = pixels.data() + ((static_cast<size_t>(y + row) * width + x + column) * 4);
      texel[0] = level;
      texel[1] = level;
      texel[2] = level;
      texel[3] = 255;
    }
  }
  return pixels;
}

}  // namespace

TEST_CASE("only the image rect is counted, not the letterbox") {
  const std::vector<uint8_t> pixels = frame_with_rect(16, 16, 4, 0, 8, 16, 128);
  const Histogram histogram = compute_histogram(pixels, 16, 16, 4, 0, 8, 16);

  REQUIRE(histogram.red[128] == 8 * 16);
  REQUIRE(histogram.red[0] == 0);
  REQUIRE(histogram.green[128] == 8 * 16);
  REQUIRE(histogram.blue[128] == 8 * 16);
  // The black bars would read as fully clipped shadows if they were counted.
  REQUIRE(histogram.clipped_shadows_pct == 0.0);
  REQUIRE(histogram.clipped_highlights_pct == 0.0);
}

TEST_CASE("a zoomed rect that starts off the frame is clipped to it") {
  // What a zoomed view reports: the image rect begins left of and above the frame and runs
  // past its bottom right corner, so only the middle of it is on screen.
  const std::vector<uint8_t> pixels = frame_with_rect(8, 8, 0, 0, 8, 8, 200);
  const Histogram histogram = compute_histogram(pixels, 8, 8, -4, -4, 16, 16);

  REQUIRE(histogram.red[200] == 8 * 8);
  uint64_t counted = 0;
  for (const uint32_t bin : histogram.red)
    counted += bin;
  REQUIRE(counted == 8 * 8);
}

TEST_CASE("clipping is the share of pixels at either end") {
  std::vector<uint8_t> pixels = frame_with_rect(4, 4, 0, 0, 4, 4, 128);
  // Four of sixteen pixels blown, two crushed.
  for (size_t index = 0; index < 4; ++index) {
    pixels[index * 4] = 255;
    pixels[(index * 4) + 1] = 255;
    pixels[(index * 4) + 2] = 255;
  }
  for (size_t index = 8; index < 10; ++index) {
    pixels[index * 4] = 0;
    pixels[(index * 4) + 1] = 0;
    pixels[(index * 4) + 2] = 1;
  }
  const Histogram histogram = compute_histogram(pixels, 4, 4, 0, 0, 4, 4);

  REQUIRE(histogram.clipped_highlights_pct == 25.0);
  REQUIRE(histogram.clipped_shadows_pct == 12.5);
}

TEST_CASE("an empty rect is an empty histogram, not a read past the buffer") {
  const std::vector<uint8_t> pixels = frame_with_rect(4, 4, 0, 0, 4, 4, 100);
  const Histogram offscreen = compute_histogram(pixels, 4, 4, 8, 8, 4, 4);
  uint64_t counted = 0;
  for (const uint32_t bin : offscreen.red)
    counted += bin;
  REQUIRE(counted == 0);
  REQUIRE(offscreen.clipped_highlights_pct == 0.0);
}

TEST_CASE("the wire form carries the bin count and both clipping percentages") {
  const std::vector<uint8_t> pixels = frame_with_rect(4, 4, 0, 0, 4, 4, 255);
  const nlohmann::json json = histogram_to_json(compute_histogram(pixels, 4, 4, 0, 0, 4, 4));

  REQUIRE(json["bins"] == 256);
  REQUIRE(json["r"].size() == 256);
  REQUIRE(json["r"][255] == 16);
  REQUIRE(json["clippedHighlightsPct"] == 100.0);
  REQUIRE(json["clippedShadowsPct"] == 0.0);
}

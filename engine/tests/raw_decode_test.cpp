// The decoder's one decision: whether `min_long_edge` lets it skip the demosaic. Needs the
// sample raw and no GPU, and skips itself without it so a fresh clone still gets a green
// ctest. It lives in the render-test binary only because decode_raw is in latent_core.
#include "raw/raw_decode.h"

#include <cstdlib>

#include <algorithm>
#include <filesystem>
#include <string>

#include <catch2/catch_test_macros.hpp>

using namespace latent;

namespace {

std::string sample_raw_path() {
  const char* home = std::getenv("HOME");
  if (home == nullptr) return {};
  const std::string path = std::string(home) + "/Downloads/DSC00120.ARW";
  return std::filesystem::exists(path) ? path : std::string();
}

}  // namespace

TEST_CASE("a proxy decode halves the photo and a full decode does not", "[raw]") {
  const std::string path = sample_raw_path();
  if (path.empty()) SKIP("no sample raw at ~/Downloads/DSC00120.ARW");

  const DecodedRaw full = decode_raw(path);
  const uint32_t long_edge = std::max(full.width, full.height);

  // Asking for half of what the photo can give: halving clears the bar, so it halves.
  const DecodedRaw proxy = decode_raw(path, long_edge / 2);
  REQUIRE(proxy.width == full.width / 2);
  REQUIRE(proxy.height == full.height / 2);
  REQUIRE(proxy.camera == full.camera);
  REQUIRE(proxy.rgba.size() == static_cast<size_t>(proxy.width) * proxy.height * 4);

  // Asking for more than halving can give: full resolution, not an upscale of a half decode.
  const DecodedRaw undershoot = decode_raw(path, long_edge / 2 + 1);
  REQUIRE(undershoot.width == full.width);
  REQUIRE(undershoot.height == full.height);

  // Zero is the default and means full resolution however large the photo is.
  REQUIRE(decode_raw(path, 0).width == full.width);
}

TEST_CASE("a proxy decode keeps the white balance and the linear scale", "[raw]") {
  const std::string path = sample_raw_path();
  if (path.empty()) SKIP("no sample raw at ~/Downloads/DSC00120.ARW");

  const DecodedRaw full = decode_raw(path);
  const DecodedRaw proxy = decode_raw(path, std::max(full.width, full.height) / 2);

  // Binning a Bayer quad and interpolating it disagree pixel by pixel, but not about the
  // exposure of the whole frame: a proxy that lost the camera matrix or the white balance
  // would land somewhere else entirely. Every fourth row, both channels, one mean each.
  const auto channel_mean = [](const DecodedRaw& raw, size_t channel) {
    double total = 0;
    size_t counted = 0;
    for (uint32_t y = 0; y < raw.height; y += 4) {
      for (uint32_t x = 0; x < raw.width; ++x) {
        total += raw.rgba[(static_cast<size_t>(y) * raw.width + x) * 4 + channel];
        ++counted;
      }
    }
    return total / static_cast<double>(counted);
  };

  for (size_t channel = 0; channel < 3; ++channel) {
    const double reference = channel_mean(full, channel);
    const double measured = channel_mean(proxy, channel);
    REQUIRE(measured > reference * 0.97);
    REQUIRE(measured < reference * 1.03);
  }
  REQUIRE(proxy.rgba[3] == 65535);
}

#include "catalog/preview.h"

#include <chrono>
#include <cstdlib>
#include <unistd.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <thread>

#include <catch2/catch_test_macros.hpp>

using namespace latent;

namespace {

// The cache root comes from XDG_CACHE_HOME, so a test can have one of its own and the
// developer's real previews are never touched.
class TemporaryCache {
 public:
  TemporaryCache()
      : path_((std::filesystem::temp_directory_path() /
               ("latent-preview-" + std::to_string(::getpid()) + "-" + std::to_string(++counter_)))
                  .string()) {
    const char* previous = std::getenv("XDG_CACHE_HOME");
    if (previous != nullptr) previous_ = previous;
    ::setenv("XDG_CACHE_HOME", path_.c_str(), 1);
  }
  ~TemporaryCache() {
    if (previous_.empty())
      ::unsetenv("XDG_CACHE_HOME");
    else
      ::setenv("XDG_CACHE_HOME", previous_.c_str(), 1);
    std::error_code error;
    std::filesystem::remove_all(path_, error);
  }
  TemporaryCache(const TemporaryCache&) = delete;
  TemporaryCache& operator=(const TemporaryCache&) = delete;

 private:
  static inline int counter_ = 0;
  std::string path_;
  std::string previous_;
};

// A gradient, so a downscale that dropped or swapped channels is visible in the values
// rather than only in the size.
DecodedRaw gradient(uint32_t width, uint32_t height) {
  DecodedRaw raw;
  raw.width = width;
  raw.height = height;
  raw.camera = "Test Cam";
  raw.rgba.resize(static_cast<size_t>(width) * height * 4);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const size_t texel = (static_cast<size_t>(y) * width + x) * 4;
      raw.rgba[texel] = static_cast<uint16_t>(x * 65535 / (width - 1));
      raw.rgba[texel + 1] = static_cast<uint16_t>(y * 65535 / (height - 1));
      raw.rgba[texel + 2] = 4096;
      raw.rgba[texel + 3] = 65535;
    }
  }
  return raw;
}

}  // namespace

TEST_CASE("a preview is the photo scaled to the proxy long edge", "[preview]") {
  const TemporaryCache cache;
  const std::string path = preview_cache_path("abc123");

  const DecodedRaw written = write_preview(gradient(4000, 3000), path);

  REQUIRE(written.width == kPreviewLongEdge);
  REQUIRE(written.height == kPreviewLongEdge * 3 / 4);
  REQUIRE(written.rgba.size() == static_cast<size_t>(written.width) * written.height * 4);
  REQUIRE(std::filesystem::exists(path));
  // No half-written file left beside it, whatever happened during the write.
  REQUIRE_FALSE(std::filesystem::exists(path + ".tmp"));
}

TEST_CASE("a photo smaller than the proxy is its own preview", "[preview]") {
  const TemporaryCache cache;
  const DecodedRaw written = write_preview(gradient(800, 600), preview_cache_path("small"));

  REQUIRE(written.width == 800);
  REQUIRE(written.height == 600);
}

TEST_CASE("a cached preview reads back as the decoder's own type", "[preview]") {
  const TemporaryCache cache;
  const std::string path = preview_cache_path("roundtrip");
  const DecodedRaw written = write_preview(gradient(2600, 1300), path);

  const std::optional<DecodedRaw> read = read_cached_preview(path);

  REQUIRE(read.has_value());
  REQUIRE(read->width == written.width);
  REQUIRE(read->height == written.height);
  REQUIRE(read->camera == "Test Cam");
  REQUIRE(read->rgba == written.rgba);
  // Alpha is the constant the upload path wants, not something the TIFF carries.
  REQUIRE(read->rgba[3] == 65535);
}

TEST_CASE("a missing or unreadable entry is a miss, not a throw", "[preview]") {
  const TemporaryCache cache;
  REQUIRE_FALSE(read_cached_preview(preview_cache_path("never-written")).has_value());

  const std::string path = preview_cache_path("garbage");
  std::filesystem::create_directories(std::filesystem::path(path).parent_path());
  std::ofstream(path) << "not a tiff";
  REQUIRE_FALSE(read_cached_preview(path).has_value());
}

TEST_CASE("removing a row's previews leaves every other key alone", "[preview]") {
  const TemporaryCache cache;
  const std::string kept = preview_cache_path("keep");
  write_preview(gradient(400, 300), preview_cache_path("drop"));
  write_preview(gradient(400, 300), kept);

  forget_previews("drop");

  REQUIRE_FALSE(std::filesystem::exists(preview_cache_path("drop")));
  REQUIRE(std::filesystem::exists(kept));
}

TEST_CASE("pruning evicts the least recently used until the cache fits", "[preview]") {
  const TemporaryCache cache;
  const std::string oldest = preview_cache_path("oldest");
  const std::string newest = preview_cache_path("newest");
  write_preview(gradient(400, 300), oldest);
  // The clock these mtimes come from has coarse resolution on some filesystems; a real
  // gap beats a same-instant tie the sort would break arbitrarily.
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  write_preview(gradient(400, 300), newest);

  const auto one_entry = static_cast<uint64_t>(std::filesystem::file_size(newest));
  const uint64_t left = prune_preview_cache(one_entry);

  REQUIRE(left <= one_entry);
  REQUIRE_FALSE(std::filesystem::exists(oldest));
  REQUIRE(std::filesystem::exists(newest));
}

TEST_CASE("a cache under its budget is left alone", "[preview]") {
  const TemporaryCache cache;
  const std::string path = preview_cache_path("under");
  write_preview(gradient(400, 300), path);

  REQUIRE(prune_preview_cache(preview_cache_budget()) > 0);
  REQUIRE(std::filesystem::exists(path));
}

TEST_CASE("the budget follows LATENT_PREVIEW_CACHE_GB and ignores nonsense", "[preview]") {
  ::setenv("LATENT_PREVIEW_CACHE_GB", "2", 1);
  REQUIRE(preview_cache_budget() == 2ULL * 1024 * 1024 * 1024);
  ::setenv("LATENT_PREVIEW_CACHE_GB", "0", 1);
  REQUIRE(preview_cache_budget() == 0);
  ::setenv("LATENT_PREVIEW_CACHE_GB", "lots", 1);
  REQUIRE(preview_cache_budget() == 8ULL * 1024 * 1024 * 1024);
  ::unsetenv("LATENT_PREVIEW_CACHE_GB");
}

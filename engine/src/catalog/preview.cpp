#include "catalog/preview.h"

#include <charconv>
#include <cstdlib>
#include <tiffio.h>

#include <algorithm>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <vector>

namespace latent {

namespace {

// 8 GiB holds a few hundred 24 MP previews. The ceiling matters more than the number:
// without one the cache grows with the catalog and nobody notices until the disk is full.
constexpr uint64_t kDefaultBudgetGiB = 8;
constexpr uint64_t kBytesPerGiB = 1024ULL * 1024ULL * 1024ULL;

struct TiffCloser {
  void operator()(TIFF* handle) const { TIFFClose(handle); }
};
using TiffHandle = std::unique_ptr<TIFF, TiffCloser>;

std::filesystem::path cache_root() {
  const char* cache_home = std::getenv("XDG_CACHE_HOME");
  if (cache_home != nullptr && cache_home[0] != '\0') {
    return std::filesystem::path(cache_home) / "latent" / "previews";
  }
  const char* home = std::getenv("HOME");
  const std::filesystem::path base = home == nullptr ? std::filesystem::current_path() : home;
  return base / ".cache" / "latent" / "previews";
}

// Nearest-neighbour is visibly wrong on a downscale this large; a box filter over the
// source rectangle each destination pixel covers is what the thumbnail path uses too.
DecodedRaw box_downscale(const DecodedRaw& source, uint32_t width, uint32_t height) {
  DecodedRaw out;
  out.width = width;
  out.height = height;
  out.camera = source.camera;
  out.rgba.assign(static_cast<size_t>(width) * height * 4, 0);

  for (uint32_t y = 0; y < height; ++y) {
    const uint32_t y0 = y * source.height / height;
    const uint32_t y1 = std::max(y0 + 1, (y + 1) * source.height / height);
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t x0 = x * source.width / width;
      const uint32_t x1 = std::max(x0 + 1, (x + 1) * source.width / width);
      uint64_t sums[3] = {0, 0, 0};
      uint64_t count = 0;
      for (uint32_t sy = y0; sy < y1; ++sy) {
        const size_t row = static_cast<size_t>(sy) * source.width;
        for (uint32_t sx = x0; sx < x1; ++sx) {
          const size_t texel = (row + sx) * 4;
          sums[0] += source.rgba[texel];
          sums[1] += source.rgba[texel + 1];
          sums[2] += source.rgba[texel + 2];
          ++count;
        }
      }
      const size_t out_texel = (static_cast<size_t>(y) * width + x) * 4;
      for (size_t channel = 0; channel < 3; ++channel) {
        out.rgba[out_texel + channel] = static_cast<uint16_t>(sums[channel] / count);
      }
      out.rgba[out_texel + 3] = 65535;
    }
  }
  return out;
}

// The proxy size for a photo: the long edge capped, the short edge following, never scaled
// up — a photo already smaller than the cap is its own preview.
std::pair<uint32_t, uint32_t> preview_size(uint32_t width, uint32_t height) {
  const uint32_t longest = std::max(width, height);
  if (longest <= kPreviewLongEdge || longest == 0) return {width, height};
  const double scale = static_cast<double>(kPreviewLongEdge) / longest;
  const auto scaled = [scale](uint32_t edge) {
    return std::max(1U, static_cast<uint32_t>(static_cast<double>(edge) * scale));
  };
  return {scaled(width), scaled(height)};
}

void write_tiff(const DecodedRaw& preview, const std::string& path) {
  TiffHandle tiff(TIFFOpen(path.c_str(), "w"));
  if (!tiff) throw std::runtime_error("cannot write " + path);
  TIFFSetField(tiff.get(), TIFFTAG_IMAGEWIDTH, preview.width);
  TIFFSetField(tiff.get(), TIFFTAG_IMAGELENGTH, preview.height);
  TIFFSetField(tiff.get(), TIFFTAG_SAMPLESPERPIXEL, 3);
  TIFFSetField(tiff.get(), TIFFTAG_BITSPERSAMPLE, 16);
  TIFFSetField(tiff.get(), TIFFTAG_SAMPLEFORMAT, SAMPLEFORMAT_UINT);
  TIFFSetField(tiff.get(), TIFFTAG_ORIENTATION, ORIENTATION_TOPLEFT);
  TIFFSetField(tiff.get(), TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG);
  TIFFSetField(tiff.get(), TIFFTAG_PHOTOMETRIC, PHOTOMETRIC_RGB);
  TIFFSetField(tiff.get(), TIFFTAG_COMPRESSION, COMPRESSION_ADOBE_DEFLATE);
  TIFFSetField(tiff.get(), TIFFTAG_ROWSPERSTRIP, TIFFDefaultStripSize(tiff.get(), 0));
  if (!preview.camera.empty()) TIFFSetField(tiff.get(), TIFFTAG_MAKE, preview.camera.c_str());
  TIFFSetField(tiff.get(), TIFFTAG_SOFTWARE, "Latent preview");

  // RGB on disk, RGBA in memory: the alpha the upload path wants is a constant, and a
  // quarter of every preview is a lot of disk to spend on storing 65535 over and over.
  std::vector<uint16_t> row(static_cast<size_t>(preview.width) * 3);
  for (uint32_t y = 0; y < preview.height; ++y) {
    const size_t source = static_cast<size_t>(y) * preview.width * 4;
    for (uint32_t x = 0; x < preview.width; ++x) {
      for (size_t channel = 0; channel < 3; ++channel) {
        row[static_cast<size_t>(x) * 3 + channel] = preview.rgba[source + x * 4 + channel];
      }
    }
    if (TIFFWriteScanline(tiff.get(), row.data(), y, 0) < 0) {
      throw std::runtime_error("TIFFWriteScanline failed on " + path);
    }
  }
}

}  // namespace

std::string preview_cache_path(const std::string& key) {
  return (cache_root() / (key + "-" + std::to_string(kPreviewLongEdge) + ".tif")).string();
}

std::optional<DecodedRaw> read_cached_preview(const std::string& cache_path) {
  // Checked before TIFFOpen only to keep libtiff from logging the miss: a photo that has
  // no preview yet is the ordinary case, not something to print about.
  std::error_code error;
  if (!std::filesystem::is_regular_file(cache_path, error)) return std::nullopt;
  TiffHandle tiff(TIFFOpen(cache_path.c_str(), "r"));
  if (!tiff) return std::nullopt;

  uint32_t width = 0;
  uint32_t height = 0;
  uint16_t samples = 0;
  uint16_t bits = 0;
  TIFFGetField(tiff.get(), TIFFTAG_IMAGEWIDTH, &width);
  TIFFGetField(tiff.get(), TIFFTAG_IMAGELENGTH, &height);
  TIFFGetField(tiff.get(), TIFFTAG_SAMPLESPERPIXEL, &samples);
  TIFFGetField(tiff.get(), TIFFTAG_BITSPERSAMPLE, &bits);
  if (width == 0 || height == 0 || samples != 3 || bits != 16) return std::nullopt;

  DecodedRaw preview;
  preview.width = width;
  preview.height = height;
  preview.rgba.assign(static_cast<size_t>(width) * height * 4, 0);
  const char* camera = nullptr;
  if (TIFFGetField(tiff.get(), TIFFTAG_MAKE, &camera) == 1 && camera != nullptr) {
    preview.camera = camera;
  }

  std::vector<uint16_t> row(static_cast<size_t>(width) * 3);
  for (uint32_t y = 0; y < height; ++y) {
    if (TIFFReadScanline(tiff.get(), row.data(), y, 0) < 0) return std::nullopt;
    const size_t destination = static_cast<size_t>(y) * width * 4;
    for (uint32_t x = 0; x < width; ++x) {
      for (size_t channel = 0; channel < 3; ++channel) {
        preview.rgba[destination + x * 4 + channel] = row[static_cast<size_t>(x) * 3 + channel];
      }
      preview.rgba[destination + x * 4 + 3] = 65535;
    }
  }

  // The read is the "use" in least-recently-used; prune_preview_cache goes by mtime.
  std::filesystem::last_write_time(cache_path, std::filesystem::file_time_type::clock::now(),
                                   error);
  return preview;
}

DecodedRaw write_preview(const DecodedRaw& decoded, const std::string& cache_path) {
  const auto [width, height] = preview_size(decoded.width, decoded.height);
  DecodedRaw preview = width == decoded.width && height == decoded.height
                           ? decoded
                           : box_downscale(decoded, width, height);

  std::error_code error;
  std::filesystem::create_directories(std::filesystem::path(cache_path).parent_path(), error);
  // Written beside and renamed over: a daemon killed mid-write leaves no half preview for
  // the next open to read as a cache hit.
  const std::string temporary = cache_path + ".tmp";
  try {
    write_tiff(preview, temporary);
  } catch (const std::exception&) {
    std::filesystem::remove(temporary, error);
    throw;
  }
  std::filesystem::rename(temporary, cache_path, error);
  return preview;
}

void forget_previews(const std::string& key) {
  std::error_code error;
  if (!std::filesystem::is_directory(cache_root(), error)) return;
  for (const auto& entry : std::filesystem::directory_iterator(cache_root(), error)) {
    const std::string name = entry.path().filename().string();
    if (!name.starts_with(key + "-")) continue;
    std::filesystem::remove(entry.path(), error);
  }
}

uint64_t preview_cache_budget() {
  const char* configured = std::getenv("LATENT_PREVIEW_CACHE_GB");
  if (configured == nullptr || configured[0] == '\0') return kDefaultBudgetGiB * kBytesPerGiB;
  uint64_t gibibytes = 0;
  const char* end = configured + std::char_traits<char>::length(configured);
  const auto parsed = std::from_chars(configured, end, gibibytes);
  if (parsed.ec != std::errc() || parsed.ptr != end) return kDefaultBudgetGiB * kBytesPerGiB;
  return gibibytes * kBytesPerGiB;
}

uint64_t prune_preview_cache(uint64_t budget_bytes) {
  struct Entry {
    std::filesystem::path path;
    std::filesystem::file_time_type used;
    uint64_t bytes = 0;
  };

  std::error_code error;
  if (!std::filesystem::is_directory(cache_root(), error)) return 0;
  std::vector<Entry> entries;
  uint64_t total = 0;
  for (const auto& entry : std::filesystem::directory_iterator(cache_root(), error)) {
    if (!entry.is_regular_file(error)) continue;
    const auto bytes = static_cast<uint64_t>(entry.file_size(error));
    if (error) continue;
    entries.push_back({entry.path(), entry.last_write_time(error), bytes});
    total += bytes;
  }
  if (total <= budget_bytes) return total;

  std::sort(entries.begin(), entries.end(),
            [](const Entry& left, const Entry& right) { return left.used < right.used; });
  for (const Entry& entry : entries) {
    if (total <= budget_bytes) break;
    if (!std::filesystem::remove(entry.path, error)) continue;
    total -= entry.bytes;
  }
  return total;
}

}  // namespace latent

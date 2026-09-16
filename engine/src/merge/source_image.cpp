#include "merge/source_image.h"

#include <cmath>
#include <tiffio.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>

#include <nlohmann/json.hpp>

namespace latent {

namespace {

constexpr int kSidecarVersion = 1;

struct TiffCloser {
  void operator()(TIFF* handle) const { TIFFClose(handle); }
};
using TiffHandle = std::unique_ptr<TIFF, TiffCloser>;

std::string lower_extension(const std::string& path) {
  std::string extension = std::filesystem::path(path).extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char character) { return std::tolower(character); });
  return extension;
}

nlohmann::json metadata_to_json(const SourceMetadata& metadata) {
  return {{"version", kSidecarVersion},
          {"linear", metadata.linear},
          {"colorSpace", metadata.color_space},
          {"camera", metadata.camera},
          {"whiteBalance", metadata.white_balance},
          {"scale", metadata.scale},
          {"merge", metadata.merge},
          {"sources", metadata.sources},
          {"capturedAt", metadata.captured_at},
          {"shutter", metadata.shutter},
          {"aperture", metadata.aperture},
          {"iso", metadata.iso},
          {"focalLength", metadata.focal_length}};
}

}  // namespace

std::string source_sidecar_path(const std::string& path) {
  return path + ".latent-source.json";
}

void write_source_tiff(const std::string& path, const LinearImage& image,
                       const SourceMetadata& metadata) {
  if (image.width == 0 || image.height == 0) throw std::runtime_error("merged image is empty");

  TiffHandle tiff(TIFFOpen(path.c_str(), "w"));
  if (!tiff) throw std::runtime_error("cannot write " + path);
  TIFFSetField(tiff.get(), TIFFTAG_IMAGEWIDTH, image.width);
  TIFFSetField(tiff.get(), TIFFTAG_IMAGELENGTH, image.height);
  TIFFSetField(tiff.get(), TIFFTAG_SAMPLESPERPIXEL, 3);
  TIFFSetField(tiff.get(), TIFFTAG_BITSPERSAMPLE, 16);
  TIFFSetField(tiff.get(), TIFFTAG_SAMPLEFORMAT, SAMPLEFORMAT_UINT);
  TIFFSetField(tiff.get(), TIFFTAG_ORIENTATION, ORIENTATION_TOPLEFT);
  TIFFSetField(tiff.get(), TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG);
  TIFFSetField(tiff.get(), TIFFTAG_PHOTOMETRIC, PHOTOMETRIC_RGB);
  // ADOBE_DEFLATE, not DEFLATE: same bytes, the identifier every reader knows.
  TIFFSetField(tiff.get(), TIFFTAG_COMPRESSION, COMPRESSION_ADOBE_DEFLATE);
  TIFFSetField(tiff.get(), TIFFTAG_ROWSPERSTRIP, TIFFDefaultStripSize(tiff.get(), 0));
  if (!metadata.camera.empty()) TIFFSetField(tiff.get(), TIFFTAG_MAKE, metadata.camera.c_str());
  TIFFSetField(tiff.get(), TIFFTAG_SOFTWARE, "Latent");

  std::vector<uint16_t> row(static_cast<size_t>(image.width) * 3);
  for (uint32_t y = 0; y < image.height; ++y) {
    const float* source = image.at(0, y);
    for (size_t i = 0; i < row.size(); ++i) {
      const float value = std::clamp(source[i], 0.0F, 1.0F);
      row[i] = static_cast<uint16_t>(std::lround(value * 65535.0F));
    }
    if (TIFFWriteScanline(tiff.get(), row.data(), y, 0) < 0) {
      throw std::runtime_error("TIFFWriteScanline failed on " + path);
    }
  }
  tiff.reset();

  std::ofstream sidecar(source_sidecar_path(path), std::ios::binary | std::ios::trunc);
  if (!sidecar) throw std::runtime_error("cannot write " + source_sidecar_path(path));
  sidecar << metadata_to_json(metadata).dump(2) << '\n';
}

bool is_source_tiff(const std::string& path) {
  const std::string extension = lower_extension(path);
  if (extension != ".tif" && extension != ".tiff") return false;
  return std::filesystem::exists(source_sidecar_path(path));
}

SourceMetadata read_source_metadata(const std::string& path) {
  std::ifstream file(source_sidecar_path(path), std::ios::binary);
  if (!file) throw std::runtime_error("no source sidecar next to " + path);
  const nlohmann::json json = nlohmann::json::parse(file, nullptr, false);
  if (json.is_discarded() || !json.is_object()) {
    throw std::runtime_error("source sidecar of " + path + " is not an object");
  }
  SourceMetadata metadata;
  metadata.linear = json.value("linear", true);
  metadata.color_space = json.value("colorSpace", std::string("srgb"));
  metadata.camera = json.value("camera", std::string());
  if (json.contains("whiteBalance") && json["whiteBalance"].is_array() &&
      json["whiteBalance"].size() == 3) {
    metadata.white_balance = json["whiteBalance"].get<std::array<double, 3>>();
  }
  metadata.scale = json.value("scale", 1.0);
  metadata.merge = json.value("merge", std::string());
  if (json.contains("sources") && json["sources"].is_array()) {
    metadata.sources = json["sources"].get<std::vector<std::string>>();
  }
  metadata.captured_at = json.value("capturedAt", std::string());
  metadata.shutter = json.value("shutter", std::string());
  metadata.aperture = json.value("aperture", 0.0);
  metadata.iso = json.value("iso", 0);
  metadata.focal_length = json.value("focalLength", 0.0);
  return metadata;
}

RawMetadata read_source_row(const std::string& path) {
  const SourceMetadata metadata = read_source_metadata(path);
  RawMetadata row;
  row.camera = metadata.camera;
  row.captured_at = metadata.captured_at;
  row.shutter = metadata.shutter;
  row.aperture = metadata.aperture;
  row.iso = metadata.iso;
  row.focal_length = metadata.focal_length;

  TiffHandle tiff(TIFFOpen(path.c_str(), "r"));
  if (!tiff) throw std::runtime_error("cannot read " + path);
  TIFFGetField(tiff.get(), TIFFTAG_IMAGEWIDTH, &row.width);
  TIFFGetField(tiff.get(), TIFFTAG_IMAGELENGTH, &row.height);
  return row;
}

DecodedRaw read_source_tiff(const std::string& path) {
  TiffHandle tiff(TIFFOpen(path.c_str(), "r"));
  if (!tiff) throw std::runtime_error("cannot read " + path);
  uint32_t width = 0;
  uint32_t height = 0;
  uint16_t samples = 0;
  uint16_t bits = 0;
  TIFFGetField(tiff.get(), TIFFTAG_IMAGEWIDTH, &width);
  TIFFGetField(tiff.get(), TIFFTAG_IMAGELENGTH, &height);
  TIFFGetFieldDefaulted(tiff.get(), TIFFTAG_SAMPLESPERPIXEL, &samples);
  TIFFGetFieldDefaulted(tiff.get(), TIFFTAG_BITSPERSAMPLE, &bits);
  if (width == 0 || height == 0 || samples < 3 || bits != 16) {
    throw std::runtime_error("not a 16-bit RGB source TIFF: " + path);
  }

  DecodedRaw out;
  out.width = width;
  out.height = height;
  out.camera = read_source_metadata(path).camera;
  out.rgba.assign(static_cast<size_t>(width) * height * 4, 65535);
  std::vector<uint16_t> row(static_cast<size_t>(width) * samples);
  for (uint32_t y = 0; y < height; ++y) {
    if (TIFFReadScanline(tiff.get(), row.data(), y, 0) < 0) {
      throw std::runtime_error("TIFFReadScanline failed on " + path);
    }
    uint16_t* target = out.rgba.data() + static_cast<size_t>(y) * width * 4;
    for (uint32_t x = 0; x < width; ++x) {
      target[x * 4 + 0] = row[x * samples + 0];
      target[x * 4 + 1] = row[x * samples + 1];
      target[x * 4 + 2] = row[x * samples + 2];
    }
  }
  return out;
}

}  // namespace latent

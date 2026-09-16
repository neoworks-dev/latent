#include "raw/raw_metadata.h"

#include <cmath>
#include <cstdio>
#include <ctime>

#include <algorithm>
#include <array>
#include <filesystem>
#include <memory>
#include <stdexcept>

#include <libraw/libraw.h>

namespace latent {

namespace {

constexpr std::array<std::string_view, 9> kRawExtensions = {"raf", "nef", "arw", "cr2", "cr3",
                                                            "dng", "orf", "rw2", "pef"};

struct ProcessedImageDeleter {
  void operator()(libraw_processed_image_t* image) const { LibRaw::dcraw_clear_mem(image); }
};
using ProcessedImage = std::unique_ptr<libraw_processed_image_t, ProcessedImageDeleter>;

std::string trimmed(const char* text) {
  std::string value = text == nullptr ? std::string() : std::string(text);
  while (!value.empty() && (value.back() == ' ' || value.back() == '\0')) {
    value.pop_back();
  }
  return value;
}

std::string format_timestamp(time_t when) {
  if (when <= 0) return {};
  std::tm parts{};
  if (localtime_r(&when, &parts) == nullptr) return {};
  std::array<char, 32> buffer{};
  const size_t written = std::strftime(buffer.data(), buffer.size(), "%Y-%m-%dT%H:%M:%S", &parts);
  return std::string(buffer.data(), written);
}

std::string format_shutter(double seconds) {
  if (seconds <= 0) return {};
  std::array<char, 32> buffer{};
  if (seconds >= 1.0) {
    std::snprintf(buffer.data(), buffer.size(), "%.1f", seconds);
    return std::string(buffer.data());
  }
  std::snprintf(buffer.data(), buffer.size(), "1/%d", static_cast<int>(std::lround(1.0 / seconds)));
  return std::string(buffer.data());
}

// LibRaw reports the sensor orientation separately; 5 and 6 are the 90 degree rotations,
// so the catalog's width/height must swap to match what the viewer shows.
void apply_flip(int flip, uint32_t& width, uint32_t& height) {
  if (flip != 5 && flip != 6) return;
  std::swap(width, height);
}

void open_or_throw(LibRaw& raw, const std::string& path) {
  const int status = raw.open_file(path.c_str());
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("open_file: ") + libraw_strerror(status));
  }
}

Rgb8Image thumb_to_rgb(const libraw_processed_image_t& image) {
  if (image.type == LIBRAW_IMAGE_JPEG) {
    return decode_jpeg(std::span<const uint8_t>(image.data, image.data_size));
  }
  if (image.type != LIBRAW_IMAGE_BITMAP || image.colors != 3 || image.bits != 8) {
    throw std::runtime_error("unsupported embedded thumbnail layout");
  }
  Rgb8Image out;
  out.width = image.width;
  out.height = image.height;
  out.pixels.assign(image.data, image.data + image.data_size);
  return out;
}

Rgb8Image half_size_preview(const std::string& path) {
  LibRaw raw;
  auto& params = raw.imgdata.params;
  params.half_size = 1;
  params.output_bps = 8;
  params.use_camera_wb = 1;
  params.user_qual = 0;  // bilinear: this is a thumbnail, not a render

  open_or_throw(raw, path);
  int status = raw.unpack();
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("unpack: ") + libraw_strerror(status));
  }
  status = raw.dcraw_process();
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("dcraw_process: ") + libraw_strerror(status));
  }
  const ProcessedImage image(raw.dcraw_make_mem_image(&status));
  if (!image) {
    throw std::runtime_error(std::string("dcraw_make_mem_image: ") + libraw_strerror(status));
  }
  return thumb_to_rgb(*image);
}

}  // namespace

bool is_raw_extension(const std::string& path) {
  std::string extension = std::filesystem::path(path).extension().string();
  if (extension.size() < 2) return false;
  extension.erase(0, 1);
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char character) { return std::tolower(character); });
  return std::find(kRawExtensions.begin(), kRawExtensions.end(), extension) != kRawExtensions.end();
}

RawMetadata read_raw_metadata(const std::string& path) {
  LibRaw raw;
  open_or_throw(raw, path);

  RawMetadata out;
  out.width = raw.imgdata.sizes.width;
  out.height = raw.imgdata.sizes.height;
  apply_flip(raw.imgdata.sizes.flip, out.width, out.height);
  out.camera = trimmed(raw.imgdata.idata.make) + " " + trimmed(raw.imgdata.idata.model);
  out.lens = trimmed(raw.imgdata.lens.Lens);
  if (out.lens.empty()) out.lens = trimmed(raw.imgdata.lens.makernotes.Lens);
  out.captured_at = format_timestamp(raw.imgdata.other.timestamp);
  out.iso = static_cast<int>(std::lround(raw.imgdata.other.iso_speed));
  out.shutter = format_shutter(raw.imgdata.other.shutter);
  out.aperture = raw.imgdata.other.aperture;
  out.focal_length = raw.imgdata.other.focal_len;
  return out;
}

Rgb8Image load_raw_preview(const std::string& path, uint32_t max_edge) {
  LibRaw raw;
  open_or_throw(raw, path);
  // The embedded preview is stored in sensor orientation; only dcraw_process applies the
  // camera flip, and the thumbnail path never runs it. Rotate after the box filter — it
  // fits the long edge either way and the smaller buffer is the cheaper one to permute.
  const int flip = raw.imgdata.sizes.flip;
  int status = raw.unpack_thumb();
  if (status == LIBRAW_SUCCESS) {
    const ProcessedImage thumb(raw.dcraw_make_mem_thumb(&status));
    // A thumbnail smaller than what was asked for is still better than a full decode.
    if (thumb) return rotate_for_flip(box_resize_to_fit(thumb_to_rgb(*thumb), max_edge), flip);
  }
  // half_size_preview goes through dcraw_process, which already flipped it.
  return box_resize_to_fit(half_size_preview(path), max_edge);
}

}  // namespace latent

#include "merge/frame_info.h"

#include <cmath>
#include <cstdio>
#include <ctime>

#include <array>
#include <stdexcept>

#include <libraw/libraw.h>

namespace latent {

namespace {

// 35 mm film is 36 mm wide; the equivalent focal length is defined against that.
constexpr double kFullFrameWidthMm = 36.0;

std::string trimmed(const char* text) {
  std::string value = text == nullptr ? std::string() : std::string(text);
  while (!value.empty() && (value.back() == ' ' || value.back() == '\0'))
    value.pop_back();
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

}  // namespace

FrameInfo read_frame_info(const std::string& path) {
  LibRaw raw;
  const int status = raw.open_file(path.c_str());
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("open_file: ") + libraw_strerror(status));
  }

  FrameInfo info;
  info.camera = trimmed(raw.imgdata.idata.make) + " " + trimmed(raw.imgdata.idata.model);
  info.captured_at = format_timestamp(raw.imgdata.other.timestamp);
  info.shutter = raw.imgdata.other.shutter;
  info.aperture = raw.imgdata.other.aperture;
  info.iso = raw.imgdata.other.iso_speed;
  info.focal_length = raw.imgdata.other.focal_len;
  info.focal_length_35 = raw.imgdata.lens.makernotes.FocalLengthIn35mmFormat;
  if (info.focal_length_35 <= 0) info.focal_length_35 = raw.imgdata.lens.FocalLengthIn35mmFormat;
  for (int channel = 0; channel < 3; ++channel) {
    info.white_balance[static_cast<size_t>(channel)] = raw.imgdata.color.cam_mul[channel];
  }
  info.width = raw.imgdata.sizes.width;
  info.height = raw.imgdata.sizes.height;
  return info;
}

double exposure_value(const FrameInfo& info) {
  if (info.shutter <= 0 || info.aperture <= 0) return 0;
  const double sensitivity = info.iso > 0 ? info.iso : 100.0;
  return std::log2(info.aperture * info.aperture / info.shutter) - std::log2(sensitivity / 100.0);
}

double focal_pixels(const FrameInfo& info, uint32_t width) {
  if (info.focal_length_35 <= 0 || width == 0) return 0;
  return info.focal_length_35 * width / kFullFrameWidthMm;
}

}  // namespace latent

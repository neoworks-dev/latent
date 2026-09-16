#include "raw_decode.h"

#include <chrono>

#include <stdexcept>

#include <libraw/libraw.h>

namespace probe {

DecodedRaw decode_raw(const std::string& path) {
  using clock = std::chrono::steady_clock;
  LibRaw raw;
  auto& params = raw.imgdata.params;
  params.output_bps = 16;
  params.use_camera_wb = 1;
  params.no_auto_bright = 1;
  params.output_color = 1;  // sRGB primaries for the probe; the engine will keep camera space
  params.gamm[0] = 1.0;     // linear
  params.gamm[1] = 1.0;
  params.user_qual = 3;  // AHD demosaic

  auto t0 = clock::now();
  int status = raw.open_file(path.c_str());
  if (status != LIBRAW_SUCCESS)
    throw std::runtime_error(std::string("open_file: ") + libraw_strerror(status));
  status = raw.unpack();
  if (status != LIBRAW_SUCCESS)
    throw std::runtime_error(std::string("unpack: ") + libraw_strerror(status));
  status = raw.dcraw_process();
  if (status != LIBRAW_SUCCESS)
    throw std::runtime_error(std::string("dcraw_process: ") + libraw_strerror(status));
  libraw_processed_image_t* image = raw.dcraw_make_mem_image(&status);
  if (image == nullptr)
    throw std::runtime_error(std::string("dcraw_make_mem_image: ") + libraw_strerror(status));
  auto t1 = clock::now();

  DecodedRaw out;
  out.width = image->width;
  out.height = image->height;
  out.camera = std::string(raw.imgdata.idata.make) + " " + raw.imgdata.idata.model;
  out.decode_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

  if (image->colors != 3 || image->bits != 16) {
    LibRaw::dcraw_clear_mem(image);
    throw std::runtime_error("unexpected LibRaw output layout");
  }

  // LibRaw only emits RGB; WebGPU has no rgb16 texture format, so pad to RGBA once.
  const size_t pixel_count = static_cast<size_t>(out.width) * out.height;
  out.rgba.resize(pixel_count * 4);
  const auto* src = reinterpret_cast<const uint16_t*>(image->data);
  uint16_t* dst = out.rgba.data();
  for (size_t i = 0; i < pixel_count; ++i) {
    dst[i * 4 + 0] = src[i * 3 + 0];
    dst[i * 4 + 1] = src[i * 3 + 1];
    dst[i * 4 + 2] = src[i * 3 + 2];
    dst[i * 4 + 3] = 65535;
  }
  auto t2 = clock::now();
  out.expand_ms = std::chrono::duration<double, std::milli>(t2 - t1).count();

  LibRaw::dcraw_clear_mem(image);
  return out;
}

}  // namespace probe

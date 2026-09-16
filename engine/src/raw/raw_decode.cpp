#include "raw/raw_decode.h"

#include "merge/source_image.h"

#include <chrono>

#include <memory>
#include <stdexcept>

#include <libraw/libraw.h>

namespace latent {

namespace {

// dcraw_make_mem_image hands back a malloc'd struct with its own free function.
struct ProcessedImageDeleter {
  void operator()(libraw_processed_image_t* image) const { LibRaw::dcraw_clear_mem(image); }
};
using ProcessedImage = std::unique_ptr<libraw_processed_image_t, ProcessedImageDeleter>;

}  // namespace

DecodedRaw decode_raw(const std::string& path) {
  using clock = std::chrono::steady_clock;
  const auto started = clock::now();

  // A Photo Merge result is a source image, not a raw: already demosaiced and already in
  // the working space (merge/source_image.h). There is nothing for LibRaw to do — no
  // linearise, no camera matrix — so the whole block below is skipped rather than made
  // into an identity. Only a .tif with a `.latent-source.json` beside it takes this path,
  // so a TIFF-based raw still goes to LibRaw.
  if (is_source_tiff(path)) {
    DecodedRaw out = read_source_tiff(path);
    out.decode_ms = std::chrono::duration<double, std::milli>(clock::now() - started).count();
    return out;
  }

  LibRaw raw;
  auto& params = raw.imgdata.params;
  params.output_bps = 16;
  params.use_camera_wb = 1;
  params.no_auto_bright = 1;
  // sRGB primaries, linear. PROMPT.md wants Rec.2020 as the working space; that is a
  // matrix swap here plus a display transform, tracked as a Phase 0 deviation.
  params.output_color = 1;
  params.gamm[0] = 1.0;
  params.gamm[1] = 1.0;
  params.user_qual = 3;  // AHD demosaic

  int status = raw.open_file(path.c_str());
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("open_file: ") + libraw_strerror(status));
  }
  status = raw.unpack();
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("unpack: ") + libraw_strerror(status));
  }
  status = raw.dcraw_process();
  if (status != LIBRAW_SUCCESS) {
    throw std::runtime_error(std::string("dcraw_process: ") + libraw_strerror(status));
  }
  ProcessedImage image(raw.dcraw_make_mem_image(&status));
  if (!image) {
    throw std::runtime_error(std::string("dcraw_make_mem_image: ") + libraw_strerror(status));
  }
  if (image->colors != 3 || image->bits != 16) {
    throw std::runtime_error("unexpected LibRaw output layout");
  }

  DecodedRaw out;
  out.width = image->width;
  out.height = image->height;
  out.camera = std::string(raw.imgdata.idata.make) + " " + raw.imgdata.idata.model;

  // LibRaw only emits RGB; WebGPU has no rgb16 texture format, so pad to RGBA once.
  const size_t pixel_count = static_cast<size_t>(out.width) * out.height;
  out.rgba.resize(pixel_count * 4);
  const auto* source = reinterpret_cast<const uint16_t*>(image->data);
  uint16_t* destination = out.rgba.data();
  for (size_t i = 0; i < pixel_count; ++i) {
    destination[i * 4 + 0] = source[i * 3 + 0];
    destination[i * 4 + 1] = source[i * 3 + 1];
    destination[i * 4 + 2] = source[i * 3 + 2];
    destination[i * 4 + 3] = 65535;
  }
  out.decode_ms = std::chrono::duration<double, std::milli>(clock::now() - started).count();
  return out;
}

}  // namespace latent

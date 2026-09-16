#include "export/encoder.h"

#include "image/jpeg.h"

#include <cstdio>
#include <cstring>
#include <png.h>
#include <tiffio.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#ifdef LATENT_HAVE_AVIF
#include <avif/avif.h>
#endif

namespace latent {

namespace {

// An APP2 segment carries at most 65533 payload bytes; 14 of them are the identifier and
// the chunk counters, so this is what is left for profile data.
constexpr size_t kIccChunkBytes = 65519;
constexpr std::string_view kIccIdentifier = "ICC_PROFILE";

void require_shape(const Rgb16Image& image) {
  if (image.width == 0 || image.height == 0) throw std::runtime_error("export image is empty");
  if (image.pixels.size() != image.expected_size()) {
    throw std::runtime_error("export image buffer does not match its dimensions");
  }
}

Rgb8Image to_rgb8(const Rgb16Image& image) {
  Rgb8Image out;
  out.width = image.width;
  out.height = image.height;
  out.pixels.resize(image.pixels.size());
  for (size_t i = 0; i < image.pixels.size(); ++i) {
    // 65535 -> 255 exactly, and every step in between rounds rather than truncating.
    out.pixels[i] = static_cast<uint8_t>((image.pixels[i] + 128U) / 257U);
  }
  return out;
}

void push_be16(std::vector<uint8_t>& out, uint32_t value) {
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
  out.push_back(static_cast<uint8_t>(value & 0xFF));
}

// Where the ICC segments belong: after SOI and after the JFIF/Exif segment the encoder
// already wrote, before everything else.
size_t icc_insertion_point(const std::vector<uint8_t>& jpeg) {
  if (jpeg.size() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) {
    throw std::runtime_error("libjpeg produced something that is not a JPEG");
  }
  size_t at = 2;
  while (at + 4 <= jpeg.size() && jpeg[at] == 0xFF &&
         (jpeg[at + 1] == 0xE0 || jpeg[at + 1] == 0xE1)) {
    const size_t length = (static_cast<size_t>(jpeg[at + 2]) << 8) | jpeg[at + 3];
    if (length < 2 || at + 2 + length > jpeg.size()) break;
    at += 2 + length;
  }
  return at;
}

// JFIF APP0 holds the pixel density; TurboJPEG writes 1x1 "aspect ratio" units, so a dpi
// request is a patch of five bytes rather than a second encode.
void patch_jfif_density(std::vector<uint8_t>& jpeg, uint32_t dpi) {
  if (dpi == 0 || jpeg.size() < 20) return;
  if (!(jpeg[2] == 0xFF && jpeg[3] == 0xE0)) return;
  if (std::memcmp(jpeg.data() + 6, "JFIF\0", 5) != 0) return;
  jpeg[13] = 1;  // units: dots per inch
  jpeg[14] = static_cast<uint8_t>((dpi >> 8) & 0xFF);
  jpeg[15] = static_cast<uint8_t>(dpi & 0xFF);
  jpeg[16] = static_cast<uint8_t>((dpi >> 8) & 0xFF);
  jpeg[17] = static_cast<uint8_t>(dpi & 0xFF);
}

std::vector<uint8_t> encode_jpeg_with_icc(const Rgb16Image& image, const EncodeOptions& options) {
  std::vector<uint8_t> jpeg = encode_jpeg(to_rgb8(image), options.quality);
  patch_jfif_density(jpeg, options.dpi);
  if (options.icc.empty()) return jpeg;

  const size_t chunks = (options.icc.size() + kIccChunkBytes - 1) / kIccChunkBytes;
  if (chunks > 255) throw std::runtime_error("ICC profile is too large for a JPEG");
  std::vector<uint8_t> markers;
  for (size_t chunk = 0; chunk < chunks; ++chunk) {
    const size_t offset = chunk * kIccChunkBytes;
    const size_t bytes = std::min(kIccChunkBytes, options.icc.size() - offset);
    markers.push_back(0xFF);
    markers.push_back(0xE2);
    push_be16(markers, static_cast<uint32_t>(bytes + 16));
    markers.insert(markers.end(), kIccIdentifier.begin(), kIccIdentifier.end());
    markers.push_back(0);
    markers.push_back(static_cast<uint8_t>(chunk + 1));
    markers.push_back(static_cast<uint8_t>(chunks));
    markers.insert(markers.end(), options.icc.begin() + static_cast<ptrdiff_t>(offset),
                   options.icc.begin() + static_cast<ptrdiff_t>(offset + bytes));
  }
  jpeg.insert(jpeg.begin() + static_cast<ptrdiff_t>(icc_insertion_point(jpeg)), markers.begin(),
              markers.end());
  return jpeg;
}

std::vector<uint8_t> encode_png16(const Rgb16Image& image, const EncodeOptions& options) {
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (png == nullptr) throw std::runtime_error("png_create_write_struct failed");
  png_infop info = png_create_info_struct(png);
  if (info == nullptr) {
    png_destroy_write_struct(&png, nullptr);
    throw std::runtime_error("png_create_info_struct failed");
  }

  std::vector<uint8_t> out;
  std::vector<uint16_t> row(static_cast<size_t>(image.width) * 3);
  // libpng reports errors through longjmp; everything it can touch above is either a POD
  // or a vector whose destructor runs after this function returns normally.
  if (setjmp(png_jmpbuf(png)) != 0) {  // NOLINT(cert-err52-cpp)
    png_destroy_write_struct(&png, &info);
    throw std::runtime_error("libpng failed to write the export");
  }
  png_set_write_fn(
      png, &out,
      [](png_structp context, png_bytep data, png_size_t length) {
        auto* sink = static_cast<std::vector<uint8_t>*>(png_get_io_ptr(context));
        sink->insert(sink->end(), data, data + length);
      },
      [](png_structp) {});
  png_set_IHDR(png, info, image.width, image.height, 16, PNG_COLOR_TYPE_RGB, PNG_INTERLACE_NONE,
               PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
  if (!options.icc.empty()) {
    png_set_iCCP(png, info, "Latent", PNG_COMPRESSION_TYPE_BASE,
                 reinterpret_cast<png_const_bytep>(options.icc.data()),
                 static_cast<png_uint_32>(options.icc.size()));
  }
  if (options.dpi > 0) {
    // pHYs is metres; 1 inch = 0.0254 m.
    const auto per_metre = static_cast<png_uint_32>((options.dpi / 0.0254) + 0.5);
    png_set_pHYs(png, info, per_metre, per_metre, PNG_RESOLUTION_METER);
  }
  png_write_info(png, info);
  png_set_swap(png);  // the buffer is host-endian; PNG is big-endian
  for (uint32_t y = 0; y < image.height; ++y) {
    std::memcpy(row.data(), image.pixels.data() + (static_cast<size_t>(y) * row.size()),
                row.size() * sizeof(uint16_t));
    png_write_row(png, reinterpret_cast<png_bytep>(row.data()));
  }
  png_write_end(png, info);
  png_destroy_write_struct(&png, &info);
  return out;
}

// libtiff writes through a handle; this is the in-memory one, so an export never needs a
// scratch file and a failed encode leaves nothing behind.
struct TiffSink {
  std::vector<uint8_t> bytes;
  toff_t offset = 0;
};

tmsize_t tiff_write(thandle_t handle, void* data, tmsize_t length) {
  auto* sink = static_cast<TiffSink*>(handle);
  const auto at = static_cast<size_t>(sink->offset);
  if (sink->bytes.size() < at + static_cast<size_t>(length)) {
    sink->bytes.resize(at + static_cast<size_t>(length));
  }
  std::memcpy(sink->bytes.data() + at, data, static_cast<size_t>(length));
  sink->offset += static_cast<toff_t>(length);
  return length;
}

toff_t tiff_seek(thandle_t handle, toff_t offset, int whence) {
  auto* sink = static_cast<TiffSink*>(handle);
  if (whence == SEEK_CUR) offset += sink->offset;
  if (whence == SEEK_END) offset += static_cast<toff_t>(sink->bytes.size());
  sink->offset = offset;
  return sink->offset;
}

std::vector<uint8_t> encode_tiff16(const Rgb16Image& image, const EncodeOptions& options) {
  TiffSink sink;
  TIFF* tiff = TIFFClientOpen(
      "latent-export", "w", &sink, [](thandle_t, void*, tmsize_t) -> tmsize_t { return 0; },
      tiff_write, tiff_seek, [](thandle_t) { return 0; },
      [](thandle_t handle) {
        return static_cast<toff_t>(static_cast<TiffSink*>(handle)->bytes.size());
      },
      nullptr, nullptr);
  if (tiff == nullptr) throw std::runtime_error("TIFFClientOpen failed");

  TIFFSetField(tiff, TIFFTAG_IMAGEWIDTH, image.width);
  TIFFSetField(tiff, TIFFTAG_IMAGELENGTH, image.height);
  TIFFSetField(tiff, TIFFTAG_SAMPLESPERPIXEL, 3);
  TIFFSetField(tiff, TIFFTAG_BITSPERSAMPLE, 16);
  TIFFSetField(tiff, TIFFTAG_SAMPLEFORMAT, SAMPLEFORMAT_UINT);
  TIFFSetField(tiff, TIFFTAG_ORIENTATION, ORIENTATION_TOPLEFT);
  TIFFSetField(tiff, TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG);
  TIFFSetField(tiff, TIFFTAG_PHOTOMETRIC, PHOTOMETRIC_RGB);
  TIFFSetField(tiff, TIFFTAG_COMPRESSION, COMPRESSION_ADOBE_DEFLATE);
  TIFFSetField(tiff, TIFFTAG_ROWSPERSTRIP, TIFFDefaultStripSize(tiff, 0));
  TIFFSetField(tiff, TIFFTAG_SOFTWARE, "Latent");
  if (!options.icc.empty()) {
    TIFFSetField(tiff, TIFFTAG_ICCPROFILE, static_cast<uint32_t>(options.icc.size()),
                 options.icc.data());
  }
  if (options.dpi > 0) {
    TIFFSetField(tiff, TIFFTAG_RESOLUTIONUNIT, RESUNIT_INCH);
    TIFFSetField(tiff, TIFFTAG_XRESOLUTION, static_cast<float>(options.dpi));
    TIFFSetField(tiff, TIFFTAG_YRESOLUTION, static_cast<float>(options.dpi));
  }

  const size_t row_values = static_cast<size_t>(image.width) * 3;
  std::vector<uint16_t> row(row_values);
  for (uint32_t y = 0; y < image.height; ++y) {
    std::memcpy(row.data(), image.pixels.data() + (static_cast<size_t>(y) * row_values),
                row_values * sizeof(uint16_t));
    if (TIFFWriteScanline(tiff, row.data(), y, 0) < 0) {
      TIFFClose(tiff);
      throw std::runtime_error("TIFFWriteScanline failed");
    }
  }
  TIFFClose(tiff);
  return std::move(sink.bytes);
}

#ifdef LATENT_HAVE_AVIF
std::vector<uint8_t> encode_avif(const Rgb16Image& image, const EncodeOptions& options) {
  // 10 bits is what AV1 encodes best and what every HDR-capable viewer expects; 16-bit
  // input is shifted down rather than dithered, which at 10 bits is below visible.
  avifImage* picture = avifImageCreate(image.width, image.height, 10, AVIF_PIXEL_FORMAT_YUV444);
  if (picture == nullptr) throw std::runtime_error("avifImageCreate failed");
  picture->yuvRange = AVIF_RANGE_FULL;
  if (!options.icc.empty() &&
      avifImageSetProfileICC(picture, options.icc.data(), options.icc.size()) != AVIF_RESULT_OK) {
    avifImageDestroy(picture);
    throw std::runtime_error("avifImageSetProfileICC failed");
  }

  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, picture);
  rgb.format = AVIF_RGB_FORMAT_RGB;
  rgb.depth = 16;
  rgb.pixels = reinterpret_cast<uint8_t*>(const_cast<uint16_t*>(image.pixels.data()));
  rgb.rowBytes = image.width * 3 * sizeof(uint16_t);

  avifResult result = avifImageRGBToYUV(picture, &rgb);
  if (result != AVIF_RESULT_OK) {
    avifImageDestroy(picture);
    throw std::runtime_error(std::string("avifImageRGBToYUV: ") + avifResultToString(result));
  }

  avifEncoder* encoder = avifEncoderCreate();
  if (encoder == nullptr) {
    avifImageDestroy(picture);
    throw std::runtime_error("avifEncoderCreate failed");
  }
  encoder->quality = options.quality;
  encoder->qualityAlpha = options.quality;
  encoder->speed = 6;
  avifRWData output = AVIF_DATA_EMPTY;
  result = avifEncoderWrite(encoder, picture, &output);
  avifEncoderDestroy(encoder);
  avifImageDestroy(picture);
  if (result != AVIF_RESULT_OK) {
    avifRWDataFree(&output);
    throw std::runtime_error(std::string("avifEncoderWrite: ") + avifResultToString(result));
  }
  std::vector<uint8_t> bytes(output.data, output.data + output.size);
  avifRWDataFree(&output);
  return bytes;
}
#endif

}  // namespace

bool export_avif_available() {
#ifdef LATENT_HAVE_AVIF
  return true;
#else
  return false;
#endif
}

std::vector<uint8_t> encode_export(const Rgb16Image& image, const EncodeOptions& options) {
  require_shape(image);
  switch (options.format) {
    case ExportFormat::Png:
      return encode_png16(image, options);
    case ExportFormat::Tiff16:
      return encode_tiff16(image, options);
    case ExportFormat::Avif:
#ifdef LATENT_HAVE_AVIF
      return encode_avif(image, options);
#else
      throw std::runtime_error("this build of latentd has no AVIF encoder");
#endif
    default:
      return encode_jpeg_with_icc(image, options);
  }
}

void write_export_file(const std::string& path, std::span<const uint8_t> bytes) {
  const std::filesystem::path target(path);
  if (target.has_parent_path()) std::filesystem::create_directories(target.parent_path());
  const std::filesystem::path temporary = target.string() + ".part";
  {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    if (!file) throw std::runtime_error("cannot write " + temporary.string());
    file.write(reinterpret_cast<const char*>(bytes.data()),
               static_cast<std::streamsize>(bytes.size()));
    if (!file) throw std::runtime_error("write failed for " + temporary.string());
  }
  std::filesystem::rename(temporary, target);
}

}  // namespace latent

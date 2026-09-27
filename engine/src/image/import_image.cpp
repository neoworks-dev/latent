#include "image/import_image.h"

#include "ops/mask.h"

#include <cmath>
#include <csetjmp>
#include <cstdint>
#include <cstring>
#include <png.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <memory>
#include <span>
#include <stdexcept>
#include <string_view>

#include <lcms2.h>
#include <libexif/exif-data.h>

namespace latent {

namespace {

constexpr std::array<std::string_view, 3> kRenderedExtensions = {".png", ".jpg", ".jpeg"};

// cmsHPROFILE and cmsHTRANSFORM are both void*, so the deleters are what tells them apart.
struct ProfileDeleter {
  void operator()(void* profile) const { cmsCloseProfile(profile); }
};
using Profile = std::unique_ptr<void, ProfileDeleter>;

struct TransformDeleter {
  void operator()(void* transform) const { cmsDeleteTransform(transform); }
};
using Transform = std::unique_ptr<void, TransformDeleter>;

struct ToneCurveDeleter {
  void operator()(cmsToneCurve* curve) const { cmsFreeToneCurve(curve); }
};
using ToneCurve = std::unique_ptr<cmsToneCurve, ToneCurveDeleter>;

// What a codec hands back: pixels still in the file's own encoding, because undoing the
// transfer function is lcms2's job and doing it twice is the one mistake that matters here.
struct EncodedImage {
  uint32_t width = 0;
  uint32_t height = 0;
  // 8 or 16 bits per component, host byte order, interleaved. RGBA for a PNG, RGB for a JPEG.
  uint32_t depth = 8;
  bool alpha = false;
  std::vector<uint8_t> pixels;
  // The device→linear exponent the file asks for when it carries no ICC profile: 2.2 for a
  // gAMA of 1/2.2, zero for "use the sRGB curve", which is also what a file that says
  // nothing gets. JPEGs never set this.
  double gamma = 0;
};

// Everything the file says about itself before a single pixel is decoded: the catalog row,
// the colour profile, and which way is up.
struct RenderedFile {
  RawMetadata row;
  std::vector<uint8_t> icc;
  // LibRaw's `imgdata.sizes.flip`, translated from EXIF orientation so the whole engine
  // speaks one dialect of "which way is up" (image/jpeg.h documents the bitmask).
  int flip = 0;
};

// A PNG's header chunks, without touching IDAT. Everything the catalog needs about a PNG is
// in here, so importing a folder of them never decodes a pixel.
struct PngHeader {
  uint32_t width = 0;
  uint32_t height = 0;
  double gamma = 0;
  std::vector<uint8_t> exif;
  std::vector<uint8_t> icc;
};

struct ExifDeleter {
  void operator()(ExifData* data) const { exif_data_unref(data); }
};
using Exif = std::unique_ptr<ExifData, ExifDeleter>;

// EXIF 2.3's LensModel. libexif's ExifTag enum does not name it, and the numeric tag is the
// same in every file that has one.
constexpr ExifTag kLensModelTag = static_cast<ExifTag>(0xA434);

// libpng's fatal errors arrive by longjmp, and the reader pair has to be released on that
// path as well as on the throw that follows it. The stream is std::ifstream rather than the
// FILE* png_init_io wants, so the only thing here without a destructor is libpng's own pair.
struct PngReader {
  png_structp png = nullptr;
  png_infop info = nullptr;
  std::ifstream file;

  PngReader() = default;
  ~PngReader() {
    if (png != nullptr) png_destroy_read_struct(&png, info != nullptr ? &info : nullptr, nullptr);
  }
  PngReader(const PngReader&) = delete;
  PngReader& operator=(const PngReader&) = delete;
  PngReader(PngReader&&) = delete;
  PngReader& operator=(PngReader&&) = delete;
};

std::string lower_extension(const std::string& path) {
  std::string extension = std::filesystem::path(path).extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char character) { return std::tolower(character); });
  return extension;
}

bool is_png(const std::string& path) {
  return lower_extension(path) == ".png";
}

std::vector<uint8_t> read_file_bytes(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error("cannot read " + path);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                             std::istreambuf_iterator<char>());
  if (bytes.empty()) throw std::runtime_error("empty file: " + path);
  return bytes;
}

// EXIF orientation 1..8 to dcraw's flip. 6 and 8 are what a camera held sideways writes; 5
// and 7 only turn up in files something else has already been at.
int flip_for_orientation(int orientation) {
  constexpr std::array<int, 8> kFlips = {0, 1, 3, 2, 4, 6, 7, 5};
  if (orientation < 1 || orientation > 8) return 0;
  return kFlips[static_cast<size_t>(orientation - 1)];
}

// The same tag can sit in IFD0 or in the EXIF sub-IFD depending on who wrote the file, and
// no tag this importer wants means two different things in two IFDs, so one sweep is enough.
const ExifEntry* find_entry(const Exif& exif, ExifTag tag) {
  if (!exif) return nullptr;
  for (int ifd = 0; ifd < EXIF_IFD_COUNT; ++ifd) {
    const ExifEntry* entry = exif_content_get_entry(exif->ifd[ifd], tag);
    if (entry != nullptr && entry->data != nullptr && entry->size > 0) return entry;
  }
  return nullptr;
}

std::string exif_text(const Exif& exif, ExifTag tag) {
  const ExifEntry* entry = find_entry(exif, tag);
  if (entry == nullptr || entry->format != EXIF_FORMAT_ASCII) return {};
  std::string value(reinterpret_cast<const char*>(entry->data), entry->size);
  const size_t terminator = value.find('\0');
  if (terminator != std::string::npos) value.resize(terminator);
  while (!value.empty() && value.back() == ' ') {
    value.pop_back();
  }
  return value;
}

// Raw values, not exif_entry_get_value: that renders for a human ("1/250 sec.", "f/2.8") and
// what it renders depends on the locale.
double exif_number(const Exif& exif, ExifTag tag) {
  const ExifEntry* entry = find_entry(exif, tag);
  if (entry == nullptr) return 0;
  const ExifByteOrder order = exif_data_get_byte_order(exif.get());
  switch (entry->format) {
    case EXIF_FORMAT_SHORT:
      return exif_get_short(entry->data, order);
    case EXIF_FORMAT_LONG:
      return exif_get_long(entry->data, order);
    case EXIF_FORMAT_RATIONAL: {
      const ExifRational value = exif_get_rational(entry->data, order);
      return value.denominator == 0 ? 0.0
                                    : static_cast<double>(value.numerator) / value.denominator;
    }
    case EXIF_FORMAT_SRATIONAL: {
      const ExifSRational value = exif_get_srational(entry->data, order);
      return value.denominator == 0 ? 0.0
                                    : static_cast<double>(value.numerator) / value.denominator;
    }
    default:
      return 0;
  }
}

// A JPEG hides its EXIF in an APP1 segment and libexif finds it itself. A PNG's eXIf chunk
// is the bare TIFF block, which libexif only recognises behind the marker a JPEG would have
// put in front of it.
Exif load_exif(const std::string& path, std::span<const uint8_t> png_exif) {
  if (png_exif.empty()) return Exif(exif_data_new_from_file(path.c_str()));

  constexpr std::array<uint8_t, 6> kMarker = {'E', 'x', 'i', 'f', 0, 0};
  std::vector<uint8_t> block;
  if (png_exif.size() < kMarker.size() ||
      std::memcmp(png_exif.data(), kMarker.data(), kMarker.size()) != 0) {
    block.assign(kMarker.begin(), kMarker.end());
  }
  block.insert(block.end(), png_exif.begin(), png_exif.end());
  return Exif(exif_data_new_from_data(block.data(), static_cast<unsigned int>(block.size())));
}

// The ICC profile a JPEG carries rides in one or more APP2 segments, each behind an
// "ICC_PROFILE\0" tag plus a 1-based chunk index and a chunk count. libexif does not look at
// them, so the marker walk is ours: SOI, then length-prefixed segments up to SOS, where the
// entropy-coded data starts and nothing is self-describing any more.
std::vector<uint8_t> jpeg_icc_profile(std::span<const uint8_t> jpeg) {
  constexpr std::string_view kTag = "ICC_PROFILE";
  constexpr size_t kHeader = kTag.size() + 3;  // tag, NUL, chunk index, chunk count
  if (jpeg.size() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) return {};

  std::vector<std::vector<uint8_t>> chunks;
  size_t at = 2;
  while (at + 4 <= jpeg.size() && jpeg[at] == 0xFF) {
    const uint8_t marker = jpeg[at + 1];
    // Standalone markers carry no length word; SOS and EOI end the header region.
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {
      at += 2;
      continue;
    }
    if (marker == 0xDA || marker == 0xD9) break;
    const size_t length = (static_cast<size_t>(jpeg[at + 2]) << 8U) | jpeg[at + 3];
    if (length < 2 || at + 2 + length > jpeg.size()) break;
    const std::span<const uint8_t> payload = jpeg.subspan(at + 4, length - 2);
    at += 2 + length;

    if (marker != 0xE2 || payload.size() <= kHeader) continue;
    if (std::memcmp(payload.data(), kTag.data(), kTag.size()) != 0) continue;
    if (payload[kTag.size()] != 0) continue;
    const size_t index = payload[kTag.size() + 1];
    if (index == 0) continue;
    if (chunks.size() < index) chunks.resize(index);
    const std::span<const uint8_t> data = payload.subspan(kHeader);
    chunks[index - 1].assign(data.begin(), data.end());
  }

  std::vector<uint8_t> profile;
  for (const std::vector<uint8_t>& chunk : chunks) {
    profile.insert(profile.end(), chunk.begin(), chunk.end());
  }
  return profile;
}

// EXIF stores "2026:09:17 14:03:11"; the catalog stores ISO 8601 without a zone, which is
// the same characters with three of them swapped.
std::string iso_timestamp(const std::string& exif_datetime) {
  if (exif_datetime.size() < 19) return {};
  std::string out = exif_datetime.substr(0, 19);
  out[4] = '-';
  out[7] = '-';
  out[10] = 'T';
  return out;
}

// libpng reads through whatever the caller gives it. png_init_io wants a FILE*, and a
// FILE* is the one handle in this file that would need hand-written cleanup, so the stream
// is ours and this is how libpng pulls from it. png_error longjmps to the caller's setjmp,
// which is libpng's own contract for a read that cannot continue.
void read_from_stream(png_structp png, png_bytep target, png_size_t size) {
  auto* file = static_cast<std::ifstream*>(png_get_io_ptr(png));
  if (file == nullptr ||
      !file->read(reinterpret_cast<char*>(target), static_cast<std::streamsize>(size))) {
    png_error(png, "truncated PNG");
  }
}

// setjmp has to sit in the frame that owns the read, so only the opening is shared.
void open_png(PngReader& state, const std::string& path) {
  state.file.open(path, std::ios::binary);
  if (!state.file) throw std::runtime_error("cannot read " + path);
  state.png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (state.png == nullptr) throw std::runtime_error("libpng: cannot create a reader");
  state.info = png_create_info_struct(state.png);
  if (state.info == nullptr) throw std::runtime_error("libpng: cannot create an info struct");
}

// An sRGB chunk settles the encoding; a gAMA is the file naming its own exponent. Neither
// means sRGB, which is what a photo out of any camera or browser actually is.
double png_gamma(png_structp png, png_infop info) {
  if (png_get_valid(png, info, PNG_INFO_sRGB) != 0) return 0;
  double file_gamma = 0;
  if (png_get_gAMA(png, info, &file_gamma) == 0 || file_gamma <= 0) return 0;
  return 1.0 / file_gamma;
}

PngHeader read_png_header(const std::string& path) {
  PngReader state;
  open_png(state, path);

  PngHeader out;
  if (setjmp(png_jmpbuf(state.png)) != 0) throw std::runtime_error("cannot read " + path);
  png_set_read_fn(state.png, &state.file, read_from_stream);
  png_read_info(state.png, state.info);

  out.width = png_get_image_width(state.png, state.info);
  out.height = png_get_image_height(state.png, state.info);
  out.gamma = png_gamma(state.png, state.info);

  // Both chunks are read before IDAT. A writer that puts eXIf after the pixels instead is
  // legal and rare; its metadata is simply not seen, which costs the EXIF fields and never
  // the image.
  png_uint_32 exif_size = 0;
  png_bytep exif = nullptr;
  if (png_get_eXIf_1(state.png, state.info, &exif_size, &exif) != 0 && exif != nullptr) {
    out.exif.assign(exif, exif + exif_size);
  }
  png_charp name = nullptr;
  int compression = 0;
  png_bytep profile = nullptr;
  png_uint_32 profile_size = 0;
  if (png_get_iCCP(state.png, state.info, &name, &compression, &profile, &profile_size) != 0 &&
      profile != nullptr) {
    out.icc.assign(profile, profile + profile_size);
  }
  return out;
}

EncodedImage read_png_encoded(const std::string& path) {
  PngReader state;
  open_png(state, path);

  EncodedImage out;
  std::vector<png_bytep> rows;
  // Not the simplified API: it only offers 16-bit output already linearised, and it
  // approximates the sRGB curve with a pure gamma of 2.2, which is six times off in the
  // darkest codes — exactly the tones a shadow lift goes looking for. Reading the file in
  // its own encoding and handing it to lcms2 is what makes a PNG and a JPEG land in the
  // same place.
  if (setjmp(png_jmpbuf(state.png)) != 0) throw std::runtime_error("cannot decode " + path);

  png_set_read_fn(state.png, &state.file, read_from_stream);
  png_read_info(state.png, state.info);
  const png_uint_32 width = png_get_image_width(state.png, state.info);
  const png_uint_32 height = png_get_image_height(state.png, state.info);
  const int depth = png_get_bit_depth(state.png, state.info);
  const int color = png_get_color_type(state.png, state.info);
  if (width == 0 || height == 0) throw std::runtime_error("empty PNG: " + path);

  if (color == PNG_COLOR_TYPE_PALETTE) png_set_palette_to_rgb(state.png);
  if ((color & PNG_COLOR_MASK_COLOR) == 0) {
    if (depth < 8) png_set_expand_gray_1_2_4_to_8(state.png);
    png_set_gray_to_rgb(state.png);
  }
  if (png_get_valid(state.png, state.info, PNG_INFO_tRNS) != 0) png_set_tRNS_to_alpha(state.png);
  png_set_add_alpha(state.png, depth == 16 ? 0xffff : 0xff, PNG_FILLER_AFTER);
  // PNG stores 16-bit samples big-endian; lcms2 reads whatever the host uses.
  if (depth == 16) png_set_swap(state.png);
  png_set_interlace_handling(state.png);
  out.gamma = png_gamma(state.png, state.info);
  png_read_update_info(state.png, state.info);

  out.width = width;
  out.height = height;
  out.depth = depth == 16 ? 16 : 8;
  out.alpha = true;
  const size_t stride = static_cast<size_t>(width) * 4 * (out.depth / 8);
  if (png_get_rowbytes(state.png, state.info) != stride) {
    throw std::runtime_error("unexpected PNG row layout: " + path);
  }
  out.pixels.resize(stride * height);
  rows.resize(height);
  for (png_uint_32 y = 0; y < height; ++y) {
    rows[y] = out.pixels.data() + (static_cast<size_t>(y) * stride);
  }
  png_read_image(state.png, rows.data());
  return out;
}

EncodedImage read_jpeg_encoded(const std::string& path, uint32_t min_long_edge) {
  const Rgb8Image image = decode_jpeg_scaled(read_file_bytes(path), min_long_edge);
  EncodedImage out;
  out.width = image.width;
  out.height = image.height;
  out.depth = 8;
  out.alpha = false;
  out.pixels = image.pixels;
  return out;
}

RenderedFile read_rendered_file(const std::string& path) {
  RenderedFile out;
  std::vector<uint8_t> png_exif;
  // Dimensions come from the codec, never from EXIF: PixelXDimension is written by whoever
  // touched the file last and a crop that forgot to update it would put a lie in the catalog.
  if (is_png(path)) {
    const PngHeader header = read_png_header(path);
    out.row.width = header.width;
    out.row.height = header.height;
    out.icc = header.icc;
    png_exif = header.exif;
  } else {
    const std::vector<uint8_t> bytes = read_file_bytes(path);
    const ImageSize size = jpeg_dimensions(bytes);
    out.row.width = size.width;
    out.row.height = size.height;
    out.icc = jpeg_icc_profile(bytes);
  }

  // A file with no metadata at all is still a photo: only the pixels are mandatory.
  const Exif exif = load_exif(path, png_exif);
  const std::string make = exif_text(exif, EXIF_TAG_MAKE);
  const std::string model = exif_text(exif, EXIF_TAG_MODEL);
  if (!make.empty() || !model.empty()) out.row.camera = make + " " + model;
  out.row.lens = exif_text(exif, kLensModelTag);
  out.row.captured_at = iso_timestamp(exif_text(exif, EXIF_TAG_DATE_TIME_ORIGINAL));
  if (out.row.captured_at.empty()) {
    out.row.captured_at = iso_timestamp(exif_text(exif, EXIF_TAG_DATE_TIME));
  }
  out.row.iso = static_cast<int>(std::lround(exif_number(exif, EXIF_TAG_ISO_SPEED_RATINGS)));
  out.row.shutter = format_shutter(exif_number(exif, EXIF_TAG_EXPOSURE_TIME));
  out.row.aperture = exif_number(exif, EXIF_TAG_FNUMBER);
  out.row.focal_length = exif_number(exif, EXIF_TAG_FOCAL_LENGTH);
  out.flip = flip_for_orientation(static_cast<int>(exif_number(exif, EXIF_TAG_ORIENTATION)));

  // The catalog's width/height are what the viewer shows, so a sideways file reports the
  // dimensions it will have once the flip is applied.
  if ((out.flip & 4) != 0) std::swap(out.row.width, out.row.height);
  return out;
}

Profile rgb_profile(double gamma) {
  cmsCIExyY white{0.3127, 0.3290, 1.0};
  cmsCIExyYTRIPLE primaries{{0.640, 0.330, 1.0}, {0.300, 0.600, 1.0}, {0.150, 0.060, 1.0}};
  const ToneCurve curve(cmsBuildGamma(nullptr, gamma));
  if (!curve) throw std::runtime_error("lcms2: cannot build a tone curve");
  std::array<cmsToneCurve*, 3> curves = {curve.get(), curve.get(), curve.get()};
  Profile profile(cmsCreateRGBProfile(&white, &primaries, curves.data()));
  if (!profile) throw std::runtime_error("lcms2: cannot build an sRGB-primaried profile");
  return profile;
}

// The working space: linear sRGB primaries, which is where LibRaw's `output_color = 1`
// leaves a raw and what every shader below assumes (export/color_space.h).
Profile working_space_profile() {
  return rgb_profile(1.0);
}

// The profile the file is in. An embedded one wins; a PNG's gAMA is next; otherwise sRGB,
// which is what an unlabelled photo is in practice.
Profile source_profile(std::span<const uint8_t> icc, double gamma) {
  if (!icc.empty()) {
    Profile embedded(cmsOpenProfileFromMem(icc.data(), static_cast<cmsUInt32Number>(icc.size())));
    if (embedded && cmsGetColorSpace(embedded.get()) == cmsSigRgbData) return embedded;
  }
  if (gamma > 0) return rgb_profile(gamma);
  Profile srgb(cmsCreate_sRGBProfile());
  if (!srgb) throw std::runtime_error("lcms2: cannot build the sRGB profile");
  return srgb;
}

// One transform for both codecs: the file's encoding and primaries in, the working space's
// 16-bit linear RGBA out. Colour outside sRGB clips — an unsigned buffer cannot hold the
// negative blue an AdobeRGB file would need, the same clip the LibRaw path takes.
DecodedRaw to_working_space(const EncodedImage& image, std::span<const uint8_t> icc) {
  const cmsUInt32Number format = image.alpha ? (image.depth == 16 ? TYPE_RGBA_16 : TYPE_RGBA_8)
                                             : (image.depth == 16 ? TYPE_RGB_16 : TYPE_RGB_8);
  const Profile source = source_profile(icc, image.gamma);
  const Profile destination = working_space_profile();
  const Transform transform(cmsCreateTransform(source.get(), format, destination.get(),
                                               TYPE_RGBA_16, INTENT_RELATIVE_COLORIMETRIC,
                                               image.alpha ? cmsFLAGS_COPY_ALPHA : 0));
  if (!transform) throw std::runtime_error("lcms2: cannot build the import transform");

  DecodedRaw out;
  out.width = image.width;
  out.height = image.height;
  // Opaque up front: without an alpha channel to copy, lcms2 writes the three colour
  // components and leaves the fourth as it found it.
  out.rgba.assign(static_cast<size_t>(image.width) * image.height * 4, 65535);
  cmsDoTransform(transform.get(), image.pixels.data(), out.rgba.data(),
                 static_cast<cmsUInt32Number>(image.width) * image.height);
  return out;
}

// Alpha is a compositing instruction, not edit state: the op-stack has nowhere to keep it
// and every pass below assumes an opaque frame. White is what a print and every other
// editor puts behind a transparent PNG. The data is linear, so this is a plain lerp.
void flatten_onto_white(DecodedRaw& image) {
  const size_t pixels = static_cast<size_t>(image.width) * image.height;
  for (size_t i = 0; i < pixels; ++i) {
    const uint32_t alpha = image.rgba[(i * 4) + 3];
    if (alpha == 65535) continue;
    for (size_t channel = 0; channel < 3; ++channel) {
      const uint32_t value = image.rgba[(i * 4) + channel];
      const uint32_t mixed = (value * alpha) + (65535U * (65535U - alpha));
      image.rgba[(i * 4) + channel] = static_cast<uint16_t>((mixed + 32767U) / 65535U);
    }
    image.rgba[(i * 4) + 3] = 65535;
  }
}

// The thumbnail's view of an EncodedImage: 8-bit RGB, transparency over white. Nothing here
// undoes a transfer function or moves primaries — a thumbnail is display-referred already,
// and the raw path's embedded preview is no more colour-managed than this.
Rgb8Image to_display_rgb(const EncodedImage& image) {
  Rgb8Image out;
  out.width = image.width;
  out.height = image.height;
  out.pixels.resize(static_cast<size_t>(image.width) * image.height * 3);

  const size_t channels = image.alpha ? 4 : 3;
  const bool wide = image.depth == 16;
  const auto component = [&image, wide](size_t at) -> uint32_t {
    if (!wide) return image.pixels[at];
    uint16_t value = 0;
    std::memcpy(&value, image.pixels.data() + (at * 2), sizeof(value));
    return value >> 8U;
  };

  const size_t pixels = static_cast<size_t>(image.width) * image.height;
  for (size_t i = 0; i < pixels; ++i) {
    const uint32_t alpha = image.alpha ? component((i * channels) + 3) : 255;
    for (size_t channel = 0; channel < 3; ++channel) {
      const uint32_t value = component((i * channels) + channel);
      const uint32_t mixed = (value * alpha) + (255U * (255U - alpha));
      out.pixels[(i * 3) + channel] = static_cast<uint8_t>((mixed + 127U) / 255U);
    }
  }
  return out;
}

// rotate_for_flip (image/jpeg.h) for the 16-bit RGBA buffer: dcraw's order, dcraw's bitmask.
// LibRaw applies this inside dcraw_process; a rendered file has no such step, so the
// importer bakes EXIF orientation in here and the rest of the engine never sees it.
DecodedRaw rotate_decoded_for_flip(const DecodedRaw& image, int flip) {
  if (flip <= 0 || flip > 7) return image;
  const bool transpose = (flip & 4) != 0;
  const bool mirror_rows = (flip & 2) != 0;
  const bool mirror_columns = (flip & 1) != 0;

  DecodedRaw out;
  out.width = transpose ? image.height : image.width;
  out.height = transpose ? image.width : image.height;
  out.camera = image.camera;
  out.rgba.resize(image.rgba.size());
  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      uint32_t source_x = transpose ? y : x;
      uint32_t source_y = transpose ? x : y;
      if (mirror_columns) source_x = image.width - 1 - source_x;
      if (mirror_rows) source_y = image.height - 1 - source_y;
      const size_t from = ((static_cast<size_t>(source_y) * image.width) + source_x) * 4;
      const size_t to = ((static_cast<size_t>(y) * out.width) + x) * 4;
      std::copy_n(image.rgba.begin() + static_cast<ptrdiff_t>(from), 4,
                  out.rgba.begin() + static_cast<ptrdiff_t>(to));
    }
  }
  return out;
}

}  // namespace

bool is_rendered_extension(const std::string& path) {
  const std::string extension = lower_extension(path);
  return std::find(kRenderedExtensions.begin(), kRenderedExtensions.end(), extension) !=
         kRenderedExtensions.end();
}

bool is_photo_extension(const std::string& path) {
  return is_raw_extension(path) || is_rendered_extension(path);
}

bool is_importable_photo(const std::string& path) {
  return is_photo_extension(path) && !is_inside_legacy_raster_dir(path);
}

DecodedRaw decode_rendered_image(const std::string& path, uint32_t min_long_edge) {
  const RenderedFile file = read_rendered_file(path);
  const EncodedImage encoded =
      is_png(path) ? read_png_encoded(path) : read_jpeg_encoded(path, min_long_edge);

  DecodedRaw decoded = to_working_space(encoded, file.icc);
  flatten_onto_white(decoded);
  decoded.camera = file.row.camera;
  return rotate_decoded_for_flip(decoded, file.flip);
}

RawMetadata read_rendered_metadata(const std::string& path) {
  return read_rendered_file(path).row;
}

RawMetadata read_photo_metadata(const std::string& path) {
  if (is_rendered_extension(path)) return read_rendered_metadata(path);
  return read_raw_metadata(path);
}

Rgb8Image load_photo_preview(const std::string& path, uint32_t max_edge) {
  if (!is_rendered_extension(path)) return load_raw_preview(path, max_edge);
  // No embedded preview to shortcut to, so the file itself is the preview. A JPEG shrinks
  // during the DCT; a PNG has to come out whole before it can be boxed down. Either way the
  // result stays in the file's own encoding — a thumbnail is display-referred already.
  const RenderedFile file = read_rendered_file(path);
  const Rgb8Image image = is_png(path) ? to_display_rgb(read_png_encoded(path))
                                       : decode_jpeg_scaled(read_file_bytes(path), max_edge);
  return rotate_for_flip(box_resize_to_fit(image, max_edge), file.flip);
}

}  // namespace latent

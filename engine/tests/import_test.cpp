// The PNG/JPEG importer: colour, bit depth, transparency, EXIF, ICC. The claim under test is
// parity — a PNG and a JPEG of the same colour have to land on the same linear value, because
// everything above them in the stack assumes one working space.
//
// libexif reads EXIF and does not write it, so the fixtures are built here: a little-endian
// TIFF block spliced into a JPEG as an APP1 segment and into a PNG as an eXIf chunk. Building
// the bytes rather than asking a library for them is also the point — the test owns exactly
// what the parser has to walk, offsets and all.
#include "generative/image_io.h"
#include "image/import_image.h"
#include "image/jpeg.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <png.h>
#include <zlib.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <lcms2.h>

using namespace latent;

namespace {

std::filesystem::path scratch(const char* name) {
  const std::filesystem::path path =
      std::filesystem::temp_directory_path() / (std::string("latent-import-test-") + name);
  std::error_code error;
  std::filesystem::remove_all(path, error);
  std::filesystem::create_directories(path, error);
  return path;
}

std::vector<uint8_t> read_bytes(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(file)),
                              std::istreambuf_iterator<char>());
}

void write_bytes(const std::filesystem::path& path, const std::vector<uint8_t>& bytes) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  file.write(reinterpret_cast<const char*>(bytes.data()),
             static_cast<std::streamsize>(bytes.size()));
}

Rgb8Image flat_rgb(uint32_t width, uint32_t height, uint8_t red, uint8_t green, uint8_t blue) {
  Rgb8Image image;
  image.width = width;
  image.height = height;
  image.pixels.resize(static_cast<size_t>(width) * height * 3);
  for (size_t i = 0; i < static_cast<size_t>(width) * height; ++i) {
    image.pixels[i * 3] = red;
    image.pixels[(i * 3) + 1] = green;
    image.pixels[(i * 3) + 2] = blue;
  }
  return image;
}

void write_jpeg(const std::filesystem::path& path, const Rgb8Image& image) {
  write_bytes(path, encode_jpeg(image, 95));
}

// A 16-bit PNG whose samples are linear light, which is what libpng's simplified writer
// produces and labels with a gAMA of 1.0. The importer has to read that label and leave the
// values alone rather than assume sRGB like an unlabelled file.
void write_linear16_png(const std::filesystem::path& path, uint32_t width, uint32_t height,
                        const std::vector<uint16_t>& pixels) {
  png_image out{};
  out.version = PNG_IMAGE_VERSION;
  out.width = width;
  out.height = height;
  out.format = PNG_FORMAT_LINEAR_RGB;
  REQUIRE(png_image_write_to_file(&out, path.c_str(), 0, pixels.data(), 0, nullptr) != 0);
  png_image_free(&out);
}

// A PNG with an alpha channel, written by hand because the engine's own encoder only moves
// opaque RGB. 8-bit, straight (not premultiplied) alpha.
void write_rgba8_png(const std::filesystem::path& path, uint32_t width, uint32_t height,
                     const std::vector<uint8_t>& pixels) {
  png_image out{};
  out.version = PNG_IMAGE_VERSION;
  out.width = width;
  out.height = height;
  out.format = PNG_FORMAT_RGBA;
  REQUIRE(png_image_write_to_file(&out, path.c_str(), 0, pixels.data(), 0, nullptr) != 0);
  png_image_free(&out);
}

void put16(std::vector<uint8_t>& out, uint16_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xFFU));
  out.push_back(static_cast<uint8_t>(value >> 8U));
}

void put32(std::vector<uint8_t>& out, uint32_t value) {
  for (int shift = 0; shift < 32; shift += 8) {
    out.push_back(static_cast<uint8_t>((value >> shift) & 0xFFU));
  }
}

struct Tag {
  uint16_t id = 0;
  uint16_t format = 0;
  uint32_t count = 0;
  std::vector<uint8_t> payload;
};

Tag ascii_tag(uint16_t id, std::string_view text) {
  Tag tag{id, 2, static_cast<uint32_t>(text.size() + 1), {}};
  tag.payload.assign(text.begin(), text.end());
  tag.payload.push_back(0);
  return tag;
}

Tag short_tag(uint16_t id, uint16_t value) {
  Tag tag{id, 3, 1, {}};
  put16(tag.payload, value);
  return tag;
}

Tag long_tag(uint16_t id, uint32_t value) {
  Tag tag{id, 4, 1, {}};
  put32(tag.payload, value);
  return tag;
}

Tag rational_tag(uint16_t id, uint32_t numerator, uint32_t denominator) {
  Tag tag{id, 5, 1, {}};
  put32(tag.payload, numerator);
  put32(tag.payload, denominator);
  return tag;
}

uint32_t ifd_size(size_t tags) {
  return static_cast<uint32_t>(2 + (12 * tags) + 4);
}

// Values of four bytes or fewer sit in the entry; anything longer is an offset into a heap
// that follows both directories, which is the case the parser can get wrong.
void emit_ifd(std::vector<uint8_t>& out, const std::vector<Tag>& tags, uint32_t heap_offset,
              std::vector<uint8_t>& heap) {
  put16(out, static_cast<uint16_t>(tags.size()));
  for (const Tag& tag : tags) {
    put16(out, tag.id);
    put16(out, tag.format);
    put32(out, tag.count);
    if (tag.payload.size() <= 4) {
      std::vector<uint8_t> inlined = tag.payload;
      inlined.resize(4, 0);
      out.insert(out.end(), inlined.begin(), inlined.end());
      continue;
    }
    put32(out, heap_offset + static_cast<uint32_t>(heap.size()));
    heap.insert(heap.end(), tag.payload.begin(), tag.payload.end());
  }
  put32(out, 0);  // no IFD1: these fixtures carry no embedded thumbnail
}

std::vector<uint8_t> exif_block(uint16_t orientation) {
  constexpr uint32_t kIfd0Offset = 8;
  const uint32_t exif_ifd_offset = kIfd0Offset + ifd_size(4);
  const uint32_t heap_offset = exif_ifd_offset + ifd_size(6);

  const std::vector<Tag> ifd0 = {ascii_tag(0x010F, "Latent"), ascii_tag(0x0110, "Fixture"),
                                 short_tag(0x0112, orientation), long_tag(0x8769, exif_ifd_offset)};
  const std::vector<Tag> sub = {
      rational_tag(0x829A, 1, 250), rational_tag(0x829D, 28, 10),
      short_tag(0x8827, 400),       ascii_tag(0x9003, "2026:09:17 14:03:11"),
      rational_tag(0x920A, 35, 1),  ascii_tag(0xA434, "Latent 35mm F1.4")};

  std::vector<uint8_t> out = {'I', 'I'};
  put16(out, 42);
  put32(out, kIfd0Offset);
  std::vector<uint8_t> heap;
  emit_ifd(out, ifd0, heap_offset, heap);
  emit_ifd(out, sub, heap_offset, heap);
  REQUIRE(out.size() == heap_offset);
  out.insert(out.end(), heap.begin(), heap.end());
  return out;
}

// A JPEG segment: 0xFF, the marker, then a big-endian length that counts itself.
std::vector<uint8_t> jpeg_segment(uint8_t marker, const std::vector<uint8_t>& payload) {
  std::vector<uint8_t> out = {0xFF, marker};
  const size_t length = payload.size() + 2;
  out.push_back(static_cast<uint8_t>(length >> 8U));
  out.push_back(static_cast<uint8_t>(length & 0xFFU));
  out.insert(out.end(), payload.begin(), payload.end());
  return out;
}

void splice_into_jpeg(const std::filesystem::path& path, uint8_t marker,
                      const std::vector<uint8_t>& payload) {
  std::vector<uint8_t> jpeg = read_bytes(path);
  REQUIRE(jpeg.size() > 2);
  const std::vector<uint8_t> segment = jpeg_segment(marker, payload);
  jpeg.insert(jpeg.begin() + 2, segment.begin(), segment.end());
  write_bytes(path, jpeg);
}

std::vector<uint8_t> exif_app1(uint16_t orientation) {
  std::vector<uint8_t> payload = {'E', 'x', 'i', 'f', 0, 0};
  const std::vector<uint8_t> block = exif_block(orientation);
  payload.insert(payload.end(), block.begin(), block.end());
  return payload;
}

std::vector<uint8_t> icc_app2(const std::vector<uint8_t>& profile) {
  std::vector<uint8_t> payload = {'I', 'C', 'C', '_', 'P', 'R', 'O', 'F', 'I', 'L', 'E', 0, 1, 1};
  payload.insert(payload.end(), profile.begin(), profile.end());
  return payload;
}

// The eXIf chunk goes straight after IHDR, which is always the first chunk: 8 bytes of
// signature plus a 25-byte IHDR.
void splice_exif_into_png(const std::filesystem::path& path, uint16_t orientation) {
  const std::vector<uint8_t> block = exif_block(orientation);
  // PNG counts in big-endian, TIFF in whatever its header said, so this is not put32.
  std::vector<uint8_t> chunk;
  const auto size = static_cast<uint32_t>(block.size());
  for (int shift = 24; shift >= 0; shift -= 8) {
    chunk.push_back(static_cast<uint8_t>((size >> shift) & 0xFFU));
  }
  const std::string type = "eXIf";
  chunk.insert(chunk.end(), type.begin(), type.end());
  chunk.insert(chunk.end(), block.begin(), block.end());
  const uLong sum =
      crc32(crc32(0, Z_NULL, 0), chunk.data() + 4, static_cast<uInt>(chunk.size() - 4));
  for (int shift = 24; shift >= 0; shift -= 8) {
    chunk.push_back(static_cast<uint8_t>((sum >> shift) & 0xFFU));
  }

  std::vector<uint8_t> png = read_bytes(path);
  REQUIRE(png.size() > 33);
  png.insert(png.begin() + 33, chunk.begin(), chunk.end());
  write_bytes(path, png);
}

// AdobeRGB: the same transfer function everywhere, wider red and green primaries. A file
// tagged with it and one that is not carry the same bytes and are not the same colour.
std::vector<uint8_t> adobe_rgb_profile() {
  cmsCIExyY white{0.3127, 0.3290, 1.0};
  cmsCIExyYTRIPLE primaries{{0.640, 0.330, 1.0}, {0.210, 0.710, 1.0}, {0.150, 0.060, 1.0}};
  cmsToneCurve* curve = cmsBuildGamma(nullptr, 563.0 / 256.0);
  REQUIRE(curve != nullptr);
  cmsToneCurve* curves[3] = {curve, curve, curve};
  cmsHPROFILE profile = cmsCreateRGBProfile(&white, &primaries, curves);
  cmsFreeToneCurve(curve);
  REQUIRE(profile != nullptr);

  cmsUInt32Number size = 0;
  REQUIRE(cmsSaveProfileToMem(profile, nullptr, &size) != 0);
  std::vector<uint8_t> bytes(size);
  REQUIRE(cmsSaveProfileToMem(profile, bytes.data(), &size) != 0);
  cmsCloseProfile(profile);
  bytes.resize(size);
  return bytes;
}

uint16_t channel_at(const DecodedRaw& image, uint32_t x, uint32_t y, size_t channel) {
  return image.rgba[(((static_cast<size_t>(y) * image.width) + x) * 4) + channel];
}

// 128/255 through the sRGB transfer function, scaled to the 16-bit buffer the pipeline uses.
constexpr uint16_t kMidGreyLinear = 14158;

}  // namespace

TEST_CASE("the importer claims png and jpeg and leaves everything else alone", "[import]") {
  CHECK(is_rendered_extension("/photos/a.png"));
  CHECK(is_rendered_extension("/photos/a.JPG"));
  CHECK(is_rendered_extension("/photos/a.jpeg"));
  CHECK_FALSE(is_rendered_extension("/photos/a.arw"));
  // A merged .tif is the engine's own output and is recognised by its sidecar, not here.
  CHECK_FALSE(is_rendered_extension("/photos/a.tif"));

  CHECK(is_photo_extension("/photos/a.png"));
  CHECK(is_photo_extension("/photos/a.ARW"));
  CHECK_FALSE(is_photo_extension("/photos/a.txt"));
}

TEST_CASE("a jpeg and a png of one colour land on the same linear value", "[import]") {
  const std::filesystem::path directory = scratch("parity");
  const Rgb8Image grey = flat_rgb(16, 8, 128, 128, 128);
  const std::filesystem::path jpeg = directory / "grey.jpg";
  const std::filesystem::path png = directory / "grey.png";
  write_jpeg(jpeg, grey);
  write_rgb_png(png.string(), grey);

  const DecodedRaw from_jpeg = decode_rendered_image(jpeg.string());
  const DecodedRaw from_png = decode_rendered_image(png.string());
  REQUIRE(from_jpeg.width == 16);
  REQUIRE(from_jpeg.height == 8);
  REQUIRE(from_png.width == 16);
  REQUIRE(from_png.height == 8);

  // Both land within half a percent of the true sRGB linearisation. They are not identical:
  // JPEG is lossy, and libpng's writer labels its output with a gAMA of 1/2.2 rather than an
  // sRGB chunk, so the importer honours a pure gamma of 2.2 for the PNG. That label is the
  // file telling the truth about itself, so following it is the correct read.
  constexpr uint16_t kTolerance = 400;
  for (size_t channel = 0; channel < 3; ++channel) {
    CHECK(std::abs(channel_at(from_jpeg, 4, 4, channel) - kMidGreyLinear) < kTolerance);
    CHECK(std::abs(channel_at(from_png, 4, 4, channel) - kMidGreyLinear) < kTolerance);
  }
  // Alpha is opaque whatever the source: the op-stack has nowhere to keep transparency.
  CHECK(channel_at(from_jpeg, 4, 4, 3) == 65535);
  CHECK(channel_at(from_png, 4, 4, 3) == 65535);
}

TEST_CASE("a 16-bit png keeps its depth and its gamma label", "[import]") {
  const std::filesystem::path directory = scratch("deep");
  // Three values a byte cannot hold apart: 1000 and 1001 would both be 3 at 8 bits.
  const std::vector<uint16_t> pixels = {1000, 1001, 40000, 1000, 1001, 40000};
  write_linear16_png(directory / "deep.png", 2, 1, pixels);

  const DecodedRaw decoded = decode_rendered_image((directory / "deep.png").string());
  REQUIRE(decoded.width == 2);
  REQUIRE(decoded.height == 1);
  // gAMA 1.0 means the samples are already linear, so the importer must not touch them.
  // lcms2 rounds, hence the slack — it is a handful of counts in 65535, not a curve.
  CHECK(std::abs(channel_at(decoded, 0, 0, 0) - 1000) <= 4);
  CHECK(std::abs(channel_at(decoded, 0, 0, 1) - 1001) <= 4);
  CHECK(std::abs(channel_at(decoded, 0, 0, 2) - 40000) <= 4);
  CHECK(channel_at(decoded, 0, 0, 0) != channel_at(decoded, 0, 0, 1));
}

TEST_CASE("a transparent png composites onto white", "[import]") {
  const std::filesystem::path directory = scratch("alpha");
  // Black at three alphas: opaque, half, and gone.
  const std::vector<uint8_t> pixels = {0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 0};
  write_rgba8_png(directory / "alpha.png", 3, 1, pixels);

  const DecodedRaw decoded = decode_rendered_image((directory / "alpha.png").string());
  REQUIRE(decoded.width == 3);
  CHECK(channel_at(decoded, 0, 0, 0) == 0);
  CHECK(channel_at(decoded, 2, 0, 0) == 65535);
  // Half alpha over white is half of white in linear light, whatever the pixel underneath.
  const uint16_t half = channel_at(decoded, 1, 0, 0);
  CHECK(half > 32000);
  CHECK(half < 33500);
  for (uint32_t x = 0; x < 3; ++x)
    CHECK(channel_at(decoded, x, 0, 3) == 65535);
}

TEST_CASE("libexif fills the catalog row a jpeg carries", "[import]") {
  const std::filesystem::path directory = scratch("exif-jpeg");
  const std::filesystem::path jpeg = directory / "shot.jpg";
  write_jpeg(jpeg, flat_rgb(40, 20, 90, 110, 130));
  splice_into_jpeg(jpeg, 0xE1, exif_app1(1));

  const RawMetadata row = read_rendered_metadata(jpeg.string());
  CHECK(row.width == 40);
  CHECK(row.height == 20);
  CHECK(row.camera == "Latent Fixture");
  CHECK(row.lens == "Latent 35mm F1.4");
  CHECK(row.captured_at == "2026-09-17T14:03:11");
  CHECK(row.shutter == "1/250");
  CHECK(row.iso == 400);
  CHECK(row.aperture > 2.79);
  CHECK(row.aperture < 2.81);
  CHECK(row.focal_length > 34.9);
  CHECK(row.focal_length < 35.1);
}

TEST_CASE("a png's eXIf chunk fills the same row", "[import]") {
  const std::filesystem::path directory = scratch("exif-png");
  const std::filesystem::path png = directory / "shot.png";
  write_rgb_png(png.string(), flat_rgb(24, 12, 90, 110, 130));
  splice_exif_into_png(png, 1);

  const RawMetadata row = read_rendered_metadata(png.string());
  CHECK(row.width == 24);
  CHECK(row.height == 12);
  CHECK(row.camera == "Latent Fixture");
  CHECK(row.shutter == "1/250");
  CHECK(row.iso == 400);
}

TEST_CASE("a png with no metadata still reports its size", "[import]") {
  const std::filesystem::path directory = scratch("bare");
  write_rgb_png((directory / "bare.png").string(), flat_rgb(7, 3, 10, 20, 30));

  const RawMetadata row = read_rendered_metadata((directory / "bare.png").string());
  CHECK(row.width == 7);
  CHECK(row.height == 3);
  CHECK(row.camera.empty());
  CHECK(row.captured_at.empty());
}

TEST_CASE("an embedded icc profile moves the colour, an absent one does not", "[import]") {
  const std::filesystem::path directory = scratch("icc");
  const Rgb8Image red = flat_rgb(8, 8, 200, 0, 0);
  const std::filesystem::path plain = directory / "srgb.jpg";
  const std::filesystem::path tagged = directory / "adobe.jpg";
  write_jpeg(plain, red);
  write_jpeg(tagged, red);
  splice_into_jpeg(tagged, 0xE2, icc_app2(adobe_rgb_profile()));

  const DecodedRaw from_srgb = decode_rendered_image(plain.string());
  const DecodedRaw from_adobe = decode_rendered_image(tagged.string());
  // AdobeRGB's red primary is outside sRGB's, so the same code value is a redder red. The
  // engine clips what will not fit, which is why this is a comparison and not an equality.
  CHECK(channel_at(from_adobe, 4, 4, 0) > channel_at(from_srgb, 4, 4, 0) + 2000);
}

TEST_CASE("exif orientation is baked into the pixels, not left for the viewer", "[import]") {
  const std::filesystem::path directory = scratch("orientation");
  const std::filesystem::path png = directory / "sideways.png";
  // Two columns, three rows, red channel = column, green = row: a rotation is read back out
  // of the pixels themselves. Lossless, so the labels survive the round trip exactly.
  Rgb8Image labelled;
  labelled.width = 2;
  labelled.height = 3;
  labelled.pixels.resize(2 * 3 * 3);
  for (uint32_t y = 0; y < 3; ++y) {
    for (uint32_t x = 0; x < 2; ++x) {
      const size_t at = ((static_cast<size_t>(y) * 2) + x) * 3;
      labelled.pixels[at] = static_cast<uint8_t>(x * 100);
      labelled.pixels[at + 1] = static_cast<uint8_t>(y * 100);
      labelled.pixels[at + 2] = 0;
    }
  }
  write_rgb_png(png.string(), labelled);
  splice_exif_into_png(png, 6);  // 90 degrees clockwise to display

  const RawMetadata row = read_rendered_metadata(png.string());
  CHECK(row.width == 3);
  CHECK(row.height == 2);

  const DecodedRaw decoded = decode_rendered_image(png.string());
  REQUIRE(decoded.width == 3);
  REQUIRE(decoded.height == 2);
  // 90 CW puts the source's left column across the top row, bottom to top: the green label
  // (the source row) counts down while the red label (the source column) stays at zero.
  CHECK(channel_at(decoded, 0, 0, 0) < channel_at(decoded, 0, 1, 0));
  CHECK(channel_at(decoded, 0, 0, 1) > channel_at(decoded, 1, 0, 1));
  CHECK(channel_at(decoded, 2, 0, 1) < channel_at(decoded, 0, 0, 1));
}

TEST_CASE("the thumbnail of a rendered photo comes back upright and fitted", "[import]") {
  const std::filesystem::path directory = scratch("preview");
  const std::filesystem::path jpeg = directory / "wide.jpg";
  write_jpeg(jpeg, flat_rgb(400, 200, 200, 100, 50));
  splice_into_jpeg(jpeg, 0xE1, exif_app1(6));

  const Rgb8Image preview = load_photo_preview(jpeg.string(), 100);
  CHECK(preview.height == 100);
  CHECK(preview.width == 50);
}

TEST_CASE("decode_jpeg_scaled shrinks during the decode and never enlarges", "[import]") {
  const std::vector<uint8_t> bytes = encode_jpeg(flat_rgb(800, 400, 60, 70, 80), 90);

  const Rgb8Image full = decode_jpeg_scaled(bytes, 0);
  CHECK(full.width == 800);

  // The smallest factor whose long edge still clears the floor.
  const Rgb8Image proxy = decode_jpeg_scaled(bytes, 300);
  CHECK(proxy.width < 800);
  CHECK(proxy.width >= 300);

  // An unreachable floor leaves the image alone rather than scaling it up.
  const Rgb8Image bigger = decode_jpeg_scaled(bytes, 2000);
  CHECK(bigger.width == 800);
  CHECK(bigger.height == 400);
}

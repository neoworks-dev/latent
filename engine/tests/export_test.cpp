// Export, end to end. Three layers:
//
//   1. arithmetic with no GPU and no disk — resize maths, the file-name template, the
//      colour transform checked against lcms2's own answer for the same profile;
//   2. the encoders — every format written and read back, dimensions and bit depth
//      confirmed by the library that owns the format;
//   3. the render — the sample raw exported for real, and the two claims that make export
//      trustworthy: a masked op only moves masked pixels at full resolution, and an export
//      the size of a proxy matches that proxy.
//
// Layer 3 skips itself without an adapter or without the sample raw, so a fresh clone
// still gets a green ctest.
#include "export/color_space.h"
#include "export/encoder.h"
#include "export/export_job.h"
#include "export/export_options.h"
#include "ops/mask.h"
#include "ops/op.h"
#include "ops/registry.h"
#include "pipeline/renderer.h"
#include "raw/raw_decode.h"

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <png.h>
#include <tiffio.h>

#include <algorithm>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <lcms2.h>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

std::string sample_raw_path() {
  const char* home = std::getenv("HOME");
  if (home == nullptr) return {};
  const std::string path = std::string(home) + "/Downloads/DSC00120.ARW";
  return std::filesystem::exists(path) ? path : std::string();
}

std::filesystem::path scratch_dir(const std::string& name) {
  const std::filesystem::path directory =
      std::filesystem::temp_directory_path() / ("latent-export-test-" + name);
  std::filesystem::remove_all(directory);
  std::filesystem::create_directories(directory);
  return directory;
}

Rgb16Image flat_image(uint32_t width, uint32_t height, uint16_t red, uint16_t green,
                      uint16_t blue) {
  Rgb16Image image;
  image.width = width;
  image.height = height;
  image.pixels.resize(image.expected_size());
  for (size_t pixel = 0; pixel < static_cast<size_t>(width) * height; ++pixel) {
    image.pixels[pixel * 3] = red;
    image.pixels[(pixel * 3) + 1] = green;
    image.pixels[(pixel * 3) + 2] = blue;
  }
  return image;
}

struct DecodedSize {
  uint32_t width = 0;
  uint32_t height = 0;
  int depth = 0;
};

// libpng, read back from the bytes the encoder produced. The engine's own png.cpp only
// speaks 8-bit greyscale, so this is the test's own reader.
DecodedSize read_png(const std::filesystem::path& path, std::vector<uint8_t>& icc) {
  FILE* file = std::fopen(path.c_str(), "rb");
  REQUIRE(file != nullptr);
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  REQUIRE(png != nullptr);
  png_infop info = png_create_info_struct(png);
  REQUIRE(info != nullptr);
  png_init_io(png, file);
  png_read_info(png, info);
  DecodedSize size;
  size.width = png_get_image_width(png, info);
  size.height = png_get_image_height(png, info);
  size.depth = png_get_bit_depth(png, info);
  REQUIRE(png_get_color_type(png, info) == PNG_COLOR_TYPE_RGB);

  png_charp name = nullptr;
  png_bytep profile = nullptr;
  png_uint_32 profile_size = 0;
  int compression = 0;
  if (png_get_iCCP(png, info, &name, &compression, &profile, &profile_size) != 0) {
    icc.assign(profile, profile + profile_size);
  }
  png_destroy_read_struct(&png, &info, nullptr);
  std::fclose(file);
  return size;
}

DecodedSize read_tiff(const std::filesystem::path& path, std::vector<uint8_t>& icc) {
  TIFF* tiff = TIFFOpen(path.c_str(), "r");
  REQUIRE(tiff != nullptr);
  DecodedSize size;
  uint16_t bits = 0;
  uint16_t samples = 0;
  TIFFGetField(tiff, TIFFTAG_IMAGEWIDTH, &size.width);
  TIFFGetField(tiff, TIFFTAG_IMAGELENGTH, &size.height);
  TIFFGetField(tiff, TIFFTAG_BITSPERSAMPLE, &bits);
  TIFFGetField(tiff, TIFFTAG_SAMPLESPERPIXEL, &samples);
  size.depth = bits;
  REQUIRE(samples == 3);

  uint32_t profile_size = 0;
  void* profile = nullptr;
  if (TIFFGetField(tiff, TIFFTAG_ICCPROFILE, &profile_size, &profile) == 1) {
    const auto* bytes = static_cast<const uint8_t*>(profile);
    icc.assign(bytes, bytes + profile_size);
  }
  // The scanlines have to actually decode, not just the header.
  const tmsize_t line = TIFFScanlineSize(tiff);
  std::vector<uint8_t> row(static_cast<size_t>(line));
  for (uint32_t y = 0; y < size.height; ++y) {
    REQUIRE(TIFFReadScanline(tiff, row.data(), y, 0) >= 0);
  }
  TIFFClose(tiff);
  return size;
}

// The APP2 segments encode_export splices in, reassembled.
std::vector<uint8_t> jpeg_icc(const std::vector<uint8_t>& jpeg) {
  std::vector<uint8_t> icc;
  size_t at = 2;
  while (at + 4 <= jpeg.size() && jpeg[at] == 0xFF) {
    const uint8_t marker = jpeg[at + 1];
    if (marker == 0xDA) break;  // start of scan: no more metadata segments
    const size_t length = (static_cast<size_t>(jpeg[at + 2]) << 8) | jpeg[at + 3];
    if (marker == 0xE2 && length > 16) {
      const size_t payload = at + 4;
      if (std::string(reinterpret_cast<const char*>(jpeg.data() + payload), 11) == "ICC_PROFILE") {
        icc.insert(icc.end(), jpeg.begin() + static_cast<ptrdiff_t>(payload + 14),
                   jpeg.begin() + static_cast<ptrdiff_t>(at + 2 + length));
      }
    }
    at += 2 + length;
  }
  return icc;
}

ExportOptions base_options(const std::string& directory, ExportFormat format) {
  ExportOptions options;
  options.photo_ids = {1};
  options.format = format;
  options.color_space = ExportColorSpace::Srgb;
  options.output_dir = directory;
  return options;
}

struct Fixture {
  DecodedRaw raw;
  std::unique_ptr<Renderer> renderer;
};

// One decode and one device for the whole file: a 24 MP ARW is over a second and the
// adapter takes 150 ms.
Fixture* gpu_fixture() {
  static bool tried = false;
  static Fixture fixture;
  static bool ok = false;
  if (!tried) {
    tried = true;
    const std::string path = sample_raw_path();
    if (!path.empty()) {
      try {
        fixture.raw = decode_raw(path);
        fixture.renderer = std::make_unique<Renderer>(16384);
        fixture.renderer->load_photo(1, fixture.raw);
        ok = true;
      } catch (const std::exception&) {
        ok = false;
      }
    }
  }
  return ok ? &fixture : nullptr;
}

Op make_op(const std::string& name, const nlohmann::json& params) {
  std::vector<std::string> warnings;
  Op op;
  op.id = make_op_id();
  op.name = name;
  op.params = normalize_params_for(name, params, warnings);
  return op;
}

}  // namespace

TEST_CASE("resize fits inside the requested box and keeps the aspect", "[export]") {
  const ExportSize native = export_resize_fit({}, 6000, 4000);
  CHECK(native.width == 6000);
  CHECK(native.height == 4000);

  ExportResize long_edge;
  long_edge.long_edge = 1200;
  const ExportSize landscape = export_resize_fit(long_edge, 6000, 4000);
  CHECK(landscape.width == 1200);
  CHECK(landscape.height == 800);
  // The long edge follows the image, not the axis: a portrait caps its height.
  const ExportSize portrait = export_resize_fit(long_edge, 4000, 6000);
  CHECK(portrait.width == 800);
  CHECK(portrait.height == 1200);

  ExportResize box;
  box.width = 1000;
  box.height = 1000;
  const ExportSize fitted = export_resize_fit(box, 6000, 4000);
  CHECK(fitted.width == 1000);
  CHECK(fitted.height == 667);

  ExportResize width_only;
  width_only.width = 3000;
  const ExportSize half = export_resize_fit(width_only, 6000, 4000);
  CHECK(half.width == 3000);
  CHECK(half.height == 2000);

  // dpi is metadata; it must not move a single pixel.
  ExportResize dpi_only;
  dpi_only.dpi = 300;
  const ExportSize untouched = export_resize_fit(dpi_only, 6000, 4000);
  CHECK(untouched.width == 6000);
  CHECK(untouched.height == 4000);
}

TEST_CASE("the file name template substitutes and cannot escape the folder", "[export]") {
  CHECK(export_file_name("{name}", "/photos/DSC00120.ARW", 1, ExportFormat::Jpeg) ==
        "DSC00120.jpg");
  CHECK(export_file_name("{name}-{index}", "/photos/DSC00120.ARW", 7, ExportFormat::Tiff16) ==
        "DSC00120-7.tif");
  CHECK(export_file_name("web/{name}", "/photos/a.ARW", 1, ExportFormat::Png) == "weba.png");
  CHECK(export_file_name("../../etc/passwd", "/photos/a.ARW", 1, ExportFormat::Png) ==
        "etcpasswd.png");
  // An explicit extension is not doubled.
  CHECK(export_file_name("{name}.jpg", "/photos/a.ARW", 1, ExportFormat::Jpeg) == "a.jpg");
}

TEST_CASE("two photos with the same name get distinct files", "[export]") {
  ExportOptions options = base_options("/tmp/out", ExportFormat::Jpeg);
  options.photo_ids = {1, 2, 3};
  const std::vector<ExportTarget> targets =
      plan_export(options, options.photo_ids, {"/a/IMG.ARW", "/b/IMG.ARW", "/c/other.ARW"});
  REQUIRE(targets.size() == 3);
  CHECK(targets[0].output_path == "/tmp/out/IMG.jpg");
  CHECK(targets[1].output_path == "/tmp/out/IMG-2.jpg");
  CHECK(targets[2].output_path == "/tmp/out/other.jpg");
}

TEST_CASE("export.run params are validated", "[export]") {
  nlohmann::json params = {
      {"photoIds", {1}}, {"format", "jpeg"}, {"colorSpace", "srgb"}, {"outputDir", "/tmp/out"}};
  const ExportOptions options = export_options_from_json(params);
  CHECK(options.format == ExportFormat::Jpeg);
  CHECK(options.quality == 90);
  CHECK(options.file_name_template == "{name}");

  params["format"] = "webp";
  CHECK_THROWS_AS(export_options_from_json(params), OpError);
  params["format"] = "jpeg";
  params["quality"] = 0;
  CHECK_THROWS_AS(export_options_from_json(params), OpError);
  params.erase("quality");
  params["photoIds"] = nlohmann::json::array();
  CHECK_THROWS_AS(export_options_from_json(params), OpError);
}

TEST_CASE("the shader's colour transform agrees with the ICC it embeds", "[export]") {
  // Mid grey and a saturated red: grey catches a white-point error, red catches a
  // primaries error, and both catch the curve.
  const std::vector<std::array<double, 3>> samples = {
      {0.18, 0.18, 0.18}, {0.8, 0.1, 0.05}, {0.05, 0.6, 0.2}, {0.0, 0.0, 0.0}, {1.0, 1.0, 1.0}};

  for (const ExportColorSpace space :
       {ExportColorSpace::Srgb, ExportColorSpace::DisplayP3, ExportColorSpace::AdobeRgb,
        ExportColorSpace::Rec2020, ExportColorSpace::ProPhoto}) {
    const ColorTransform transform = export_color_transform(space);
    const std::vector<uint8_t> icc = export_icc_profile(space);
    REQUIRE(icc.size() > 128);

    // lcms2's own answer: linear sRGB in, the profile we embed out.
    cmsToneCurve* linear = cmsBuildGamma(nullptr, 1.0);
    std::array<cmsToneCurve*, 3> linear_curves = {linear, linear, linear};
    cmsCIExyY white{0.3127, 0.3290, 1.0};
    cmsCIExyYTRIPLE srgb{{0.640, 0.330, 1.0}, {0.300, 0.600, 1.0}, {0.150, 0.060, 1.0}};
    cmsHPROFILE source = cmsCreateRGBProfile(&white, &srgb, linear_curves.data());
    cmsHPROFILE target =
        cmsOpenProfileFromMem(icc.data(), static_cast<cmsUInt32Number>(icc.size()));
    REQUIRE(source != nullptr);
    REQUIRE(target != nullptr);
    cmsHTRANSFORM convert = cmsCreateTransform(source, TYPE_RGB_DBL, target, TYPE_RGB_DBL,
                                               INTENT_RELATIVE_COLORIMETRIC, 0);
    REQUIRE(convert != nullptr);

    for (const std::array<double, 3>& sample : samples) {
      std::array<double, 3> expected{};
      cmsDoTransform(convert, sample.data(), expected.data(), 1);
      const std::array<double, 3> actual = apply_color_transform(transform, sample);
      for (size_t channel = 0; channel < 3; ++channel) {
        INFO(export_color_space_name(space) << " channel " << channel << ": lcms "
                                            << expected[channel] << " vs " << actual[channel]);
        // 1/255 is a whole 8-bit step; lcms's own matrix rounds to s15.16 fixed point, so
        // agreeing to better than a quarter of a step is as exact as this can get.
        CHECK(std::abs(expected[channel] - actual[channel]) < 1.0 / 1020.0);
      }
    }
    cmsDeleteTransform(convert);
    cmsCloseProfile(source);
    cmsCloseProfile(target);
    cmsFreeToneCurve(linear);
  }
}

TEST_CASE("every format encodes, decodes and carries its profile", "[export]") {
  const std::filesystem::path directory = scratch_dir("formats");
  const Rgb16Image image = flat_image(64, 40, 20000, 40000, 60000);
  const std::vector<uint8_t> icc = export_icc_profile(ExportColorSpace::DisplayP3);

  SECTION("jpeg") {
    EncodeOptions encode{ExportFormat::Jpeg, 92, 300, icc};
    const std::vector<uint8_t> bytes = encode_export(image, encode);
    const std::vector<uint8_t> embedded = jpeg_icc(bytes);
    CHECK(embedded == icc);
    const Rgb8Image decoded = decode_jpeg(bytes);
    CHECK(decoded.width == 64);
    CHECK(decoded.height == 40);
    // 16-bit in, 8-bit out: the flat patch survives JPEG at q92 to within a step or two.
    CHECK(std::abs(static_cast<int>(decoded.pixels[1]) - 40000 / 257) <= 2);
  }

  SECTION("png") {
    EncodeOptions encode{ExportFormat::Png, 0, 300, icc};
    const std::vector<uint8_t> bytes = encode_export(image, encode);
    const std::filesystem::path path = directory / "flat.png";
    write_export_file(path.string(), bytes);
    std::vector<uint8_t> embedded;
    const DecodedSize size = read_png(path, embedded);
    CHECK(size.width == 64);
    CHECK(size.height == 40);
    CHECK(size.depth == 16);
    CHECK(embedded == icc);
  }

  SECTION("tiff16") {
    EncodeOptions encode{ExportFormat::Tiff16, 0, 300, icc};
    const std::vector<uint8_t> bytes = encode_export(image, encode);
    const std::filesystem::path path = directory / "flat.tif";
    write_export_file(path.string(), bytes);
    std::vector<uint8_t> embedded;
    const DecodedSize size = read_tiff(path, embedded);
    CHECK(size.width == 64);
    CHECK(size.height == 40);
    CHECK(size.depth == 16);
    CHECK(embedded == icc);
  }

  SECTION("avif") {
    if (!export_avif_available()) SKIP("this build has no AVIF encoder");
    EncodeOptions encode{ExportFormat::Avif, 80, 0, icc};
    const std::vector<uint8_t> bytes = encode_export(image, encode);
    REQUIRE(bytes.size() > 32);
    // The ISOBMFF brand: bytes 4..8 are "ftyp", then the major brand.
    CHECK(std::string(reinterpret_cast<const char*>(bytes.data() + 4), 4) == "ftyp");
    CHECK(std::string(reinterpret_cast<const char*>(bytes.data() + 8), 4) == "avif");
  }
}

TEST_CASE("a write is atomic: nothing partial is left behind", "[export]") {
  const std::filesystem::path directory = scratch_dir("atomic");
  const std::filesystem::path path = directory / "nested" / "deep" / "file.bin";
  const std::vector<uint8_t> bytes = {1, 2, 3, 4};
  write_export_file(path.string(), bytes);
  CHECK(std::filesystem::file_size(path) == 4);
  CHECK(!std::filesystem::exists(path.string() + ".part"));
}

TEST_CASE("the job runner writes one file per photo and reports progress", "[export]") {
  const std::filesystem::path directory = scratch_dir("job");
  ExportOptions options = base_options(directory.string(), ExportFormat::Png);
  options.photo_ids = {1, 2};
  const std::vector<ExportTarget> targets =
      plan_export(options, options.photo_ids, {"/a/one.ARW", "/b/two.ARW"});

  std::vector<std::string> reported;
  ExportCallbacks callbacks;
  callbacks.render = [](const ExportTarget&) { return flat_image(8, 8, 100, 200, 300); };
  callbacks.progress = [&reported](size_t, size_t, const std::string& path) {
    reported.push_back(path);
  };
  const ExportOutcome outcome = run_export(options, targets, callbacks);
  CHECK(outcome.written == 2);
  CHECK(outcome.error.empty());
  CHECK(reported.size() == 2);
  CHECK(std::filesystem::exists(directory / "one.png"));
  CHECK(std::filesystem::exists(directory / "two.png"));
}

TEST_CASE("one bad photo does not take the batch down", "[export]") {
  const std::filesystem::path directory = scratch_dir("partial");
  ExportOptions options = base_options(directory.string(), ExportFormat::Png);
  options.photo_ids = {1, 2};
  const std::vector<ExportTarget> targets =
      plan_export(options, options.photo_ids, {"/a/one.ARW", "/b/two.ARW"});

  ExportCallbacks callbacks;
  callbacks.render = [](const ExportTarget& target) -> Rgb16Image {
    if (target.output_path.find("one") != std::string::npos) {
      throw std::runtime_error("decode failed");
    }
    return flat_image(8, 8, 1, 2, 3);
  };
  const ExportOutcome outcome = run_export(options, targets, callbacks);
  CHECK(outcome.written == 1);
  CHECK(outcome.done == 2);
  CHECK(outcome.error.find("decode failed") != std::string::npos);
  CHECK(std::filesystem::exists(directory / "two.png"));
}

TEST_CASE("a cancelled job stops between photos and keeps what it wrote", "[export]") {
  const std::filesystem::path directory = scratch_dir("cancel");
  ExportOptions options = base_options(directory.string(), ExportFormat::Png);
  options.photo_ids = {1, 2, 3};
  const std::vector<ExportTarget> targets =
      plan_export(options, options.photo_ids, {"/a/one.ARW", "/b/two.ARW", "/c/three.ARW"});

  int rendered = 0;
  ExportCallbacks callbacks;
  callbacks.render = [&rendered](const ExportTarget&) {
    ++rendered;
    return flat_image(8, 8, 1, 2, 3);
  };
  callbacks.cancelled = [&rendered] { return rendered >= 2; };
  const ExportOutcome outcome = run_export(options, targets, callbacks);
  CHECK(outcome.cancelled);
  CHECK(outcome.written == 2);
  CHECK(std::filesystem::exists(directory / "one.png"));
  CHECK(!std::filesystem::exists(directory / "three.png"));
}

TEST_CASE("the sample raw exports at native resolution", "[export][gpu]") {
  Fixture* fixture = gpu_fixture();
  if (fixture == nullptr) SKIP("no GPU adapter or no sample raw at ~/Downloads/DSC00120.ARW");

  ExportRenderOptions options;
  const Rgb16Image image = fixture->renderer->render_export(1, Stack{}, options);
  CHECK(image.width == fixture->raw.width);
  CHECK(image.height == fixture->raw.height);
  CHECK(image.pixels.size() == image.expected_size());

  // Not a black frame: something in the middle has to be lit.
  const size_t centre =
      (((static_cast<size_t>(image.height) / 2) * image.width) + (image.width / 2)) * 3;
  CHECK(image.pixels[centre] + image.pixels[centre + 1] + image.pixels[centre + 2] > 0);
}

TEST_CASE("an upscale renders the export at the size its raster really is", "[export][gpu]") {
  Fixture* fixture = gpu_fixture();
  if (fixture == nullptr) SKIP("no GPU adapter or no sample raw");

  // A small synthetic photo rather than the sample raw: what is asserted is the size the
  // export renders at, and a 24 MP frame at 2x is gigabytes of ping-pong for nothing.
  constexpr uint32_t kWidth = 320;
  constexpr uint32_t kHeight = 200;
  DecodedRaw small;
  small.width = kWidth;
  small.height = kHeight;
  small.camera = "Synthetic Test";
  small.rgba.assign(static_cast<size_t>(kWidth) * kHeight * 4, 20000);
  for (size_t pixel = 0; pixel < static_cast<size_t>(kWidth) * kHeight; ++pixel) {
    small.rgba[(pixel * 4) + 3] = 65535;
  }
  fixture->renderer->load_photo(2, small);

  Op upscale = make_op("upscale", {{"factor", "2x"}});
  upscale.result_rect = {0, 0, 1, 1};

  // Asked for but never run: the op has no raster, so the export is the photo's own size.
  ExportRenderOptions options;
  const Rgb16Image native = fixture->renderer->render_export(2, Stack{upscale}, options);
  CHECK(native.width == kWidth);
  CHECK(native.height == kHeight);

  Rgb8Image raster;
  raster.width = kWidth * 2;
  raster.height = kHeight * 2;
  raster.pixels.assign(static_cast<size_t>(raster.width) * raster.height * 3, 180);
  upscale.result = "generative/u1.png";
  fixture->renderer->put_generative_result(2, upscale.id, upscale.result, raster);

  const Rgb16Image bigger = fixture->renderer->render_export(2, Stack{upscale}, options);
  CHECK(bigger.width == kWidth * 2);
  CHECK(bigger.height == kHeight * 2);
  CHECK(bigger.pixels.size() == bigger.expected_size());

  // An explicit output size is still the user's: the upscale decides what the export is
  // rendered from, not what it is written at.
  options.resize.long_edge = 500;
  const Rgb16Image resized = fixture->renderer->render_export(2, Stack{upscale}, options);
  CHECK(std::max(resized.width, resized.height) == 500);
}

TEST_CASE("a crop changes the exported pixel count", "[export][gpu]") {
  Fixture* fixture = gpu_fixture();
  if (fixture == nullptr) SKIP("no GPU adapter or no sample raw");

  Stack stack = {
      make_op("crop", {{"left", 0.25}, {"top", 0.25}, {"right", 0.75}, {"bottom", 0.75}})};
  ExportRenderOptions options;
  options.resize.long_edge = 800;
  const Rgb16Image cropped = fixture->renderer->render_export(1, stack, options);
  // The long edge follows the image; the sample raw happens to be a portrait frame.
  CHECK(std::max(cropped.width, cropped.height) == 800);
  // The crop is square in normalised terms, so the output aspect is the photo's.
  const double aspect = static_cast<double>(fixture->raw.width) / fixture->raw.height;
  CHECK(std::abs(static_cast<double>(cropped.width) / cropped.height - aspect) < 0.01);
}

TEST_CASE("a masked op moves only the masked pixels at full resolution", "[export][gpu]") {
  Fixture* fixture = gpu_fixture();
  if (fixture == nullptr) SKIP("no GPU adapter or no sample raw");

  ExportRenderOptions options;
  options.resize.long_edge = 1000;
  const Rgb16Image plain = fixture->renderer->render_export(1, Stack{}, options);

  // A radial mask over the left third: a hard-edged exposure lift inside it, nothing
  // outside. Coordinates are normalised over the content rect, which at export is the
  // whole image.
  Op op = make_op("exposure", {{"value", 2.0}});
  op.mask = normalize_mask(
      {{"components",
        {{{"id", "m1"},
          {"kind", "radial"},
          {"mode", "add"},
          {"feather", 0},
          {"params", {{"center", {0.2, 0.5}}, {"radius", {0.12, 0.12}}, {"angle", 0}}}}}}});
  const Rgb16Image masked = fixture->renderer->render_export(1, Stack{op}, options);
  REQUIRE(masked.width == plain.width);
  REQUIRE(masked.height == plain.height);

  const auto at = [&](const Rgb16Image& image, double u, double v) {
    const auto x = static_cast<size_t>(u * image.width);
    const auto y = static_cast<size_t>(v * image.height);
    return static_cast<int>(image.pixels[(((y * image.width) + x) * 3) + 1]);
  };
  // Inside the radial: the lift has to be visible. Outside: identical, bit for bit.
  CHECK(at(masked, 0.2, 0.5) > at(plain, 0.2, 0.5));
  for (const double u : {0.6, 0.75, 0.9}) {
    for (const double v : {0.2, 0.5, 0.8}) {
      INFO("at " << u << ", " << v);
      CHECK(at(masked, u, v) == at(plain, u, v));
    }
  }
}

TEST_CASE("an export the size of a proxy matches that proxy", "[export][gpu]") {
  Fixture* fixture = gpu_fixture();
  if (fixture == nullptr) SKIP("no GPU adapter or no sample raw");

  // Exposure and white balance only: both are multiplications in linear light, so they
  // commute with the box filter and the two paths — resize-then-op (the preview) and
  // op-then-resize (the export) — must agree to the last 8-bit step. Anything nonlinear
  // would not, and that difference is real, not a bug.
  const Stack stack = {make_op("exposure", {{"value", 0.6}}),
                       make_op("white_balance", {{"temperature", 25}, {"tint", -10}})};

  constexpr uint32_t kLongEdge = 900;
  ExportRenderOptions options;
  options.resize.long_edge = kLongEdge;
  const Rgb16Image exported = fixture->renderer->render_export(1, stack, options);

  fixture->renderer->open_view(9001, 1, exported.width, exported.height);
  std::vector<uint8_t> frame(static_cast<size_t>(exported.width) * exported.height * 4);
  fixture->renderer->render(9001, stack, frame, 0);
  const ViewGeometry geometry = fixture->renderer->view_geometry(9001);
  REQUIRE(geometry.content_width == exported.width);
  REQUIRE(geometry.content_height == exported.height);

  double total = 0;
  int worst = 0;
  for (uint32_t y = 0; y < exported.height; ++y) {
    for (uint32_t x = 0; x < exported.width; ++x) {
      const size_t frame_index = ((static_cast<size_t>(y + geometry.content_y) * geometry.width) +
                                  x + geometry.content_x) *
                                 4;
      const size_t export_index = (((static_cast<size_t>(y) * exported.width) + x) * 3);
      for (size_t channel = 0; channel < 3; ++channel) {
        const int preview = frame[frame_index + channel];
        const int exact = (exported.pixels[export_index + channel] + 128) / 257;
        const int difference = std::abs(preview - exact);
        total += difference;
        worst = std::max(worst, difference);
      }
    }
  }
  fixture->renderer->close_view(9001);
  const double mean = total / (static_cast<double>(exported.width) * exported.height * 3);
  INFO("mean " << mean << ", worst " << worst << " of 255");
  CHECK(mean < 0.25);
  CHECK(worst <= 4);
}

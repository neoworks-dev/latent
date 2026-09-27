// The parts of engine/src/ai that can be checked without a GPU, a 1.8 GB model store or a
// network: the resampler and normaliser every model shares, the byte-level BPE that
// replaces a tokenizer dependency, and the routing table that decides which model a mask
// kind reaches. The two tests that do want the store detect it and skip when it is absent,
// so ctest stays green on a machine that has never run scripts/models/fetch.py.
#include "ai/bpe_tokenizer.h"
#include "ai/denoise.h"
#include "ai/florence2.h"
#include "ai/mask_detect.h"
#include "ai/model_store.h"
#include "ai/preprocess.h"
#include "ai/trails.h"

#include <cmath>
#include <cstdlib>

#include <algorithm>
#include <array>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

Rgb8Image solid(uint32_t width, uint32_t height, uint8_t red, uint8_t green, uint8_t blue) {
  Rgb8Image image;
  image.width = width;
  image.height = height;
  image.pixels.reserve(static_cast<size_t>(width) * height * 3);
  for (size_t i = 0; i < static_cast<size_t>(width) * height; ++i) {
    image.pixels.push_back(red);
    image.pixels.push_back(green);
    image.pixels.push_back(blue);
  }
  return image;
}

// Swaps the model store for the duration of a test and puts the old one back.
class StoreOverride {
 public:
  explicit StoreOverride(const std::string& root) {
    const char* previous = std::getenv("LATENT_MODEL_STORE");
    if (previous != nullptr) {
      had_previous_ = true;
      previous_ = previous;
    }
    setenv("LATENT_MODEL_STORE", root.c_str(), 1);
  }
  ~StoreOverride() {
    if (had_previous_) {
      setenv("LATENT_MODEL_STORE", previous_.c_str(), 1);
    } else {
      unsetenv("LATENT_MODEL_STORE");
    }
  }
  StoreOverride(const StoreOverride&) = delete;
  StoreOverride& operator=(const StoreOverride&) = delete;

 private:
  bool had_previous_ = false;
  std::string previous_;
};

MaskDetectResult detect_kind(MaskDetector& detector, MaskKind kind, nlohmann::json params) {
  MaskDetectRequest request;
  request.kind = kind;
  request.params = params.is_object() ? std::move(params) : nlohmann::json::object();
  request.image = solid(16, 12, 40, 80, 120);
  return detector.detect(request);
}

}  // namespace

TEST_CASE("preprocess normalises and squashes to a square", "[ai]") {
  // One flat colour: the resize cannot change it, so only the normalisation is under test.
  const std::vector<float> tensor =
      preprocess_square(solid(2, 2, 0, 128, 255), 2, kImageNetMean, kImageNetStd, Filter::Bilinear);
  REQUIRE(tensor.size() == 2 * 2 * 3);
  const float red = (0.0F - 0.485F) / 0.229F;
  const float green = ((128.0F / 255.0F) - 0.456F) / 0.224F;
  const float blue = (1.0F - 0.406F) / 0.225F;
  for (size_t i = 0; i < 4; ++i) {
    CHECK(tensor[i] == Catch::Approx(red).epsilon(1e-5));
    CHECK(tensor[4 + i] == Catch::Approx(green).epsilon(1e-5));
    CHECK(tensor[8 + i] == Catch::Approx(blue).epsilon(1e-5));
  }
}

TEST_CASE("the resampler follows PIL's convention", "[ai]") {
  const std::vector<float> quad{0.0F, 100.0F, 200.0F, 40.0F};

  SECTION("downscaling averages, because the filter support grows with the ratio") {
    const std::vector<float> one = resample_plane(quad, 2, 2, 1, 1, Filter::Bilinear);
    REQUIRE(one.size() == 1);
    CHECK(one[0] == Catch::Approx(85.0F).epsilon(1e-5));
  }

  SECTION("upscaling is plain bilinear with align_corners=False") {
    const std::vector<float> wide = resample_plane(quad, 2, 2, 4, 2, Filter::Bilinear);
    REQUIRE(wide.size() == 8);
    // Output centres land at 0.25, 0.75, 1.25 and 1.75 source pixels.
    CHECK(wide[0] == Catch::Approx(0.0F));
    CHECK(wide[1] == Catch::Approx(25.0F).epsilon(1e-5));
    CHECK(wide[2] == Catch::Approx(75.0F).epsilon(1e-5));
    CHECK(wide[3] == Catch::Approx(100.0F));
  }

  SECTION("an unchanged size is a copy, not a filter pass") {
    CHECK(resample_plane(quad, 2, 2, 2, 2, Filter::Bilinear) == quad);
  }
}

TEST_CASE("a 0..1 plane becomes an r8 raster", "[ai]") {
  const std::vector<float> plane{-0.5F, 0.0F, 0.5F, 1.5F};
  const GrayImage raster = plane_to_gray(plane, 4, 1);
  REQUIRE(raster.width == 4);
  REQUIRE(raster.height == 1);
  CHECK(raster.pixels == std::vector<uint8_t>{0, 0, 128, 255});
}

TEST_CASE("mask.detect routes every kind to the model that owns it", "[ai]") {
  // An empty store makes each kind report the model it wanted, which is the routing table
  // observed from outside — no GPU, no weights, no inference.
  const std::string empty = std::string(LATENT_TEST_FIXTURES) + "/empty-model-store";
  StoreOverride override_store(empty);
  const std::unique_ptr<MaskDetector> detector = make_mask_detector();
  REQUIRE(detector->name() == "onnxruntime");

  const nlohmann::json box = {{"box", {0.2, 0.2, 0.8, 0.8}}};
  CHECK(detect_kind(*detector, MaskKind::Objects, box).message ==
        "model sam2-hiera-base-plus not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Text, {{"prompt", "the hat"}}).message ==
        "model florence-2-base not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Subject, {}).message ==
        "model birefnet-lite not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Background, {}).message ==
        "model birefnet-lite not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Sky, {}).message ==
        "model segformer-b2-ade20k not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::People, {}).message ==
        "model segformer-b2-ade20k not installed (run scripts/models/fetch.py)");

  // Depth is the odd one: the raster it caches is the scene's depth map rather than a
  // selection, and the band that turns it into one is a shader pass (ops/mask.cpp).
  CHECK(detect_kind(*detector, MaskKind::Depth, {}).message ==
        "model depth-anything-v2-small not installed (run scripts/models/fetch.py)");
  // A parametric kind never reaches a model at all.
  CHECK(detect_kind(*detector, MaskKind::Brush, {}).message ==
        "mask kind 'brush' rasterises inline, not through a model");

  for (MaskKind kind :
       {MaskKind::Objects, MaskKind::Text, MaskKind::Subject, MaskKind::Sky, MaskKind::Depth}) {
    CHECK_FALSE(detect_kind(*detector, kind, box).ok);
  }
}

TEST_CASE("an objects mask without a hint says so instead of guessing", "[ai]") {
  if (!model_installed(kSam2Model)) {
    WARN("sam2-hiera-base-plus is not in the model store; skipping the empty-hint check");
    return;
  }
  const std::unique_ptr<MaskDetector> detector = make_mask_detector();
  const MaskDetectResult result = detect_kind(*detector, MaskKind::Objects, {});
  CHECK_FALSE(result.ok);
  CHECK(result.message == "an objects mask needs a box or a point to start from");
}

TEST_CASE("Florence-2's <loc_###> bins de-quantise to pixels", "[ai]") {
  // 1000 bins per axis, bin centre, truncated: scripts/models/florence2.py.
  const DetectionBox box = dequantize_box({0, 500, 999, 1000}, 1000, 2000);
  CHECK(box[0] == Catch::Approx(0.0F));
  CHECK(box[1] == Catch::Approx(1001.0F));
  CHECK(box[2] == Catch::Approx(999.0F));
  CHECK(box[3] == Catch::Approx(2001.0F));

  const std::vector<DetectionBox> boxes =
      parse_boxes("</s><s>the person<loc_401><loc_232><loc_741><loc_854></s>", 1000, 1000);
  REQUIRE(boxes.size() == 1);
  CHECK(boxes[0][0] == Catch::Approx(401.0F));
  CHECK(boxes[0][3] == Catch::Approx(854.0F));
  CHECK(parse_boxes("</s><s>a hat</s>", 100, 100).empty());
}

TEST_CASE("LATENT_MASK_STUB=1 still selects the shape generator", "[ai]") {
  setenv("LATENT_MASK_STUB", "1", 1);
  const std::unique_ptr<MaskDetector> detector = make_mask_detector();
  unsetenv("LATENT_MASK_STUB");
  CHECK(detector->name() == "stub-shapes");
  const MaskDetectResult result = detect_kind(*detector, MaskKind::Subject, {});
  CHECK(result.ok);
  CHECK(result.model == "stub-shapes");
}

TEST_CASE("the byte-level BPE agrees with the Python tokenizer", "[ai]") {
  if (!model_installed(kFlorenceModel)) {
    WARN("florence-2-base is not in the model store; skipping the tokenizer comparison");
    return;
  }
  const std::string fixture_path = std::string(LATENT_TEST_FIXTURES) + "/florence-tokenizer.json";
  std::ifstream fixture(fixture_path);
  REQUIRE(fixture.good());
  const nlohmann::json cases = nlohmann::json::parse(fixture)["cases"];
  REQUIRE(cases.size() >= 10);

  const BpeTokenizer tokenizer = BpeTokenizer::from_directory(model_dir(kFlorenceModel));
  for (const nlohmann::json& entry : cases) {
    const auto text = entry["text"].get<std::string>();
    const auto expected = entry["ids"].get<std::vector<int64_t>>();
    INFO("prompt: " << text);
    CHECK(tokenizer.encode(text) == expected);
  }
}

TEST_CASE("decoding keeps the <loc_###> tokens the box parser needs", "[ai]") {
  if (!model_installed(kFlorenceModel)) {
    WARN("florence-2-base is not in the model store; skipping the decode check");
    return;
  }
  const BpeTokenizer tokenizer = BpeTokenizer::from_directory(model_dir(kFlorenceModel));
  const std::vector<int64_t> ids = tokenizer.encode("the hat");
  CHECK(tokenizer.decode(ids) == "the hat");
  // 50269 is <loc_0>; the bins are added tokens, not merges, so they survive verbatim.
  CHECK(tokenizer.decode(std::vector<int64_t>{50269, 50270}) == "<loc_0><loc_1>");
}

// ---- trails -------------------------------------------------------------------------
// A synthetic night frame: a dim sky with a few hundred stars in it, two aircraft trails —
// one solid, one dashed the way a strobe dashes them — and one streak too short to be
// either. The detector is given a box around the first trail and has to find the second
// without finding the stars.
namespace {

constexpr uint32_t kSkyWidth = 512;
constexpr uint32_t kSkyHeight = 384;

void put_pixel(Rgb8Image& image, int x, int y, double value) {
  if (x < 0 || y < 0 || x >= static_cast<int>(image.width) || y >= static_cast<int>(image.height)) {
    return;
  }
  const size_t index = ((static_cast<size_t>(y) * image.width) + x) * 3;
  const auto level = static_cast<uint8_t>(std::min(255.0, std::max(0.0, value)));
  for (size_t channel = 0; channel < 3; ++channel) {
    image.pixels[index + channel] = std::max(image.pixels[index + channel], level);
  }
}

void draw_dot(Rgb8Image& image, double x, double y, double peak, double radius) {
  const auto reach = static_cast<int>(std::ceil(radius * 2));
  for (int dy = -reach; dy <= reach; ++dy) {
    for (int dx = -reach; dx <= reach; ++dx) {
      const double distance = std::hypot(dx, dy);
      put_pixel(image, static_cast<int>(std::lround(x)) + dx, static_cast<int>(std::lround(y)) + dy,
                peak * std::exp(-(distance * distance) / (2 * radius * radius)));
    }
  }
}

// `duty` < 1 leaves the strobe's gaps: `period` pixels on, the rest off.
void draw_streak(Rgb8Image& image, double x0, double y0, double x1, double y1, double peak,
                 double width, double period = 0, double duty = 1) {
  const double length = std::hypot(x1 - x0, y1 - y0);
  for (double t = 0; t <= length; t += 0.5) {
    if (period > 0 && std::fmod(t, period) > period * duty) continue;
    const double fraction = t / length;
    draw_dot(image, x0 + (fraction * (x1 - x0)), y0 + (fraction * (y1 - y0)), peak, width);
  }
}

uint32_t hash_pixel(uint32_t state) {
  state = (state ^ (state >> 13)) * 1274126177U;
  return state ^ (state >> 16);
}

Rgb8Image night_sky() {
  Rgb8Image image = solid(kSkyWidth, kSkyHeight, 10, 11, 14);
  for (size_t i = 0; i < static_cast<size_t>(kSkyWidth) * kSkyHeight; ++i) {
    const uint32_t noise = hash_pixel(static_cast<uint32_t>(i)) % 7;
    for (size_t channel = 0; channel < 3; ++channel) {
      image.pixels[(i * 3) + channel] =
          static_cast<uint8_t>(image.pixels[(i * 3) + channel] + noise);
    }
  }
  for (uint32_t star = 0; star < 400; ++star) {
    const uint32_t x = hash_pixel(star * 3 + 1) % kSkyWidth;
    const uint32_t y = hash_pixel(star * 3 + 2) % kSkyHeight;
    const double peak = 90 + (hash_pixel(star * 3 + 3) % 150);
    draw_dot(image, x, y, peak, 0.9);
  }
  return image;
}

// The seed trail, the dashed one, and a streak below any sane minimum length.
struct SkyFixture {
  Rgb8Image image;
  TrailParams params;
};

SkyFixture night_sky_with_trails() {
  SkyFixture fixture;
  fixture.image = night_sky();
  draw_streak(fixture.image, 40, 70, 250, 130, 200, 1.1);
  draw_streak(fixture.image, 300, 330, 480, 180, 180, 1.1, 24, 0.6);
  draw_streak(fixture.image, 120, 300, 150, 318, 190, 1.1);

  // The gesture: a stroke drawn along the first trail, by a hand that is a few pixels off
  // it in places — which is what a hand does.
  for (const std::array<double, 2>& point :
       {std::array<double, 2>{52, 75}, {120, 94}, {188, 113}, {242, 128}}) {
    fixture.params.seed.push_back({point[0] / kSkyWidth, point[1] / kSkyHeight});
  }
  return fixture;
}

double raster_at(const GrayImage& raster, double x, double y) {
  const auto px = static_cast<uint32_t>(std::lround(x));
  const auto py = static_cast<uint32_t>(std::lround(y));
  if (px >= raster.width || py >= raster.height) return 0;
  return raster.pixels[(static_cast<size_t>(py) * raster.width) + px];
}

}  // namespace

TEST_CASE("one boxed trail finds the other trails in the frame", "[ai][trails]") {
  const SkyFixture fixture = night_sky_with_trails();
  const TrailDetection detection = find_trails(fixture.image, fixture.params);
  REQUIRE(detection.ok);
  REQUIRE(detection.segments.size() >= 2);
  REQUIRE(detection.segments.front().seed);

  // Both trails are in the mask, along their whole length.
  CHECK(raster_at(detection.raster, 145, 100) > 200);
  CHECK(raster_at(detection.raster, 240, 127) > 200);
  CHECK(raster_at(detection.raster, 390, 255) > 200);
  CHECK(raster_at(detection.raster, 470, 188) > 200);
  // Including where the strobe was dark: the gap is bridged, which is the point of
  // detecting a line rather than thresholding the pixels.
  CHECK(raster_at(detection.raster, 336, 300) > 200);

  // The short streak is under the default minimum length and stays out.
  CHECK(raster_at(detection.raster, 135, 309) < 32);

  // And it is a line, not a band: a trail is two or three pixels wide, so ten pixels off it
  // is sky and has to stay sky. A fat mask is a fat repaint, and over a gradient that reads
  // as a smear where the trail was.
  CHECK(raster_at(detection.raster, 145, 90) < 32);
  CHECK(raster_at(detection.raster, 145, 110) < 32);
}

TEST_CASE("a field of stars is not a trail", "[ai][trails]") {
  const SkyFixture fixture = night_sky_with_trails();
  const TrailDetection detection = find_trails(fixture.image, fixture.params);
  REQUIRE(detection.ok);

  // Whatever the detector selected, it is thin: two trails a few pixels wide (plus the
  // default `grow`) over a frame full of stars cannot add up to a large share of it.
  size_t selected = 0;
  for (uint8_t pixel : detection.raster.pixels) {
    if (pixel > 127) ++selected;
  }
  CHECK(selected > 0);
  CHECK(static_cast<double>(selected) / static_cast<double>(detection.raster.pixels.size()) < 0.02);
  CHECK(detection.segments.size() < 8);
}

TEST_CASE("grow widens the mask without moving it", "[ai][trails]") {
  SkyFixture fixture = night_sky_with_trails();
  fixture.params.grow = 0;
  const TrailDetection tight = find_trails(fixture.image, fixture.params);
  fixture.params.grow = 100;
  const TrailDetection wide = find_trails(fixture.image, fixture.params);
  REQUIRE(tight.ok);
  REQUIRE(wide.ok);

  size_t tight_pixels = 0;
  size_t wide_pixels = 0;
  for (size_t i = 0; i < tight.raster.pixels.size(); ++i) {
    if (tight.raster.pixels[i] > 127) ++tight_pixels;
    if (wide.raster.pixels[i] > 127) ++wide_pixels;
  }
  CHECK(wide_pixels > tight_pixels * 2);
  // The trail is still where it was; `grow` is margin for a removal, not a second search.
  CHECK(raster_at(wide.raster, 145, 100) > 200);
}

TEST_CASE("a trails mask says what it needs", "[ai][trails]") {
  const SkyFixture fixture = night_sky_with_trails();

  TrailParams without;
  const TrailDetection unseeded = find_trails(fixture.image, without);
  CHECK_FALSE(unseeded.ok);
  CHECK(unseeded.message.find("stroke") != std::string::npos);

  // A tap is not a stroke: one point says where, but not which way.
  TrailParams tapped;
  tapped.seed.push_back({0.4, 0.4});
  CHECK_FALSE(find_trails(fixture.image, tapped).ok);

  // A stroke across a star is a stroke across a point, and the detector says so rather
  // than selecting every star in the frame.
  TrailParams round;
  Rgb8Image lone = solid(kSkyWidth, kSkyHeight, 10, 11, 14);
  draw_dot(lone, 120, 90, 220, 2.0);
  round.seed.push_back({116.0 / kSkyWidth, 86.0 / kSkyHeight});
  round.seed.push_back({124.0 / kSkyWidth, 94.0 / kSkyHeight});
  const TrailDetection blob = find_trails(lone, round);
  CHECK_FALSE(blob.ok);
  CHECK(blob.message.find("round") != std::string::npos);
}

TEST_CASE("the trails params round-trip through the component", "[ai][trails]") {
  const nlohmann::json params = nlohmann::json::parse(
      R"({"seed": [[0.2, 0.1], [0.6, 0.4]], "sensitivity": 70, "minLength": 25, "grow": 5})");
  const TrailParams parsed = trail_params_from_json(params);
  REQUIRE(parsed.seed.size() == 2);
  CHECK(parsed.seed[0][0] == 0.2);
  CHECK(parsed.seed[0][1] == 0.1);
  CHECK(parsed.seed[1][0] == 0.6);
  CHECK(parsed.seed[1][1] == 0.4);
  CHECK(parsed.sensitivity == 70);
  CHECK(parsed.min_length == 25);

  // A point that is not a pair is not a point; the rest of the stroke still stands.
  const TrailParams messy = trail_params_from_json(
      nlohmann::json::parse(R"({"seed": [[0.2, 0.1], [0.6], "x", [0.4, 0.5]]})"));
  CHECK(messy.seed.size() == 2);
}

// The local denoise model (issue #51). Everything here is about the *tiling*, which is
// the engine's half of the job: the model itself was measured in scripts/models/README.md.
TEST_CASE("the local denoise cleans a frame without leaving a tile edge in it", "[ai]") {
  if (!model_installed(kDenoiseModel)) {
    WARN("scunet-color-real is not in the model store; skipping the denoise check");
    return;
  }
  // Deliberately smaller than one tile in one axis and larger in the other, so the run
  // covers both paths: mirrored padding on the short side, two overlapping tiles on the
  // long one.
  constexpr uint32_t kWidth = 700;
  constexpr uint32_t kHeight = 300;
  Rgb8Image noisy;
  noisy.width = kWidth;
  noisy.height = kHeight;
  noisy.pixels.resize(static_cast<size_t>(kWidth) * kHeight * 3);
  for (uint32_t y = 0; y < kHeight; ++y) {
    for (uint32_t x = 0; x < kWidth; ++x) {
      const double level = y < kHeight / 2 ? 60.0 : 150.0;
      const double grain =
          (std::fmod(std::abs(std::sin((x * 12.9898) + (y * 78.233)) * 43758.5453), 1.0) - 0.5) *
          40.0;
      const size_t at = (((static_cast<size_t>(y) * kWidth) + x) * 3);
      for (size_t channel = 0; channel < 3; ++channel) {
        noisy.pixels[at + channel] = static_cast<uint8_t>(std::clamp(level + grain, 0.0, 255.0));
      }
    }
  }

  ScuNet model(model_dir(kDenoiseModel));
  double seen = 0;
  const std::optional<Rgb8Image> cleaned = model.denoise(noisy, [&](double fraction) {
    seen = fraction;
    return true;
  });
  REQUIRE(cleaned.has_value());
  CHECK(cleaned->width == kWidth);
  CHECK(cleaned->height == kHeight);
  CHECK(seen == Catch::Approx(1.0));

  // Mean absolute neighbour difference over one band of rows: what noise is left there.
  const auto roughness = [&](const Rgb8Image& image, uint32_t from, uint32_t to) {
    double sum = 0;
    double count = 0;
    for (uint32_t y = from; y < to; ++y) {
      for (uint32_t x = 1; x + 1 < image.width; ++x) {
        const size_t at = (((static_cast<size_t>(y) * image.width) + x) * 3);
        sum += std::abs(static_cast<double>(image.pixels[at]) - image.pixels[at + 3]);
        count += 1;
      }
    }
    return count > 0 ? sum / count : 0.0;
  };

  const double before = roughness(noisy, 20, 120);
  const double after = roughness(*cleaned, 20, 120);
  INFO("roughness " << before << " -> " << after);
  CHECK(after < before * 0.2);

  // The tile seam and the mirrored edge are the two places a tiled run goes wrong, and both
  // of them show up as a band that is rougher than the middle of the frame. A tolerance
  // rather than equality: these rows are also where the model has the least context.
  const double middle = roughness(*cleaned, 130, 170);
  const double bottom = roughness(*cleaned, kHeight - 30, kHeight);
  INFO("middle " << middle << ", bottom " << bottom);
  CHECK(bottom < std::max(middle * 3.0, 1.0));

  // A cancel in the middle of the tiles is a cancel, not a half-denoised frame.
  const std::optional<Rgb8Image> stopped = model.denoise(noisy, [](double) { return false; });
  CHECK_FALSE(stopped.has_value());
}

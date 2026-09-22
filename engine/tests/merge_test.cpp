// Photo Merge, on fixtures the test generates: a synthetic radiance field rendered at
// three exposures with clipping at both ends, a shifted copy of it, a moved patch, and two
// overlapping crops of a texture. Nothing is read from disk except the TIFF this file
// writes itself, so the suite runs on a machine with no raws and no GPU.
#include "merge/merge.h"

#include "merge/align.h"
#include "merge/frame_info.h"
#include "merge/hdr.h"
#include "merge/pano.h"
#include "merge/source_image.h"
#include "merge/startrail.h"

#include <cmath>

#include <algorithm>
#include <filesystem>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

using namespace latent;

namespace {

// Deterministic value noise. Hash-based rather than a sum of sines: a sine field repeats,
// and a repeating scene gives an alignment search several equally good answers, which is
// a property of the fixture and not of the algorithm under test.
double hash_at(int64_t x, int64_t y) {
  auto state = static_cast<uint32_t>(x * 374761393 + y * 668265263);
  state = (state ^ (state >> 13)) * 1274126177U;
  return static_cast<double>((state ^ (state >> 16)) & 0xFFFFFF) / 0xFFFFFF;
}

double smooth_noise(double x, double y, double cell) {
  const double fx = x / cell;
  const double fy = y / cell;
  const auto x0 = static_cast<int64_t>(std::floor(fx));
  const auto y0 = static_cast<int64_t>(std::floor(fy));
  const double rx = fx - static_cast<double>(x0);
  const double ry = fy - static_cast<double>(y0);
  const double tx = rx * rx * (3 - 2 * rx);
  const double ty = ry * ry * (3 - 2 * ry);
  const double top = std::lerp(hash_at(x0, y0), hash_at(x0 + 1, y0), tx);
  const double bottom = std::lerp(hash_at(x0, y0 + 1), hash_at(x0 + 1, y0 + 1), tx);
  return std::lerp(top, bottom, ty);
}

// Four octaves in [0,1]. The coarsest cell is 48 px, so the coarsest pyramid level still
// has something to match on.
double octaves_at(double x, double y) {
  double sum = 0;
  double total = 0;
  double amplitude = 1;
  for (double cell : {48.0, 24.0, 12.0, 6.0}) {
    sum += amplitude * smooth_noise(x, y, cell);
    total += amplitude;
    amplitude *= 0.5;
  }
  return sum / total;
}

float texture_at(double x, double y) {
  return static_cast<float>(octaves_at(x, y));
}

// Scene radiance in [0.02, 1.85]: mostly mid and low, with scattered bright patches — the
// shape of a real scene worth bracketing. The top of the range is above the middle
// exposure's white level, so that frame clips there, and below the darkest one's, so the
// bracket as a whole still holds every highlight.
LinearImage radiance_field(uint32_t width, uint32_t height) {
  LinearImage image = make_linear(width, height);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const double shaped = std::pow(octaves_at(x, y), 3.0);
      const double level = 0.02 + 1.83 * shaped;
      float* pixel = image.at(x, y);
      pixel[0] = static_cast<float>(level);
      pixel[1] = static_cast<float>(level * 0.95);
      pixel[2] = static_cast<float>(level * 0.9);
    }
  }
  return image;
}

// What a sensor shot at `ev` records: radiance scaled by the exposure and clipped at the
// white level. A larger ev is a darker frame.
LinearImage expose(const LinearImage& radiance, double ev) {
  LinearImage frame = make_linear(radiance.width, radiance.height);
  const auto gain = static_cast<float>(std::pow(2.0, -ev));
  for (size_t i = 0; i < frame.rgb.size(); ++i) {
    frame.rgb[i] = std::clamp(radiance.rgb[i] * gain, 0.0F, 1.0F);
  }
  return frame;
}

LinearImage shifted(const LinearImage& source, int dx, int dy) {
  LinearImage out = make_linear(source.width, source.height);
  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      const auto sx = static_cast<int64_t>(x) - dx;
      const auto sy = static_cast<int64_t>(y) - dy;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const float* pixel = source.at(static_cast<uint32_t>(sx), static_cast<uint32_t>(sy));
      std::copy_n(pixel, 3, out.at(x, y));
    }
  }
  return out;
}

LinearImage crop(const LinearImage& source, uint32_t x0, uint32_t width) {
  LinearImage out = make_linear(width, source.height);
  for (uint32_t y = 0; y < out.height; ++y) {
    std::copy_n(source.at(x0, y), static_cast<size_t>(width) * 3, out.at(0, y));
  }
  return out;
}

LinearImage wide_texture(uint32_t width, uint32_t height) {
  LinearImage image = make_linear(width, height);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const float value = std::clamp(texture_at(x, y), 0.05F, 0.9F);
      float* pixel = image.at(x, y);
      pixel[0] = value;
      pixel[1] = value * 0.9F;
      pixel[2] = value * 1.05F;
    }
  }
  return image;
}

std::vector<HdrFrame> bracket_of(const LinearImage& radiance, const std::vector<double>& evs) {
  std::vector<HdrFrame> frames;
  frames.reserve(evs.size());
  for (double ev : evs)
    frames.push_back(HdrFrame{expose(radiance, ev), ev});
  return frames;
}

// Mean relative error against the ground truth, over the pixels the merge could see.
double radiance_error(const HdrOutcome& outcome, const LinearImage& radiance) {
  double total = 0;
  size_t counted = 0;
  for (size_t i = 0; i < radiance.rgb.size(); ++i) {
    const double truth = radiance.rgb[i];
    if (truth < 0.05) continue;
    const double estimate = outcome.image.rgb[i] * outcome.scale;
    total += std::abs(estimate - truth) / truth;
    ++counted;
  }
  return counted == 0 ? 1.0 : total / static_cast<double>(counted);
}

const MergeProgress kNoProgress;

}  // namespace

TEST_CASE("merge to HDR recovers the scene radiance", "[merge]") {
  const LinearImage radiance = radiance_field(192, 128);
  const HdrOutcome outcome =
      merge_hdr(bracket_of(radiance, {-1.0, 0.0, 1.0}), HdrOptions{}, kNoProgress);

  REQUIRE(outcome.image.width == 192);
  REQUIRE(outcome.image.height == 128);
  // The brightest bracket's highlights land at 1.0, so the scale is the headroom the
  // merge won over one frame: two stops of bracket around a scene that peaks near 1.8.
  CHECK(outcome.scale > 1.05);
  CHECK_THAT(outcome.dynamic_range_ev, Catch::Matchers::WithinAbs(std::log2(outcome.scale), 1e-9));
  CHECK(*std::max_element(outcome.image.rgb.begin(), outcome.image.rgb.end()) <= 1.0F);
  CHECK(radiance_error(outcome, radiance) < 0.02);
}

TEST_CASE("a single exposure clips what the bracket keeps", "[merge]") {
  const LinearImage radiance = radiance_field(192, 128);
  const HdrOutcome outcome =
      merge_hdr(bracket_of(radiance, {-1.0, 0.0, 1.0}), HdrOptions{}, kNoProgress);
  const LinearImage middle = expose(radiance, 0.0);

  // Pixels the middle exposure blew out: the merge has to be closer to the truth there,
  // because the darkest frame still holds them.
  double merged_error = 0;
  double single_error = 0;
  size_t counted = 0;
  for (size_t i = 0; i < radiance.rgb.size(); ++i) {
    if (middle.rgb[i] < 0.999F) continue;
    const double truth = radiance.rgb[i];
    merged_error += std::abs(outcome.image.rgb[i] * outcome.scale - truth) / truth;
    single_error += std::abs(middle.rgb[i] - truth) / truth;
    ++counted;
  }
  REQUIRE(counted > 100);
  CHECK(merged_error < single_error * 0.2);
}

TEST_CASE("MTB alignment recovers a hand-held shift across exposures", "[merge]") {
  const LinearImage radiance = radiance_field(256, 192);
  const int dx = 7;
  const int dy = -5;
  // Different exposures on purpose: the whole point of the median bitmap is that a gain
  // change does not move the threshold.
  const GrayF reference = luminance(expose(radiance, 0.0));
  const GrayF moved = luminance(shifted(expose(radiance, 1.0), dx, dy));

  const Alignment alignment = align_mtb(reference, moved, AlignOptions{});
  CHECK(alignment.dx == -dx);
  CHECK(alignment.dy == -dy);
}

TEST_CASE("auto align puts a shifted exposure back where it belongs", "[merge]") {
  const LinearImage radiance = radiance_field(256, 192);
  std::vector<HdrFrame> frames = bracket_of(radiance, {-1.0, 0.0, 1.0});
  frames[0].image = shifted(frames[0].image, 6, 4);

  HdrOptions aligned;
  aligned.auto_align = true;
  HdrOptions raw;
  raw.auto_align = false;
  const HdrOutcome with = merge_hdr(frames, aligned, kNoProgress);
  const HdrOutcome without = merge_hdr(frames, raw, kNoProgress);

  CHECK(with.shift_x[2] == -6.0);
  CHECK(with.shift_y[2] == -4.0);
  CHECK(radiance_error(with, radiance) < radiance_error(without, radiance));
}

TEST_CASE("deghost drops the frame a subject moved in", "[merge]") {
  const LinearImage radiance = radiance_field(192, 128);
  std::vector<HdrFrame> frames = bracket_of(radiance, {-1.0, 0.0, 1.0});
  // A bright patch that only the brightest frame saw: someone walked through it.
  for (uint32_t y = 40; y < 72; ++y) {
    for (uint32_t x = 40; x < 72; ++x) {
      float* pixel = frames[0].image.at(x, y);
      pixel[0] = 0.9F;
      pixel[1] = 0.9F;
      pixel[2] = 0.9F;
    }
  }

  HdrOptions off;
  off.auto_align = false;
  HdrOptions on = off;
  on.deghost = Deghost::High;
  const HdrOutcome ghosted = merge_hdr(frames, off, kNoProgress);
  const HdrOutcome cleaned = merge_hdr(frames, on, kNoProgress);

  double ghost_error = 0;
  double clean_error = 0;
  for (uint32_t y = 40; y < 72; ++y) {
    for (uint32_t x = 40; x < 72; ++x) {
      const float* truth = radiance.at(x, y);
      for (int channel = 0; channel < 3; ++channel) {
        ghost_error += std::abs(ghosted.image.at(x, y)[channel] * ghosted.scale - truth[channel]);
        clean_error += std::abs(cleaned.image.at(x, y)[channel] * cleaned.scale - truth[channel]);
      }
    }
  }
  CHECK(clean_error < ghost_error * 0.5);
  // The patch is 32x32 of 192x128, so a correct deghost flags roughly 4 % of the frame.
  CHECK(cleaned.ghosted > 0.02);
  CHECK(cleaned.ghosted < 0.10);
  CHECK(ghosted.ghosted == 0.0);
}

TEST_CASE("deghost levels get stricter", "[merge]") {
  CHECK(deghost_from_name("none") == Deghost::None);
  CHECK(deghost_from_name("low") == Deghost::Low);
  CHECK(deghost_from_name("medium") == Deghost::Medium);
  CHECK(deghost_from_name("high") == Deghost::High);
  CHECK(std::string(deghost_name(Deghost::Medium)) == "medium");
  // An unknown level is off, not an error: the protocol already constrains the enum.
  CHECK(deghost_from_name("aggressive") == Deghost::None);
}

TEST_CASE("merge to HDR refuses a bracket it cannot merge", "[merge]") {
  const LinearImage radiance = radiance_field(64, 64);
  CHECK_THROWS(merge_hdr(bracket_of(radiance, {0.0}), HdrOptions{}, kNoProgress));
  CHECK_THROWS(
      merge_hdr(bracket_of(radiance, {-3, -2, -1, 0, 1, 2, 3, 4}), HdrOptions{}, kNoProgress));

  std::vector<HdrFrame> mismatched = bracket_of(radiance, {0.0, 1.0});
  mismatched[1].image = make_linear(32, 32);
  CHECK_THROWS(merge_hdr(mismatched, HdrOptions{}, kNoProgress));
}

TEST_CASE("panorama recovers the overlap and leaves no seam", "[merge]") {
  const LinearImage scene = wide_texture(400, 160);
  const uint32_t offset = 144;
  std::vector<PanoFrame> frames;
  frames.push_back(PanoFrame{crop(scene, 0, 256), 0});
  frames.push_back(PanoFrame{crop(scene, offset, 256), 0});

  PanoOptions options;
  options.projection = Projection::Perspective;
  options.auto_crop = true;
  const PanoOutcome outcome = merge_panorama(frames, options, kNoProgress);

  CHECK(outcome.offset_x[1] == static_cast<double>(offset));
  CHECK(outcome.offset_y[1] == 0.0);
  CHECK(outcome.match_score[1] > 0.9);
  REQUIRE(outcome.image.width == 400);
  REQUIRE(outcome.image.height == 160);

  // Every stitched pixel comes from the same scene, so a correct blend reproduces it and
  // the seam is a place where nothing happens.
  double worst = 0;
  for (size_t i = 0; i < outcome.image.rgb.size(); ++i) {
    worst = std::max<double>(worst, std::abs(outcome.image.rgb[i] - scene.rgb[i]));
  }
  CHECK(worst < 0.01);

  // And no step across the seam column itself.
  double jump = 0;
  for (uint32_t y = 0; y < outcome.image.height; ++y) {
    for (uint32_t x = offset; x < offset + 4; ++x) {
      const float left = outcome.image.at(x - 1, y)[1];
      const float right = outcome.image.at(x, y)[1];
      const float truth_left = scene.at(x - 1, y)[1];
      const float truth_right = scene.at(x, y)[1];
      jump = std::max<double>(jump, std::abs((right - left) - (truth_right - truth_left)));
    }
  }
  CHECK(jump < 0.01);
}

TEST_CASE("panorama auto crop throws the ragged edges away", "[merge]") {
  const LinearImage scene = wide_texture(400, 160);
  std::vector<PanoFrame> frames;
  frames.push_back(PanoFrame{crop(scene, 0, 256), 0});
  // Lift the second frame: the canvas grows by 12 rows that only one frame covers.
  frames.push_back(PanoFrame{shifted(crop(scene, 144, 256), 0, 12), 0});

  PanoOptions cropped;
  cropped.projection = Projection::Perspective;
  PanoOptions whole = cropped;
  whole.auto_crop = false;

  const PanoOutcome with = merge_panorama(frames, cropped, kNoProgress);
  const PanoOutcome without = merge_panorama(frames, whole, kNoProgress);
  CHECK(with.image.height < without.image.height);
  CHECK(with.image.width <= without.image.width);
}

TEST_CASE("panorama refuses frames that do not overlap", "[merge]") {
  std::vector<PanoFrame> frames;
  frames.push_back(PanoFrame{wide_texture(200, 160), 0});
  LinearImage flat = make_linear(200, 160);
  std::fill(flat.rgb.begin(), flat.rgb.end(), 0.4F);
  frames.push_back(PanoFrame{flat, 0});
  PanoOptions options;
  options.projection = Projection::Perspective;
  CHECK_THROWS(merge_panorama(frames, options, kNoProgress));

  CHECK_THROWS(merge_panorama({PanoFrame{wide_texture(64, 64), 0}}, options, kNoProgress));
}

TEST_CASE("a projection without a focal length falls back to flat", "[merge]") {
  const LinearImage scene = wide_texture(400, 160);
  std::vector<PanoFrame> frames;
  frames.push_back(PanoFrame{crop(scene, 0, 256), 0});
  frames.push_back(PanoFrame{crop(scene, 144, 256), 0});
  PanoOptions options;
  options.projection = Projection::Cylindrical;
  const PanoOutcome outcome = merge_panorama(frames, options, kNoProgress);
  CHECK(outcome.projection == Projection::Perspective);

  CHECK(projection_from_name("spherical") == Projection::Spherical);
  CHECK(projection_from_name("perspective") == Projection::Perspective);
  CHECK(projection_from_name("") == Projection::Cylindrical);
  CHECK(std::string(projection_name(Projection::Spherical)) == "spherical");
}

TEST_CASE("bracket groups follow the exposure pattern, not the values", "[merge]") {
  // Two sets of three, shot at different base exposures but the same offsets.
  const std::vector<std::vector<size_t>> groups = bracket_groups({-1.0, 0.0, 1.0, -0.2, 0.8, 1.8});
  REQUIRE(groups.size() == 2);
  CHECK(groups[0] == std::vector<size_t>{0, 1, 2});
  CHECK(groups[1] == std::vector<size_t>{3, 4, 5});

  // Flat exposures are a panorama, not an HDR panorama.
  CHECK(bracket_groups({0.0, 0.0, 0.0, 0.0}).empty());
  // A pattern that does not repeat.
  CHECK(bracket_groups({-1.0, 0.0, 1.0, 0.0, 3.0, 1.0}).empty());
  // An odd count cannot be split into equal sets.
  CHECK(bracket_groups({-1.0, 0.0, 1.0, -1.0, 0.0}).empty());
}

TEST_CASE("HDR panorama merges each bracket then stitches", "[merge]") {
  const LinearImage scene = wide_texture(400, 160);
  const std::vector<double> evs = {-1.0, 0.0, 1.0};
  std::vector<MergeFrame> frames;
  for (uint32_t offset : {0U, 144U}) {
    const LinearImage panel = crop(scene, offset, 256);
    for (double ev : evs)
      frames.push_back(MergeFrame{expose(panel, ev), ev, 0});
  }

  HdrPanoOptions options;
  options.hdr.auto_align = false;
  options.pano.projection = Projection::Perspective;
  const HdrPanoOutcome outcome = merge_hdr_panorama(frames, options, kNoProgress);

  CHECK(outcome.groups == 2);
  CHECK(outcome.group_size == 3);
  CHECK(outcome.image.width == 400);
  CHECK(outcome.image.height == 160);

  // One exposure of a flat scene has no pattern to find.
  std::vector<MergeFrame> flat;
  for (int i = 0; i < 4; ++i)
    flat.push_back(MergeFrame{crop(scene, 0, 200), 0, 0});
  CHECK_THROWS(merge_hdr_panorama(flat, options, kNoProgress));
}

TEST_CASE("a merged image round-trips through the source TIFF", "[merge]") {
  const std::filesystem::path directory =
      std::filesystem::temp_directory_path() / "latent-merge-test";
  std::filesystem::create_directories(directory);
  const std::string path = (directory / "scene-HDR.tif").string();
  std::filesystem::remove(path);
  std::filesystem::remove(source_sidecar_path(path));

  const LinearImage image = wide_texture(96, 64);
  SourceMetadata metadata;
  metadata.camera = "Panasonic DC-G9";
  metadata.merge = "hdr";
  metadata.scale = 4.0;
  metadata.white_balance = {2.1, 1.0, 1.7};
  metadata.sources = {"a.RW2", "b.RW2", "c.RW2"};
  metadata.iso = 200;
  write_source_tiff(path, image, metadata);

  CHECK(std::filesystem::exists(path));
  CHECK(is_source_tiff(path));
  // A TIFF without the sidecar is somebody else's file and must not take this path.
  std::filesystem::copy_file(path, directory / "plain.tif",
                             std::filesystem::copy_options::overwrite_existing);
  CHECK_FALSE(is_source_tiff((directory / "plain.tif").string()));

  const SourceMetadata loaded = read_source_metadata(path);
  CHECK(loaded.camera == "Panasonic DC-G9");
  CHECK(loaded.merge == "hdr");
  CHECK(loaded.linear);
  CHECK(loaded.color_space == "srgb");
  CHECK_THAT(loaded.scale, Catch::Matchers::WithinAbs(4.0, 1e-9));
  CHECK(loaded.sources.size() == 3);
  CHECK(loaded.iso == 200);

  const DecodedRaw decoded = read_source_tiff(path);
  REQUIRE(decoded.width == 96);
  REQUIRE(decoded.height == 64);
  CHECK(decoded.camera == "Panasonic DC-G9");
  double worst = 0;
  for (size_t i = 0; i < image.pixel_count(); ++i) {
    for (int channel = 0; channel < 3; ++channel) {
      const double stored = decoded.rgba[i * 4 + static_cast<size_t>(channel)] / 65535.0;
      worst = std::max(worst, std::abs(stored - image.rgb[i * 3 + static_cast<size_t>(channel)]));
    }
    CHECK(decoded.rgba[i * 4 + 3] == 65535);
  }
  // 16 bits of a [0,1] carrier: half a code value is the whole error budget.
  CHECK(worst < 1.0 / 65535.0);
}

TEST_CASE("exposure value and focal length come out of the frame metadata", "[merge]") {
  FrameInfo info;
  info.shutter = 1.0 / 400.0;
  info.aperture = 4.0;
  info.iso = 100;
  // log2(16 * 400) = 12.64
  CHECK_THAT(exposure_value(info), Catch::Matchers::WithinAbs(12.6439, 1e-3));
  // Four times the sensitivity is two stops of exposure the shutter did not have to give.
  info.iso = 400;
  CHECK_THAT(exposure_value(info), Catch::Matchers::WithinAbs(10.6439, 1e-3));
  // Incomplete metadata is a flat bracket, never a divide by zero.
  info.shutter = 0;
  CHECK(exposure_value(info) == 0.0);

  info.focal_length_35 = 24;
  CHECK_THAT(focal_pixels(info, 3600), Catch::Matchers::WithinAbs(2400.0, 1e-6));
  info.focal_length_35 = 0;
  CHECK(focal_pixels(info, 3600) == 0.0);
}

// ---- star trails --------------------------------------------------------------------
// The fixture is a night sequence: a dark sky carrying a fixed set of stars that all march
// the same way frame to frame, a static landscape across the bottom, and a per-frame
// speckle standing in for read noise and hot pixels.
namespace {

constexpr uint32_t kNightWidth = 160;
constexpr uint32_t kNightHeight = 120;
constexpr uint32_t kHorizon = 90;
constexpr int kStarStep = 6;
constexpr size_t kStarCount = 48;

struct Star {
  double x = 0;
  double y = 0;
  double brightness = 0;
};

std::vector<Star> star_catalog() {
  std::vector<Star> stars;
  stars.reserve(kStarCount);
  for (size_t i = 0; i < kStarCount; ++i) {
    const auto index = static_cast<int64_t>(i);
    stars.push_back(
        {8 + hash_at(index, 1) * 100, 6 + hash_at(index, 2) * 70, 0.35 + hash_at(index, 3) * 0.6});
  }
  return stars;
}

void draw_star(LinearImage& frame, const Star& star) {
  const auto left = static_cast<int>(std::floor(star.x)) - 2;
  const auto top = static_cast<int>(std::floor(star.y)) - 2;
  for (int y = top; y <= top + 4; ++y) {
    for (int x = left; x <= left + 4; ++x) {
      if (x < 0 || y < 0 || x >= static_cast<int>(frame.width) || y >= static_cast<int>(kHorizon)) {
        continue;
      }
      const double dx = x - star.x;
      const double dy = y - star.y;
      const double falloff = std::exp(-((dx * dx) + (dy * dy)) / 0.8);
      float* pixel = frame.at(static_cast<uint32_t>(x), static_cast<uint32_t>(y));
      for (int channel = 0; channel < 3; ++channel) {
        pixel[channel] = std::max(pixel[channel], static_cast<float>(star.brightness * falloff));
      }
    }
  }
}

// Frame `index` of the sequence. `speckle` scales the per-frame noise, which is what the
// FirstFrame foreground rule is there to keep out of the ground.
LinearImage night_frame(const std::vector<Star>& stars, size_t index, double speckle) {
  LinearImage frame = make_linear(kNightWidth, kNightHeight);
  for (uint32_t y = 0; y < kNightHeight; ++y) {
    for (uint32_t x = 0; x < kNightWidth; ++x) {
      const bool ground = y >= kHorizon;
      const double base = ground ? 0.04 + 0.03 * octaves_at(x, y) : 0.004;
      const double noise = speckle * hash_at(static_cast<int64_t>(x + (index * 977)),
                                             static_cast<int64_t>(y + (index * 131)));
      float* pixel = frame.at(x, y);
      for (int channel = 0; channel < 3; ++channel) {
        pixel[channel] = static_cast<float>(base + noise);
      }
    }
  }
  for (const Star& star : stars) {
    draw_star(frame,
              Star{star.x + static_cast<double>(index * kStarStep), star.y, star.brightness});
  }
  return frame;
}

std::vector<LinearImage> night_sequence(size_t count, double speckle) {
  const std::vector<Star> stars = star_catalog();
  std::vector<LinearImage> frames;
  frames.reserve(count);
  for (size_t i = 0; i < count; ++i)
    frames.push_back(night_frame(stars, i, speckle));
  return frames;
}

float luma_at(const LinearImage& image, double x, double y) {
  const auto px = static_cast<uint32_t>(std::lround(x));
  const auto py = static_cast<uint32_t>(std::lround(y));
  if (px >= image.width || py >= image.height) return 0;
  const float* pixel = image.at(px, py);
  return (pixel[0] + pixel[1] + pixel[2]) / 3.0F;
}

}  // namespace

TEST_CASE("lighten keeps every position a star has been in", "[merge][startrail]") {
  const std::vector<Star> stars = star_catalog();
  const StarTrailOutcome trails =
      merge_star_trail(night_sequence(5, 0.0), StarTrailOptions{}, kNoProgress);
  REQUIRE(trails.frames == 5);
  REQUIRE(trails.image.width == kNightWidth);

  // Every frame's copy of the first star is in the merge at that frame's brightness.
  const Star& first = stars.front();
  for (size_t frame = 0; frame < 5; ++frame) {
    const double x = first.x + static_cast<double>(frame * kStarStep);
    CHECK(luma_at(trails.image, x, first.y) > first.brightness * 0.8);
  }
  // Nothing was added between them: a lighten stack draws a dotted trail, which is what
  // gap fill is for.
  CHECK(luma_at(trails.image, first.x + (kStarStep * 0.5), first.y) < 0.05);
}

TEST_CASE("average keeps one frame's star at one frame's weight", "[merge][startrail]") {
  const std::vector<Star> stars = star_catalog();
  StarTrailOptions options;
  options.blend = TrailBlend::Average;
  const StarTrailOutcome averaged = merge_star_trail(night_sequence(5, 0.0), options, kNoProgress);

  const Star& first = stars.front();
  // A star that is in one frame of five comes out at a fifth of its brightness: the mean
  // is a longer exposure, not a trail.
  const float peak = luma_at(averaged.image, first.x, first.y);
  CHECK(peak < first.brightness * 0.35);
  CHECK(peak > first.brightness * 0.1);
  // The ground is in every frame, so it survives the mean intact.
  CHECK(luma_at(averaged.image, 40, 100) > 0.03F);
}

TEST_CASE("the first-frame foreground keeps the sequence's noise out of the ground",
          "[merge][startrail]") {
  const double speckle = 0.02;
  const LinearImage first = night_frame(star_catalog(), 0, speckle);

  const StarTrailOutcome plain =
      merge_star_trail(night_sequence(6, speckle), StarTrailOptions{}, kNoProgress);
  StarTrailOptions gated;
  gated.foreground = TrailForeground::FirstFrame;
  gated.foreground_threshold = 25;  // 2.5 % of the white level, well above the speckle
  const StarTrailOutcome guarded = merge_star_trail(night_sequence(6, speckle), gated, kNoProgress);

  // Lighten takes the brightest speckle any of the six frames had; the gate takes none.
  double plain_lift = 0;
  double guarded_lift = 0;
  for (uint32_t y = kHorizon; y < kNightHeight; ++y) {
    for (uint32_t x = 0; x < kNightWidth; ++x) {
      plain_lift += luma_at(plain.image, x, y) - luma_at(first, x, y);
      guarded_lift += luma_at(guarded.image, x, y) - luma_at(first, x, y);
    }
  }
  CHECK(plain_lift > 0.0);
  CHECK_THAT(guarded_lift, Catch::Matchers::WithinAbs(0.0, 1e-4));

  // The trails are what the gate is there to let through, and they still are.
  const Star star = star_catalog().front();
  CHECK(luma_at(guarded.image, star.x + (3 * kStarStep), star.y) > star.brightness * 0.8);
}

TEST_CASE("decay fades the older end of every trail", "[merge][startrail]") {
  const std::vector<Star> stars = star_catalog();
  StarTrailOptions options;
  options.decay = 100;
  const StarTrailOutcome comet = merge_star_trail(night_sequence(5, 0.0), options, kNoProgress);

  const Star& star = stars.front();
  const float head = luma_at(comet.image, star.x + (4 * kStarStep), star.y);
  const float tail = luma_at(comet.image, star.x, star.y);
  // Six stops across the sequence: the oldest frame lands at a sixty-fourth of the newest.
  CHECK(head > star.brightness * 0.8);
  CHECK(tail < head * 0.05F);
  // The ground still comes from the newest frames, so it is not dragged down with the tail.
  CHECK(luma_at(comet.image, 40, 100) > 0.03F);
}

TEST_CASE("gap fill draws the star between the frames it was in", "[merge][startrail]") {
  StarTrailOptions options;
  options.gap_fill = 3;
  const StarTrailOutcome filled = merge_star_trail(night_sequence(4, 0.0), options, kNoProgress);

  // The sequence steps the whole sky by kStarStep, and that is what the correlation sees.
  CHECK_THAT(filled.drift_px, Catch::Matchers::WithinAbs(kStarStep, 1.0));
  CHECK(filled.match_score > 0.5);

  const Star star = star_catalog().front();
  // The midpoint between two frames' positions was dark without the fill (the test above)
  // and is a trail with it.
  CHECK(luma_at(filled.image, star.x + (kStarStep * 0.5), star.y) > star.brightness * 0.4);
}

TEST_CASE("a star trail stack refuses what it cannot stack", "[merge][startrail]") {
  StarTrailStack stack(StarTrailOptions{}, 2, kNoProgress);
  stack.add(night_frame(star_catalog(), 0, 0.0));
  CHECK_THROWS_AS(stack.add(make_linear(64, 64)), std::runtime_error);
  stack.add(night_frame(star_catalog(), 1, 0.0));
  CHECK_THROWS_AS(stack.add(night_frame(star_catalog(), 2, 0.0)), std::runtime_error);
  const StarTrailOutcome outcome = stack.finish();
  CHECK(outcome.frames == 2);
  CHECK_THROWS_AS(stack.finish(), std::runtime_error);
  // Two frames is the floor, and one is not a merge.
  CHECK_THROWS_AS(StarTrailStack(StarTrailOptions{}, 1, kNoProgress), std::runtime_error);
}

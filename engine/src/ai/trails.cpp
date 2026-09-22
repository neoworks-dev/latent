#include "ai/trails.h"

#include <cmath>
#include <cstring>

#include <algorithm>
#include <limits>
#include <numbers>

namespace latent {

namespace {

// What the raster and the segment list are stamped with, so a change here reads as a stale
// component rather than as a silently different mask.
constexpr std::string_view kModelName = "streak-hough-1";

// Half-degree bins over the 180 degrees a line's normal can take: finer than the angular
// error of a hand-drawn seed box, coarse enough that one streak lands in one peak.
constexpr int kThetaBins = 360;
// A streak's own pixels do not all agree on its direction; this is how far a vote may
// stray from the ridge the structure tensor found.
constexpr double kAngleToleranceDeg = 8.0;
// Below this the pixel's neighbourhood has no direction — a star, or sky. A round blob's
// rim is locally directional, so this alone does not reject a star; what rejects one is
// that the direction has to agree with the line asking for the vote.
constexpr float kMinCoherence = 0.5F;
// How far a supporting pixel's ridge may run from the line it is supporting.
constexpr double kSupportToleranceDeg = 20.0;
// Fraction of a candidate line's own length that has to be lit for it to be a streak. A
// line drawn through unrelated stars scores far below this; a dashed strobe trail, whose
// gaps are bridged first, scores well above.
constexpr double kMinCoverage = 0.45;
// The strobe's dark stretch, as a fraction of the long edge.
constexpr double kGapFraction = 0.05;
// The mask's `grow` of 100 %, as a fraction of the long edge. Small on purpose: a trail is
// two or three pixels wide and what has to be repainted is the trail, not a band of sky
// around it. At 100 % this is 5 px of the 1024 px the detector works at.
constexpr double kGrowFraction = 0.005;
// Guards against a frame where everything is bright: the Hough walk is linear in the
// candidate count and this is what keeps a noisy sky from producing thousands.
constexpr double kBrightBudget = 0.03;
constexpr size_t kMaxCandidates = 256;
constexpr size_t kMaxSegments = 64;

struct Plane {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<float> v;

  float at(uint32_t x, uint32_t y) const { return v[(static_cast<size_t>(y) * width) + x]; }
  size_t index(uint32_t x, uint32_t y) const { return (static_cast<size_t>(y) * width) + x; }
};

Plane make_plane(uint32_t width, uint32_t height) {
  Plane plane;
  plane.width = width;
  plane.height = height;
  plane.v.assign(static_cast<size_t>(width) * height, 0.0F);
  return plane;
}

// Rec.709 luma over the sRGB bytes as they are. Detection is a contrast question, so the
// transfer function it is measured through only has to be the same for every pixel.
Plane luminance_plane(const Rgb8Image& image) {
  Plane plane = make_plane(image.width, image.height);
  for (size_t i = 0; i < plane.v.size(); ++i) {
    plane.v[i] = (0.2126F * static_cast<float>(image.pixels[i * 3]) +
                  0.7152F * static_cast<float>(image.pixels[(i * 3) + 1]) +
                  0.0722F * static_cast<float>(image.pixels[(i * 3) + 2])) /
                 255.0F;
  }
  return plane;
}

int clamp_int(int value, int low, int high) {
  return std::min(high, std::max(low, value));
}

Plane box_blur(const Plane& source, int radius) {
  Plane horizontal = make_plane(source.width, source.height);
  const auto width = static_cast<int>(source.width);
  const auto height = static_cast<int>(source.height);
  const double window = (2 * radius) + 1;
  for (int y = 0; y < height; ++y) {
    const size_t row = static_cast<size_t>(y) * source.width;
    double sum = 0;
    for (int x = -radius; x <= radius; ++x)
      sum += source.v[row + static_cast<size_t>(clamp_int(x, 0, width - 1))];
    for (int x = 0; x < width; ++x) {
      horizontal.v[row + static_cast<size_t>(x)] = static_cast<float>(sum / window);
      sum -= source.v[row + static_cast<size_t>(clamp_int(x - radius, 0, width - 1))];
      sum += source.v[row + static_cast<size_t>(clamp_int(x + radius + 1, 0, width - 1))];
    }
  }
  Plane blurred = make_plane(source.width, source.height);
  for (int x = 0; x < width; ++x) {
    double sum = 0;
    for (int y = -radius; y <= radius; ++y)
      sum += horizontal.v[(static_cast<size_t>(clamp_int(y, 0, height - 1)) * source.width) + x];
    for (int y = 0; y < height; ++y) {
      blurred.v[(static_cast<size_t>(y) * source.width) + x] = static_cast<float>(sum / window);
      sum -= horizontal
                 .v[(static_cast<size_t>(clamp_int(y - radius, 0, height - 1)) * source.width) + x];
      sum += horizontal
                 .v[(static_cast<size_t>(clamp_int(y + radius + 1, 0, height - 1)) * source.width) +
                    x];
    }
  }
  return blurred;
}

// Luminance minus its own local average, clipped at zero: the sky's gradient and the
// landscape's mass are in the blur, the stars and the streaks are what is left over.
Plane high_pass(const Plane& luminance, int radius) {
  const Plane blurred = box_blur(luminance, radius);
  Plane residual = make_plane(luminance.width, luminance.height);
  for (size_t i = 0; i < residual.v.size(); ++i) {
    residual.v[i] = std::max(0.0F, luminance.v[i] - blurred.v[i]);
  }
  return residual;
}

struct Ridges {
  // Direction *along* the ridge, radians in [0, pi).
  std::vector<float> angle;
  // 0..1. One for a perfect line, zero for a round blob or flat sky.
  std::vector<float> coherence;
};

// The structure tensor of the residual, smoothed over a window: the eigenvector of the
// smaller eigenvalue is the direction nothing changes along, which for a thin bright line
// is the line.
Ridges ridge_orientation(const Plane& residual, int radius) {
  Plane xx = make_plane(residual.width, residual.height);
  Plane xy = make_plane(residual.width, residual.height);
  Plane yy = make_plane(residual.width, residual.height);
  for (uint32_t y = 1; y + 1 < residual.height; ++y) {
    for (uint32_t x = 1; x + 1 < residual.width; ++x) {
      const float gx = residual.at(x + 1, y) - residual.at(x - 1, y);
      const float gy = residual.at(x, y + 1) - residual.at(x, y - 1);
      const size_t index = residual.index(x, y);
      xx.v[index] = gx * gx;
      xy.v[index] = gx * gy;
      yy.v[index] = gy * gy;
    }
  }
  const Plane sxx = box_blur(xx, radius);
  const Plane sxy = box_blur(xy, radius);
  const Plane syy = box_blur(yy, radius);

  Ridges ridges;
  ridges.angle.assign(residual.v.size(), 0.0F);
  ridges.coherence.assign(residual.v.size(), 0.0F);
  for (size_t i = 0; i < residual.v.size(); ++i) {
    const double trace = sxx.v[i] + syy.v[i];
    if (trace <= 1e-9) continue;
    const double spread = std::hypot(sxx.v[i] - syy.v[i], 2.0 * sxy.v[i]);
    ridges.coherence[i] = static_cast<float>(spread / trace);
    // Dominant *gradient* direction; the ridge runs across it.
    const double gradient = 0.5 * std::atan2(2.0 * sxy.v[i], sxx.v[i] - syy.v[i]);
    double along = gradient + (std::numbers::pi / 2);
    while (along < 0)
      along += std::numbers::pi;
    while (along >= std::numbers::pi)
      along -= std::numbers::pi;
    ridges.angle[i] = static_cast<float>(along);
  }
  return ridges;
}

// One bright pixel of the seed box, as the fit below sees it.
struct Sample {
  double x = 0;
  double y = 0;
  double value = 0;
};

struct Moments {
  double weight = 0;
  double cx = 0;
  double cy = 0;
  double angle = 0;
};

// Brightness-weighted centroid and principal direction of a set of pixels.
Moments moments_of(const std::vector<Sample>& samples) {
  Moments moments;
  for (const Sample& sample : samples) {
    moments.weight += sample.value;
    moments.cx += sample.value * sample.x;
    moments.cy += sample.value * sample.y;
  }
  if (moments.weight <= 0) return moments;
  moments.cx /= moments.weight;
  moments.cy /= moments.weight;
  double cxx = 0;
  double cxy = 0;
  double cyy = 0;
  for (const Sample& sample : samples) {
    const double dx = sample.x - moments.cx;
    const double dy = sample.y - moments.cy;
    cxx += sample.value * dx * dx;
    cxy += sample.value * dx * dy;
    cyy += sample.value * dy * dy;
  }
  moments.angle = 0.5 * std::atan2(2.0 * cxy / moments.weight, (cxx - cyy) / moments.weight);
  return moments;
}

struct SeedStreak {
  bool ok = false;
  std::string message;
  double cx = 0;
  double cy = 0;
  double angle = 0;  // along the streak, radians
  double half_length = 0;
  double half_width = 1;
  double brightness = 0;
};

// The stroke in pixels, and how far either side of it counts as "drawn on".
struct SeedStroke {
  std::vector<std::array<double, 2>> points;
  double reach = 6;
};

double distance_to_stroke(const SeedStroke& stroke, double x, double y) {
  double best = std::numeric_limits<double>::max();
  for (size_t i = 0; i + 1 < stroke.points.size(); ++i) {
    const double ax = stroke.points[i][0];
    const double ay = stroke.points[i][1];
    const double bx = stroke.points[i + 1][0];
    const double by = stroke.points[i + 1][1];
    const double dx = bx - ax;
    const double dy = by - ay;
    const double length_squared = (dx * dx) + (dy * dy);
    double t = 0;
    if (length_squared > 1e-9) {
      t = std::clamp((((x - ax) * dx) + ((y - ay) * dy)) / length_squared, 0.0, 1.0);
    }
    best = std::min(best, std::hypot(x - (ax + (t * dx)), y - (ay + (t * dy))));
  }
  return best;
}

// The one streak the user drew along: where it is, which way it runs, how wide and how
// bright. Everything else in the frame is judged against these numbers.
SeedStreak measure_seed(const Plane& residual, const TrailParams& params) {
  SeedStreak seed;
  const auto width = static_cast<int>(residual.width);
  const auto height = static_cast<int>(residual.height);
  SeedStroke stroke;
  for (const std::array<double, 2>& point : params.seed) {
    stroke.points.push_back({point[0] * width, point[1] * height});
  }
  // A single tap is a stroke of no length; a swipe across a trail is the usual gesture.
  if (stroke.points.size() < 2) {
    seed.message = "draw along one trail: a stroke, not a tap";
    return seed;
  }
  // How far either side of the line the user's hand counts for. Wide enough that a stroke
  // drawn beside the trail still finds it, narrow enough that it is not a second search.
  stroke.reach = std::max(6.0, 0.012 * std::max(width, height));

  // The band around the stroke, as a rectangle to walk.
  double low_x = stroke.points.front()[0];
  double high_x = low_x;
  double low_y = stroke.points.front()[1];
  double high_y = low_y;
  for (const std::array<double, 2>& point : stroke.points) {
    low_x = std::min(low_x, point[0]);
    high_x = std::max(high_x, point[0]);
    low_y = std::min(low_y, point[1]);
    high_y = std::max(high_y, point[1]);
  }
  const int x0 = clamp_int(static_cast<int>(std::floor(low_x - stroke.reach)), 0, width - 1);
  const int x1 = clamp_int(static_cast<int>(std::ceil(high_x + stroke.reach)), 0, width - 1);
  const int y0 = clamp_int(static_cast<int>(std::floor(low_y - stroke.reach)), 0, height - 1);
  const int y1 = clamp_int(static_cast<int>(std::ceil(high_y + stroke.reach)), 0, height - 1);

  float peak = 0;
  for (int y = y0; y <= y1; ++y) {
    for (int x = x0; x <= x1; ++x) {
      if (distance_to_stroke(stroke, x, y) > stroke.reach) continue;
      peak = std::max(peak, residual.at(static_cast<uint32_t>(x), static_cast<uint32_t>(y)));
    }
  }
  if (peak < 1e-4F) {
    seed.message = "nothing under that stroke stands out of the sky";
    return seed;
  }

  // Everything within a stop and a half of the brightest thing under the stroke is a
  // candidate. A stroke drawn along a trail in a night sky also crosses stars — which is
  // why the fit below throws pixels out instead of averaging them all.
  const float floor_value = peak * 0.35F;
  std::vector<Sample> samples;
  for (int y = y0; y <= y1; ++y) {
    for (int x = x0; x <= x1; ++x) {
      const float value = residual.at(static_cast<uint32_t>(x), static_cast<uint32_t>(y));
      if (value < floor_value) continue;
      if (distance_to_stroke(stroke, x, y) > stroke.reach) continue;
      samples.push_back(Sample{static_cast<double>(x), static_cast<double>(y), value});
    }
  }
  if (samples.size() < 6) {
    seed.message = "too little under that stroke to measure: draw along one trail";
    return seed;
  }

  // Fit, drop what is far from the fit, fit again. Three rounds is enough to walk a line
  // off the stars the stroke happened to cross; without it a single star under the hand
  // sets the width, and the mask comes out fifty pixels wide.
  std::vector<Sample> inliers = samples;
  double reach = stroke.reach;
  for (int round = 0; round < 3; ++round) {
    const Moments moments = moments_of(inliers);
    if (moments.weight <= 0) break;
    seed.cx = moments.cx;
    seed.cy = moments.cy;
    seed.angle = moments.angle;
    const double cosine = std::cos(seed.angle);
    const double sine = std::sin(seed.angle);
    std::vector<double> distances;
    distances.reserve(samples.size());
    for (const Sample& sample : samples) {
      distances.push_back(
          std::abs(((sample.y - seed.cy) * cosine) - ((sample.x - seed.cx) * sine)));
    }
    // Median absolute distance from the fitted line: the scale a star sits outside of.
    std::vector<double> sorted = distances;
    std::nth_element(sorted.begin(), sorted.begin() + (sorted.size() / 2), sorted.end());
    reach = std::max(2.0, 3.0 * sorted[sorted.size() / 2]);
    inliers.clear();
    for (size_t i = 0; i < samples.size(); ++i) {
      if (distances[i] <= reach) inliers.push_back(samples[i]);
    }
    if (inliers.size() < 6) {
      seed.message = "too little under that stroke to measure: draw along one trail";
      return seed;
    }
  }

  const double cosine = std::cos(seed.angle);
  const double sine = std::sin(seed.angle);
  double low = 0;
  double high = 0;
  double widest = 0;
  double brightness = 0;
  for (size_t i = 0; i < inliers.size(); ++i) {
    const double along = ((inliers[i].x - seed.cx) * cosine) + ((inliers[i].y - seed.cy) * sine);
    const double across =
        std::abs(((inliers[i].y - seed.cy) * cosine) - ((inliers[i].x - seed.cx) * sine));
    low = i == 0 ? along : std::min(low, along);
    high = i == 0 ? along : std::max(high, along);
    widest = std::max(widest, across);
    brightness += inliers[i].value;
  }
  seed.brightness = brightness / static_cast<double>(inliers.size());
  seed.half_length = (high - low) / 2;
  // The streak's own half-width, floored at a pixel and capped: past this it is not a
  // trail the detector can tell from a cloud, and the mask's margin is `grow`'s job.
  seed.half_width = std::clamp(widest, 1.0, 5.0);
  // Re-centre on the inliers' own span: the first moments were pulled by whatever the
  // rounds threw out.
  seed.cx += cosine * ((high + low) / 2);
  seed.cy += sine * ((high + low) / 2);
  if (seed.half_length < seed.half_width * 2.0) {
    seed.message = "that stroke is on a round object, not a trail";
    return seed;
  }
  seed.ok = true;
  return seed;
}

struct Candidate {
  int theta = 0;
  int rho = 0;
  uint32_t votes = 0;
};

// Perpendicular reach, in pixels, of the search around a candidate line.
int search_tolerance(const SeedStreak& seed) {
  return std::max(1, static_cast<int>(std::lround(seed.half_width)) + 1);
}

// Angle between two undirected directions, in radians: a line has no front.
double angle_between(double a, double b) {
  double difference = std::fmod(std::abs(a - b), std::numbers::pi);
  if (difference > std::numbers::pi / 2) difference = std::numbers::pi - difference;
  return difference;
}

// Is the line lit here? A bright pixel only supports the line if its own ridge runs along
// it. That is what a star cannot do: its rim is bright and locally directional, but the
// direction is tangential, so at most a sliver of it ever agrees with any one line.
bool bright_near(const std::vector<uint8_t>& bright, const Plane& residual, const Ridges& ridges,
                 double along, double x, double y, double nx, double ny, int tolerance,
                 float* value) {
  bool found = false;
  for (int step = -tolerance; step <= tolerance; ++step) {
    const auto px = static_cast<int>(std::lround(x + (nx * step)));
    const auto py = static_cast<int>(std::lround(y + (ny * step)));
    if (px < 0 || py < 0 || px >= static_cast<int>(residual.width) ||
        py >= static_cast<int>(residual.height)) {
      continue;
    }
    const size_t index = residual.index(static_cast<uint32_t>(px), static_cast<uint32_t>(py));
    if (bright[index] == 0) continue;
    if (ridges.coherence[index] < kMinCoherence) continue;
    if (angle_between(ridges.angle[index], along) >
        kSupportToleranceDeg / 180.0 * std::numbers::pi) {
      continue;
    }
    found = true;
    *value = std::max(*value, residual.v[index]);
  }
  return found;
}

void erase_near(std::vector<uint8_t>& bright, const Plane& residual, double x, double y, double nx,
                double ny, int tolerance) {
  for (int step = -tolerance; step <= tolerance; ++step) {
    const auto px = static_cast<int>(std::lround(x + (nx * step)));
    const auto py = static_cast<int>(std::lround(y + (ny * step)));
    if (px < 0 || py < 0 || px >= static_cast<int>(residual.width) ||
        py >= static_cast<int>(residual.height)) {
      continue;
    }
    bright[residual.index(static_cast<uint32_t>(px), static_cast<uint32_t>(py))] = 0;
  }
}

// Distance from a point to a segment, for the rasteriser.
double distance_to_segment(const TrailSegment& segment, double x, double y) {
  const double dx = segment.x1 - segment.x0;
  const double dy = segment.y1 - segment.y0;
  const double length_squared = (dx * dx) + (dy * dy);
  double t = 0;
  if (length_squared > 1e-9) {
    t = (((x - segment.x0) * dx) + ((y - segment.y0) * dy)) / length_squared;
    t = std::clamp(t, 0.0, 1.0);
  }
  return std::hypot(x - (segment.x0 + (t * dx)), y - (segment.y0 + (t * dy)));
}

GrayImage rasterise(const std::vector<TrailSegment>& segments, uint32_t width, uint32_t height,
                    double grow_px) {
  GrayImage raster;
  raster.width = width;
  raster.height = height;
  raster.pixels.assign(static_cast<size_t>(width) * height, 0);
  for (const TrailSegment& segment : segments) {
    const double half = segment.half_width + grow_px;
    const int x0 =
        clamp_int(static_cast<int>(std::floor(std::min(segment.x0, segment.x1) - half - 2)), 0,
                  static_cast<int>(width) - 1);
    const int x1 =
        clamp_int(static_cast<int>(std::ceil(std::max(segment.x0, segment.x1) + half + 2)), 0,
                  static_cast<int>(width) - 1);
    const int y0 =
        clamp_int(static_cast<int>(std::floor(std::min(segment.y0, segment.y1) - half - 2)), 0,
                  static_cast<int>(height) - 1);
    const int y1 =
        clamp_int(static_cast<int>(std::ceil(std::max(segment.y0, segment.y1) + half + 2)), 0,
                  static_cast<int>(height) - 1);
    for (int y = y0; y <= y1; ++y) {
      for (int x = x0; x <= x1; ++x) {
        const double distance = distance_to_segment(segment, x, y);
        // One pixel of ramp at the edge: a hard line against a smooth sky shows its own
        // staircase when a removal paints up to it.
        const double t = std::clamp(half + 1 - distance, 0.0, 1.0);
        const auto level = static_cast<uint8_t>(std::lround(t * 255));
        uint8_t& pixel = raster.pixels[(static_cast<size_t>(y) * width) + x];
        pixel = std::max(pixel, level);
      }
    }
  }
  return raster;
}

}  // namespace

TrailParams trail_params_from_json(const nlohmann::json& params) {
  TrailParams out;
  if (params.contains("seed") && params["seed"].is_array()) {
    for (const nlohmann::json& point : params["seed"]) {
      if (!point.is_array() || point.size() != 2) continue;
      if (!point[0].is_number() || !point[1].is_number()) continue;
      out.seed.push_back({point[0].get<double>(), point[1].get<double>()});
    }
  }
  out.sensitivity = params.value("sensitivity", 50.0);
  out.min_length = params.value("minLength", 10.0);
  out.grow = params.value("grow", 25.0);
  return out;
}

TrailDetection find_trails(const Rgb8Image& image, const TrailParams& params) {
  TrailDetection detection;
  if (image.width < 16 || image.height < 16) {
    detection.message = "there is no image to look at";
    return detection;
  }
  if (params.seed.size() < 2) {
    detection.message = "a trails mask needs a stroke drawn along one trail to learn from";
    return detection;
  }

  const auto long_edge = static_cast<double>(std::max(image.width, image.height));
  // The high pass has to be wider than a trail and narrower than the sky's own gradient.
  const int blur_radius = std::max(3, static_cast<int>(long_edge / 128));
  const Plane residual = high_pass(luminance_plane(image), blur_radius);
  const SeedStreak seed = measure_seed(residual, params);
  if (!seed.ok) {
    detection.message = seed.message;
    return detection;
  }

  // What counts as bright: the seed's own streak at sensitivity 0, a tenth of it at 100.
  const double sensitivity = std::clamp(params.sensitivity, 0.0, 100.0);
  auto threshold = static_cast<float>(seed.brightness * (1.0 - (sensitivity / 100.0 * 0.9)));
  std::vector<uint8_t> bright(residual.v.size(), 0);
  const auto budget = static_cast<size_t>(kBrightBudget * static_cast<double>(residual.v.size()));
  size_t lit = 0;
  for (int attempt = 0; attempt < 24; ++attempt) {
    lit = 0;
    for (size_t i = 0; i < residual.v.size(); ++i) {
      bright[i] = residual.v[i] >= threshold ? 1 : 0;
      lit += bright[i];
    }
    if (lit <= budget) break;
    // A frame full of noise at this threshold: the only honest answer is to ask for more.
    threshold *= 1.4F;
  }
  if (lit == 0) {
    detection.message = "nothing in this frame is as bright as the trail in the box";
    return detection;
  }

  const Ridges ridges = ridge_orientation(residual, std::max(3, blur_radius));
  const double min_length_px = std::max(8.0, params.min_length / 100.0 * long_edge);
  const double max_gap_px = kGapFraction * long_edge;
  const auto diagonal = static_cast<int>(
      std::ceil(std::hypot(static_cast<double>(image.width), static_cast<double>(image.height))));
  const int rho_bins = (2 * diagonal) + 1;

  // Oriented Hough: a pixel votes only for the lines that run along its own ridge, which
  // is what keeps a field of round stars from electing a line through all of them.
  std::vector<uint32_t> accumulator(static_cast<size_t>(kThetaBins) * rho_bins, 0);
  std::vector<double> cosines(kThetaBins);
  std::vector<double> sines(kThetaBins);
  for (int bin = 0; bin < kThetaBins; ++bin) {
    const double theta = std::numbers::pi * bin / kThetaBins;
    cosines[static_cast<size_t>(bin)] = std::cos(theta);
    sines[static_cast<size_t>(bin)] = std::sin(theta);
  }
  const int angle_span =
      std::max(1, static_cast<int>(std::lround(kAngleToleranceDeg / 180.0 * kThetaBins)));
  for (uint32_t y = 0; y < image.height; ++y) {
    for (uint32_t x = 0; x < image.width; ++x) {
      const size_t index = residual.index(x, y);
      if (bright[index] == 0 || ridges.coherence[index] < kMinCoherence) continue;
      // The line's normal is across the ridge the pixel sits on.
      const double normal = ridges.angle[index] + (std::numbers::pi / 2);
      const auto centre = static_cast<int>(std::lround(normal / std::numbers::pi * kThetaBins));
      for (int offset = -angle_span; offset <= angle_span; ++offset) {
        int bin = (centre + offset) % kThetaBins;
        if (bin < 0) bin += kThetaBins;
        const double rho =
            (x * cosines[static_cast<size_t>(bin)]) + (y * sines[static_cast<size_t>(bin)]);
        const auto rho_bin = static_cast<int>(std::lround(rho)) + diagonal;
        if (rho_bin < 0 || rho_bin >= rho_bins) continue;
        ++accumulator[(static_cast<size_t>(bin) * rho_bins) + rho_bin];
      }
    }
  }

  const auto min_votes = static_cast<uint32_t>(std::max(6.0, min_length_px * kMinCoverage * 0.5));
  std::vector<Candidate> candidates;
  for (int bin = 0; bin < kThetaBins; ++bin) {
    for (int rho = 0; rho < rho_bins; ++rho) {
      const uint32_t votes = accumulator[(static_cast<size_t>(bin) * rho_bins) + rho];
      if (votes < min_votes) continue;
      candidates.push_back(Candidate{bin, rho - diagonal, votes});
    }
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const Candidate& a, const Candidate& b) { return a.votes > b.votes; });
  if (candidates.size() > kMaxCandidates) candidates.resize(kMaxCandidates);

  // The seed's own streak is a segment whatever the vote says, and its pixels leave the
  // map so the walk below does not report it twice.
  const int tolerance = search_tolerance(seed);
  TrailSegment seed_segment;
  seed_segment.x0 = seed.cx - (std::cos(seed.angle) * seed.half_length);
  seed_segment.y0 = seed.cy - (std::sin(seed.angle) * seed.half_length);
  seed_segment.x1 = seed.cx + (std::cos(seed.angle) * seed.half_length);
  seed_segment.y1 = seed.cy + (std::sin(seed.angle) * seed.half_length);
  seed_segment.half_width = seed.half_width;
  seed_segment.brightness = seed.brightness;
  seed_segment.seed = true;
  detection.segments.push_back(seed_segment);
  {
    const double steps = std::max(1.0, seed.half_length * 2);
    const double nx = -std::sin(seed.angle);
    const double ny = std::cos(seed.angle);
    for (double t = 0; t <= steps; t += 1.0) {
      const double fraction = t / steps;
      erase_near(bright, residual,
                 seed_segment.x0 + (fraction * (seed_segment.x1 - seed_segment.x0)),
                 seed_segment.y0 + (fraction * (seed_segment.y1 - seed_segment.y0)), nx, ny,
                 tolerance + 1);
    }
  }

  for (const Candidate& candidate : candidates) {
    if (detection.segments.size() >= kMaxSegments) break;
    const double cosine = cosines[static_cast<size_t>(candidate.theta)];
    const double sine = sines[static_cast<size_t>(candidate.theta)];
    const double base_x = candidate.rho * cosine;
    const double base_y = candidate.rho * sine;
    // Along the line, and across it.
    const double dx = -sine;
    const double dy = cosine;
    const double along_angle = std::fmod(std::atan2(dy, dx) + std::numbers::pi, std::numbers::pi);

    // Walk the whole line, note where it is lit, and let a gap no longer than a strobe's
    // dark stretch keep one run going.
    double best_start = 0;
    double best_end = 0;
    double best_covered = 0;
    double best_brightness = 0;
    double run_start = 0;
    double run_covered = 0;
    double run_brightness = 0;
    double last_hit = 0;
    bool running = false;
    for (int step = -diagonal; step <= diagonal; ++step) {
      const double x = base_x + (dx * step);
      const double y = base_y + (dy * step);
      if (x < -1 || y < -1 || x > image.width || y > image.height) {
        if (running && last_hit - run_start > best_end - best_start) {
          best_start = run_start;
          best_end = last_hit;
          best_covered = run_covered;
          best_brightness = run_brightness;
        }
        running = false;
        continue;
      }
      float value = 0;
      // The search is across the line, which is the direction its own normal points.
      if (!bright_near(bright, residual, ridges, along_angle, x, y, cosine, sine, tolerance,
                       &value)) {
        if (running && step - last_hit > max_gap_px) {
          if (last_hit - run_start > best_end - best_start) {
            best_start = run_start;
            best_end = last_hit;
            best_covered = run_covered;
            best_brightness = run_brightness;
          }
          running = false;
        }
        continue;
      }
      if (!running) {
        running = true;
        run_start = step;
        run_covered = 0;
        run_brightness = 0;
      }
      last_hit = step;
      run_covered += 1;
      run_brightness = std::max(run_brightness, static_cast<double>(value));
    }
    if (running && last_hit - run_start > best_end - best_start) {
      best_start = run_start;
      best_end = last_hit;
      best_covered = run_covered;
      best_brightness = run_brightness;
    }

    const double length = best_end - best_start;
    if (length < min_length_px) continue;
    if (best_covered / length < kMinCoverage) continue;

    TrailSegment segment;
    segment.x0 = base_x + (dx * best_start);
    segment.y0 = base_y + (dy * best_start);
    segment.x1 = base_x + (dx * best_end);
    segment.y1 = base_y + (dy * best_end);
    segment.half_width = seed.half_width;
    segment.brightness = best_brightness;
    detection.segments.push_back(segment);

    // The pixels this segment explains are spent: another candidate one bin over must not
    // find the same streak again.
    for (double t = best_start; t <= best_end; t += 1.0) {
      erase_near(bright, residual, base_x + (dx * t), base_y + (dy * t), cosine, sine,
                 tolerance + 1);
    }
  }

  detection.ok = true;
  detection.raster =
      rasterise(detection.segments, image.width, image.height,
                std::clamp(params.grow, 0.0, 100.0) / 100.0 * kGrowFraction * long_edge);
  return detection;
}

MaskDetectResult run_trails(const MaskDetectRequest& request) {
  const TrailDetection detection =
      find_trails(request.image, trail_params_from_json(request.params));
  MaskDetectResult result;
  result.ok = detection.ok;
  result.message = detection.message;
  result.model = std::string(kModelName);
  result.raster = detection.raster;
  return result;
}

}  // namespace latent

// Removing a streak from a night sky without a model (PROMPT.md 3.9). An aircraft trail
// crosses sky, and sky is a smooth gradient plus grain — so the honest answer is not to
// invent anything: take the sky either side of the streak, pull it across the hole, and put
// the frame's own grain back on top. No server, no weights, no VRAM, ~30 ms for a crop.
//
// Three steps, and each exists for a reason a diffusion model would not need:
//
//  1. A local median. The sky around a trail has stars in it, and a star dragged into the
//     hole by an average is a smear that reads worse than the trail did. The middle of a
//     5x5 window by luminance is the sky under the stars.
//  2. Push-pull interpolation over the hole. A pyramid of (colour, confidence) down to one
//     pixel and back up: coarse levels carry the gradient across a wide hole, fine levels
//     keep the edge continuous. A blur cannot do this — it has no hole to fill from.
//  3. Grain, at the frame's own amplitude, measured off the sky that was not masked. A
//     patch of perfectly smooth sky in a grainy frame is as visible as the trail.
//
// What this is not: it does not reconstruct anything structured. A trail crossing a roof,
// a branch or the Milky Way's dust lanes gets sky smeared over it. That is the trade for
// needing nothing installed, and it is why the ComfyUI backend stays the default elsewhere.
#include "generative/backend.h"
#include "generative/image_io.h"

#include <chrono>
#include <cmath>
#include <cstdint>

#include <algorithm>
#include <array>
#include <optional>
#include <random>
#include <vector>

namespace latent {

namespace {

using Colour = std::array<float, 3>;

// Half-width of the window the sky floor is taken over, and where in it "sky" sits. Small:
// the floor has to follow the gradient it is standing in for. The median and not a lower
// percentile: a star is a handful of pixels in a window of twenty-five, so the middle of
// the window is already past it, and a lower one reads whatever dark thing is nearby — a
// branch, the edge of a tree — as the sky level and fills too dark.
constexpr int kFloorRadius = 2;
constexpr double kFloorPercentile = 0.5;
// Above this, a pixel is the model's problem and not evidence about the sky behind it.
constexpr float kMasked = 0.004F;
// How many pixels the grain statistics are measured over. A median is a sort; the sky's
// noise does not need every pixel of a 1536 px crop to be counted.
constexpr size_t kStatSamples = 100000;
// A median absolute deviation is this many sigmas for normal noise.
constexpr double kMadToSigma = 1.4826;

float to_linear(uint8_t value) {
  static const std::array<float, 256> table = [] {
    std::array<float, 256> built{};
    for (size_t i = 0; i < built.size(); ++i) {
      const double encoded = static_cast<double>(i) / 255.0;
      built[i] = static_cast<float>(encoded <= 0.04045 ? encoded / 12.92
                                                       : std::pow((encoded + 0.055) / 1.055, 2.4));
    }
    return built;
  }();
  return table[value];
}

uint8_t to_srgb(float linear) {
  const double value = std::clamp(static_cast<double>(linear), 0.0, 1.0);
  const double encoded =
      value <= 0.0031308 ? value * 12.92 : (1.055 * std::pow(value, 1.0 / 2.4)) - 0.055;
  return static_cast<uint8_t>(std::lround(encoded * 255.0));
}

float luminance(const Colour& colour) {
  return (0.2126F * colour[0]) + (0.7152F * colour[1]) + (0.0722F * colour[2]);
}

// One level of the push-pull pyramid: a colour and how much is known about it. Colour is
// stored already normalised by the weight, so a pull can mix two levels directly.
struct Field {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<Colour> colour;
  std::vector<float> weight;

  size_t index(uint32_t x, uint32_t y) const { return (static_cast<size_t>(y) * width) + x; }
};

Field half_of(const Field& fine) {
  Field coarse;
  coarse.width = std::max(1U, (fine.width + 1) / 2);
  coarse.height = std::max(1U, (fine.height + 1) / 2);
  const size_t count = static_cast<size_t>(coarse.width) * coarse.height;
  coarse.colour.assign(count, Colour{0, 0, 0});
  coarse.weight.assign(count, 0.0F);

  for (uint32_t y = 0; y < coarse.height; ++y) {
    for (uint32_t x = 0; x < coarse.width; ++x) {
      Colour sum{0, 0, 0};
      float weight = 0;
      for (uint32_t dy = 0; dy < 2; ++dy) {
        for (uint32_t dx = 0; dx < 2; ++dx) {
          const uint32_t sx = (x * 2) + dx;
          const uint32_t sy = (y * 2) + dy;
          if (sx >= fine.width || sy >= fine.height) continue;
          const size_t source = fine.index(sx, sy);
          const float child = fine.weight[source];
          if (child <= 0) continue;
          weight += child;
          for (size_t channel = 0; channel < 3; ++channel) {
            sum[channel] += child * fine.colour[source][channel];
          }
        }
      }
      const size_t target = coarse.index(x, y);
      if (weight <= 0) continue;
      for (size_t channel = 0; channel < 3; ++channel)
        coarse.colour[target][channel] = sum[channel] / weight;
      // Averaged rather than summed: four known children make a fully known parent, one
      // known child out of four makes a parent the level above is still allowed to correct.
      coarse.weight[target] = std::min(1.0F, weight / 4.0F);
    }
  }
  return coarse;
}

// Bilinear sample of a level, weighted: an unknown neighbour must not drag the sample
// towards black, so the weights are interpolated too and divided out.
void sample(const Field& field, double x, double y, Colour* colour, float* weight) {
  const double left = std::floor(x);
  const double top = std::floor(y);
  const double fx = x - left;
  const double fy = y - top;
  Colour sum{0, 0, 0};
  float total = 0;
  for (int dy = 0; dy < 2; ++dy) {
    for (int dx = 0; dx < 2; ++dx) {
      const auto sx = static_cast<int>(left) + dx;
      const auto sy = static_cast<int>(top) + dy;
      if (sx < 0 || sy < 0 || sx >= static_cast<int>(field.width) ||
          sy >= static_cast<int>(field.height)) {
        continue;
      }
      const double share = (dx == 0 ? 1 - fx : fx) * (dy == 0 ? 1 - fy : fy);
      const size_t index = field.index(static_cast<uint32_t>(sx), static_cast<uint32_t>(sy));
      const auto contribution = static_cast<float>(share) * field.weight[index];
      if (contribution <= 0) continue;
      total += contribution;
      for (size_t channel = 0; channel < 3; ++channel) {
        sum[channel] += contribution * field.colour[index][channel];
      }
    }
  }
  *weight = total;
  if (total <= 0) {
    *colour = Colour{0, 0, 0};
    return;
  }
  for (size_t channel = 0; channel < 3; ++channel)
    (*colour)[channel] = sum[channel] / total;
}

// What is known at this level stays; what is not is taken from the level above it.
void pull(Field& fine, const Field& coarse) {
  for (uint32_t y = 0; y < fine.height; ++y) {
    for (uint32_t x = 0; x < fine.width; ++x) {
      const size_t index = fine.index(x, y);
      const float known = fine.weight[index];
      if (known >= 1.0F) continue;
      Colour above{0, 0, 0};
      float above_weight = 0;
      sample(coarse, ((x + 0.5) / 2.0) - 0.5, ((y + 0.5) / 2.0) - 0.5, &above, &above_weight);
      if (above_weight <= 0) continue;
      for (size_t channel = 0; channel < 3; ++channel) {
        fine.colour[index][channel] =
            (known * fine.colour[index][channel]) + ((1.0F - known) * above[channel]);
      }
      fine.weight[index] = known + ((1.0F - known) * above_weight);
    }
  }
}

/** The sky under the stars: the 25th percentile of the window by luminance, ignoring what
 *  the mask covers. Weight 0 when the whole window is masked — the pyramid fills those. */
Field sky_floor(const std::vector<Colour>& linear, const std::vector<float>& coverage,
                uint32_t width, uint32_t height) {
  Field field;
  field.width = width;
  field.height = height;
  const size_t count = static_cast<size_t>(width) * height;
  field.colour.assign(count, Colour{0, 0, 0});
  field.weight.assign(count, 0.0F);

  std::vector<std::pair<float, size_t>> window;
  window.reserve(static_cast<size_t>((2 * kFloorRadius) + 1) * ((2 * kFloorRadius) + 1));
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      const size_t index = field.index(x, y);
      if (coverage[index] > kMasked) continue;
      window.clear();
      for (int dy = -kFloorRadius; dy <= kFloorRadius; ++dy) {
        for (int dx = -kFloorRadius; dx <= kFloorRadius; ++dx) {
          const auto sx = static_cast<int>(x) + dx;
          const auto sy = static_cast<int>(y) + dy;
          if (sx < 0 || sy < 0 || sx >= static_cast<int>(width) || sy >= static_cast<int>(height)) {
            continue;
          }
          const size_t source = field.index(static_cast<uint32_t>(sx), static_cast<uint32_t>(sy));
          if (coverage[source] > kMasked) continue;
          window.emplace_back(luminance(linear[source]), source);
        }
      }
      if (window.empty()) continue;
      const size_t rank =
          static_cast<size_t>(kFloorPercentile * static_cast<double>(window.size()));
      std::nth_element(window.begin(), window.begin() + static_cast<ptrdiff_t>(rank), window.end());
      field.colour[index] = linear[window[rank].second];
      field.weight[index] = 1.0F;
    }
  }
  return field;
}

double median_of(std::vector<double>& values) {
  if (values.empty()) return 0;
  const size_t middle = values.size() / 2;
  std::nth_element(values.begin(), values.begin() + static_cast<ptrdiff_t>(middle), values.end());
  return values[middle];
}

/** How far the real sky sits above its own floor, and how much it wanders: the offset puts
 *  the percentile's bias back, the sigma is the grain the patch has to have. Measured per
 *  channel off unmasked pixels only. */
struct Grain {
  Colour offset{0, 0, 0};
  Colour sigma{0, 0, 0};
};

Grain measure_grain(const std::vector<Colour>& linear, const Field& estimate,
                    const std::vector<float>& coverage) {
  Grain grain;
  const size_t count = linear.size();
  const size_t stride = std::max<size_t>(1, count / kStatSamples);
  for (size_t channel = 0; channel < 3; ++channel) {
    std::vector<double> residuals;
    residuals.reserve(count / stride);
    for (size_t index = 0; index < count; index += stride) {
      if (coverage[index] > kMasked || estimate.weight[index] <= 0) continue;
      residuals.push_back(linear[index][channel] - estimate.colour[index][channel]);
    }
    if (residuals.size() < 8) continue;
    const double offset = median_of(residuals);
    std::vector<double> deviations;
    deviations.reserve(residuals.size());
    for (const double residual : residuals)
      deviations.push_back(std::abs(residual - offset));
    grain.offset[channel] = static_cast<float>(offset);
    grain.sigma[channel] = static_cast<float>(kMadToSigma * median_of(deviations));
  }
  return grain;
}

class SkyBackend : public GenerativeBackend {
 public:
  std::string name() const override { return "sky"; }

  GenerativeResult run(const GenerativeRequest& request,
                       const GenerativeProgress& progress) override {
    const auto started = std::chrono::steady_clock::now();
    GenerativeResult result;
    result.model = "sky-fill";
    result.workflow = "sky";

    const std::optional<Rgb8Image> image = decode_rgb_png(request.image);
    if (!image.has_value()) {
      result.code = "bad_input";
      result.message = "the crop handed to the sky backend is not a PNG";
      return result;
    }
    // A grey PNG read as RGB replicates into all three channels, so red is the coverage.
    const std::optional<Rgb8Image> mask = decode_rgb_png(request.mask);
    if (!mask.has_value() || mask->width != image->width || mask->height != image->height) {
      result.code = "bad_input";
      result.message = "the mask handed to the sky backend does not match the crop";
      return result;
    }

    const uint32_t width = image->width;
    const uint32_t height = image->height;
    const size_t count = static_cast<size_t>(width) * height;
    std::vector<Colour> linear(count);
    std::vector<float> coverage(count);
    size_t open = 0;
    for (size_t pixel = 0; pixel < count; ++pixel) {
      for (size_t channel = 0; channel < 3; ++channel) {
        linear[pixel][channel] = to_linear(image->pixels[(pixel * 3) + channel]);
      }
      coverage[pixel] = mask->pixels[pixel * 3] / 255.0F;
      if (coverage[pixel] <= kMasked) ++open;
    }
    if (open < 16) {
      result.code = "no_sky";
      result.message = "the mask covers the whole crop: nothing left to take sky from";
      result.hint = "mask the trail, not the frame";
      return result;
    }
    if (progress && !progress(0.2, "sky")) return cancelled(result);

    Field estimate = sky_floor(linear, coverage, width, height);
    if (progress && !progress(0.5, "sky")) return cancelled(result);
    fill_holes(estimate);
    if (progress && !progress(0.8, "sky")) return cancelled(result);

    const Grain grain = measure_grain(linear, estimate, coverage);
    // Seeded, so the same op run twice puts the same grain down — a generative result is
    // cached against an input hash, and two runs that differ only in noise read as a bug.
    std::mt19937 noise(static_cast<uint32_t>(request.seed) + 0x9E3779B9U);
    std::array<std::normal_distribution<float>, 3> distribution;
    for (size_t channel = 0; channel < 3; ++channel) {
      distribution[channel] =
          std::normal_distribution<float>(0.0F, std::max(0.0F, grain.sigma[channel]));
    }

    Rgb8Image out = *image;
    for (size_t pixel = 0; pixel < count; ++pixel) {
      const float covered = coverage[pixel];
      if (covered <= 0 || estimate.weight[pixel] <= 0) continue;
      for (size_t channel = 0; channel < 3; ++channel) {
        const float sky = estimate.colour[pixel][channel] + grain.offset[channel] +
                          (grain.sigma[channel] > 0 ? distribution[channel](noise) : 0.0F);
        const float under = linear[pixel][channel];
        out.pixels[(pixel * 3) + channel] = to_srgb(under + ((sky - under) * covered));
      }
    }

    result.ok = true;
    result.png = encode_rgb_png(out);
    result.elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
            .count();
    return result;
  }

 private:
  // Down to one pixel and back: the coarse levels are what carries the gradient over a hole
  // wider than the trail is thick.
  static void fill_holes(Field& estimate) {
    std::vector<Field> pyramid;
    pyramid.push_back(estimate);
    while (pyramid.back().width > 1 || pyramid.back().height > 1) {
      pyramid.push_back(half_of(pyramid.back()));
    }
    for (size_t level = pyramid.size() - 1; level > 0; --level) {
      pull(pyramid[level - 1], pyramid[level]);
    }
    estimate = std::move(pyramid.front());
  }

  static GenerativeResult& cancelled(GenerativeResult& result) {
    result.code = "cancelled";
    result.message = "cancelled";
    return result;
  }
};

}  // namespace

std::unique_ptr<GenerativeBackend> make_sky_backend() {
  return std::make_unique<SkyBackend>();
}

}  // namespace latent

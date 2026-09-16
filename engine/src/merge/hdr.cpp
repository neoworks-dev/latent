#include "merge/hdr.h"

#include "merge/align.h"

#include <cmath>

#include <algorithm>
#include <future>
#include <numeric>
#include <stdexcept>
#include <thread>

namespace latent {

namespace {

constexpr size_t kMinFrames = 2;
constexpr size_t kMaxFrames = 7;
// Below this the pixel is noise, above it the photosite is at or near the well's ceiling
// and the value no longer tracks radiance. Both are on the scale decode_raw produces,
// where 1.0 is the white level.
constexpr float kNoiseFloor = 0.01F;
constexpr float kSaturation = 0.97F;

// Per-level radiance deviation from the reference that counts as movement, in EV.
double deghost_threshold(Deghost level) {
  switch (level) {
    case Deghost::Low:
      return 1.0;
    case Deghost::Medium:
      return 0.5;
    case Deghost::High:
      return 0.25;
    case Deghost::None:
      break;
  }
  return 0;
}

// Hat over the usable range, zero outside it. The edges are the noise floor and the
// saturation point, so a clipped highlight contributes nothing and a darker frame's
// version of the same pixel carries it instead.
float weight_of(float value) {
  if (value <= kNoiseFloor || value >= kSaturation) return 0;
  const float normalised = (value - kNoiseFloor) / (kSaturation - kNoiseFloor);
  return 1.0F - std::abs(2.0F * normalised - 1.0F);
}

// The brightest channel decides whether the pixel is usable at all: judging per channel
// lets one clipped channel through and turns a blown highlight magenta.
float pixel_weight(const float* pixel) {
  const float brightest = std::max({pixel[0], pixel[1], pixel[2]});
  return weight_of(brightest);
}

void run_parallel(uint32_t rows, const std::function<void(uint32_t, uint32_t)>& body) {
  const unsigned int hardware = std::max(1U, std::thread::hardware_concurrency());
  const uint32_t workers = std::min<uint32_t>(hardware, std::max(1U, rows / 64));
  if (workers <= 1) {
    body(0, rows);
    return;
  }
  std::vector<std::future<void>> pending;
  pending.reserve(workers);
  const uint32_t block = (rows + workers - 1) / workers;
  for (uint32_t start = 0; start < rows; start += block) {
    const uint32_t end = std::min(rows, start + block);
    pending.push_back(std::async(std::launch::async, [&body, start, end] { body(start, end); }));
  }
  for (std::future<void>& task : pending)
    task.get();
}

void report(const MergeProgress& progress, int done, int total, const std::string& stage) {
  if (progress.cancelled && progress.cancelled()) throw std::runtime_error("cancelled");
  if (progress.tick) progress.tick(done, total, stage);
}

}  // namespace

Deghost deghost_from_name(const std::string& name) {
  if (name == "low") return Deghost::Low;
  if (name == "medium") return Deghost::Medium;
  if (name == "high") return Deghost::High;
  return Deghost::None;
}

const char* deghost_name(Deghost level) {
  switch (level) {
    case Deghost::Low:
      return "low";
    case Deghost::Medium:
      return "medium";
    case Deghost::High:
      return "high";
    case Deghost::None:
      break;
  }
  return "none";
}

HdrOutcome merge_hdr(std::vector<HdrFrame> frames, const HdrOptions& options,
                     const MergeProgress& progress) {
  if (frames.size() < kMinFrames || frames.size() > kMaxFrames) {
    throw std::runtime_error("merge to HDR takes 2 to 7 exposures, got " +
                             std::to_string(frames.size()));
  }
  const uint32_t width = frames.front().image.width;
  const uint32_t height = frames.front().image.height;
  for (const HdrFrame& frame : frames) {
    if (frame.image.width != width || frame.image.height != height) {
      throw std::runtime_error("every exposure must have the same size");
    }
  }

  // Darkest first, so index 0 holds the highlights and the middle one is the reference
  // Lightroom's deghost compares against.
  std::sort(frames.begin(), frames.end(),
            [](const HdrFrame& a, const HdrFrame& b) { return a.ev > b.ev; });
  const size_t reference = frames.size() / 2;
  const double ev_reference = frames[reference].ev;

  const int total_steps = static_cast<int>(frames.size()) + 1;
  int step = 0;
  HdrOutcome outcome;
  outcome.shift_x.assign(frames.size(), 0);
  outcome.shift_y.assign(frames.size(), 0);

  // Alignment. MTB on the luminance pyramid, reference frame against each other frame;
  // the reference itself never moves, so the merged image keeps its framing.
  std::vector<std::vector<uint8_t>> coverage(frames.size());
  if (options.auto_align && frames.size() > 1) {
    const GrayF reference_luminance = luminance(frames[reference].image);
    for (size_t i = 0; i < frames.size(); ++i) {
      report(progress, step++, total_steps, "aligning");
      if (i == reference) continue;
      const Alignment alignment =
          align_mtb(reference_luminance, luminance(frames[i].image), AlignOptions{});
      outcome.shift_x[i] = alignment.dx;
      outcome.shift_y[i] = alignment.dy;
      if (alignment.dx == 0 && alignment.dy == 0 && alignment.angle == 0) continue;
      LinearImage warped = make_linear(width, height);
      warp_frame(frames[i].image, alignment, warped, coverage[i]);
      frames[i].image = std::move(warped);
    }
  } else {
    step = static_cast<int>(frames.size());
  }

  // Merge. The radiance scale is relative to the reference exposure; a frame shot one
  // stop darker (ev one higher) sees twice the radiance for the same pixel value.
  std::vector<double> gain(frames.size());
  for (size_t i = 0; i < frames.size(); ++i) {
    gain[i] = std::pow(2.0, frames[i].ev - ev_reference);
  }
  const double threshold = deghost_threshold(options.deghost);
  outcome.image = make_linear(width, height);
  std::vector<uint8_t> ghosted(static_cast<size_t>(width) * height, 0);
  report(progress, step++, total_steps, "merging");

  run_parallel(height, [&](uint32_t row_start, uint32_t row_end) {
    for (uint32_t y = row_start; y < row_end; ++y) {
      for (uint32_t x = 0; x < width; ++x) {
        const size_t index = static_cast<size_t>(y) * width + x;
        const float* reference_pixel = frames[reference].image.at(x, y);
        const float reference_weight = pixel_weight(reference_pixel);
        const double reference_luma =
            (reference_pixel[0] + reference_pixel[1] + reference_pixel[2]) / 3.0 * gain[reference];

        double sum[3] = {0, 0, 0};
        double weights = 0;
        bool dropped = false;
        for (size_t i = 0; i < frames.size(); ++i) {
          if (!coverage[i].empty() && coverage[i][index] == 0) continue;
          const float* pixel = frames[i].image.at(x, y);
          float weight = pixel_weight(pixel);
          if (weight <= 0) continue;
          // Deghost: a pixel whose radiance disagrees with the reference by more than the
          // level's threshold saw something move. Only judged where the reference itself
          // is well exposed, because a clipped or black reference says nothing.
          if (threshold > 0 && i != reference && reference_weight > 0) {
            const double radiance = (pixel[0] + pixel[1] + pixel[2]) / 3.0 * gain[i];
            const double deviation =
                std::abs(std::log2(radiance + 1e-6) - std::log2(reference_luma + 1e-6));
            if (deviation > threshold) {
              dropped = true;
              continue;
            }
          }
          weights += weight;
          for (int channel = 0; channel < 3; ++channel) {
            sum[channel] += static_cast<double>(weight) * pixel[channel] * gain[i];
          }
        }

        float* target = outcome.image.at(x, y);
        if (weights > 0) {
          for (int channel = 0; channel < 3; ++channel) {
            target[channel] = static_cast<float>(sum[channel] / weights);
          }
        } else {
          // Every frame clipped or every frame black: the darkest frame is the only one
          // that can still say something about a highlight, and it is frames[0].
          const float* darkest = frames.front().image.at(x, y);
          for (int channel = 0; channel < 3; ++channel) {
            target[channel] = static_cast<float>(darkest[channel] * gain.front());
          }
        }
        if (dropped) ghosted[index] = 1;
      }
    }
  });

  outcome.ghosted = static_cast<double>(std::accumulate(ghosted.begin(), ghosted.end(), 0LL)) /
                    static_cast<double>(ghosted.size());

  // 16 bits have to hold the whole merged range, so normalise by the brightest radiance
  // present — which is the darkest bracket's highlights — and record the divisor.
  const float peak = *std::max_element(outcome.image.rgb.begin(), outcome.image.rgb.end());
  outcome.scale = peak > 1.0F ? peak : 1.0;
  if (outcome.scale > 1.0) {
    const auto inverse = static_cast<float>(1.0 / outcome.scale);
    for (float& value : outcome.image.rgb)
      value *= inverse;
  }
  // Headroom the merge won over a single frame. The carrier still has 16 bits, so this is
  // also what the shadows lose: a 6 EV bracket leaves 10 bits below one frame's white.
  outcome.dynamic_range_ev = std::log2(outcome.scale);
  report(progress, total_steps, total_steps, "merged");
  return outcome;
}

}  // namespace latent

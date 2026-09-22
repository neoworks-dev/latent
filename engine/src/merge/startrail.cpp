#include "merge/startrail.h"

#include "merge/align.h"

#include <cmath>

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace latent {

namespace {

constexpr size_t kMinFrames = 2;
constexpr int kMaxGapFill = 8;
// What `decay` = 100 costs the oldest frame, in stops. Six is where a star's tail has
// visibly faded out without the head of the trail blowing out to keep it visible.
constexpr double kMaxDecayEv = 6.0;
// The foreground threshold's 100 % as a fraction of the white level. A night frame's
// landscape sits in the bottom few per cent, so the useful range of the slider is all in
// the first few hundredths and a full white level of travel would waste it.
constexpr double kForegroundSpan = 0.1;
// Below this the inter-frame shift is not a shift: the sub-frames would land on the frame
// they came from and cost a warp each for nothing.
constexpr double kMinDriftPx = 1.0;
// The star field's correlation is over the frame's own high-pass, so the frames overlap
// almost completely; the search only has to cover a mount's worth of motion.
constexpr double kStarOverlap = 0.9;

void report(const MergeProgress& progress, int done, int total, const std::string& stage) {
  if (progress.cancelled && progress.cancelled()) throw std::runtime_error("cancelled");
  if (progress.tick) progress.tick(done, total, stage);
}

// Separable box blur by running sums, radius in pixels.
GrayF box_blur(const GrayF& gray, uint32_t radius) {
  GrayF horizontal = gray;
  const auto reach = static_cast<int>(radius);
  const auto width = static_cast<int>(gray.width);
  const auto height = static_cast<int>(gray.height);
  for (int y = 0; y < height; ++y) {
    const float* row = gray.v.data() + (static_cast<size_t>(y) * gray.width);
    float* out = horizontal.v.data() + (static_cast<size_t>(y) * gray.width);
    double sum = 0;
    for (int x = -reach; x <= reach; ++x)
      sum += row[std::clamp(x, 0, width - 1)];
    for (int x = 0; x < width; ++x) {
      out[x] = static_cast<float>(sum / (2 * reach + 1));
      sum -= row[std::clamp(x - reach, 0, width - 1)];
      sum += row[std::clamp(x + reach + 1, 0, width - 1)];
    }
  }
  GrayF blurred = horizontal;
  for (int x = 0; x < width; ++x) {
    double sum = 0;
    for (int y = -reach; y <= reach; ++y)
      sum += horizontal.v[static_cast<size_t>(std::clamp(y, 0, height - 1)) * gray.width + x];
    for (int y = 0; y < height; ++y) {
      blurred.v[static_cast<size_t>(y) * gray.width + x] =
          static_cast<float>(sum / (2 * reach + 1));
      sum -=
          horizontal.v[static_cast<size_t>(std::clamp(y - reach, 0, height - 1)) * gray.width + x];
      sum += horizontal
                 .v[static_cast<size_t>(std::clamp(y + reach + 1, 0, height - 1)) * gray.width + x];
    }
  }
  return blurred;
}

// What the gap fill correlates: luminance minus its own local average, clipped at zero.
// The sky's gradient and the landscape's mass go with the low frequencies; the stars are
// what is left, and they are the only thing in the frame that moved.
GrayF star_field(const LinearImage& frame) {
  GrayF gray = luminance(frame);
  const uint32_t radius = std::max(4U, std::max(frame.width, frame.height) / 200);
  const GrayF blurred = box_blur(gray, radius);
  for (size_t i = 0; i < gray.v.size(); ++i) {
    gray.v[i] = std::max(0.0F, gray.v[i] - blurred.v[i]);
  }
  return gray;
}

Alignment scaled(const Alignment& alignment, double fraction) {
  Alignment part = alignment;
  part.dx *= fraction;
  part.dy *= fraction;
  part.angle *= fraction;
  return part;
}

}  // namespace

TrailBlend trail_blend_from_name(const std::string& name) {
  if (name == "average") return TrailBlend::Average;
  return TrailBlend::Lighten;
}

const char* trail_blend_name(TrailBlend blend) {
  return blend == TrailBlend::Average ? "average" : "lighten";
}

TrailForeground trail_foreground_from_name(const std::string& name) {
  if (name == "firstFrame") return TrailForeground::FirstFrame;
  return TrailForeground::Lighten;
}

const char* trail_foreground_name(TrailForeground foreground) {
  return foreground == TrailForeground::FirstFrame ? "firstFrame" : "lighten";
}

StarTrailStack::StarTrailStack(const StarTrailOptions& options, size_t frame_count,
                               const MergeProgress& progress)
    : options_(options), frame_count_(frame_count), progress_(progress) {
  if (frame_count < kMinFrames) {
    throw std::runtime_error("merge to star trails takes at least two frames, got " +
                             std::to_string(frame_count));
  }
  options_.gap_fill = std::clamp(options_.gap_fill, 0, kMaxGapFill);
  options_.foreground_threshold = std::clamp(options_.foreground_threshold, 0.0, 100.0);
  options_.decay = std::clamp(options_.decay, 0.0, 100.0);
}

void StarTrailStack::add(LinearImage frame) {
  if (finished_) throw std::runtime_error("this star trail merge is already finished");
  if (added_ >= frame_count_) {
    throw std::runtime_error("more frames than the star trail merge was told to expect");
  }
  if (added_ > 0 && (frame.width != accumulator_.width || frame.height != accumulator_.height)) {
    throw std::runtime_error("every star trail frame must have the same size");
  }

  // Comet weights: the age of a frame in stops, linear from the newest (0) to the oldest
  // (decay % of six). `decay` 0 leaves every weight at 1, which is a plain lighten.
  const double span = std::max<double>(1, static_cast<double>(frame_count_ - 1));
  const double age = static_cast<double>(frame_count_ - 1 - added_) / span;
  const double weight = std::pow(2.0, -(options_.decay / 100.0) * kMaxDecayEv * age);

  report(progress_, static_cast<int>(added_), static_cast<int>(frame_count_), "stacking");
  if (added_ == 0) {
    start(frame, weight);
  } else {
    if (options_.gap_fill > 0 && !previous_.empty()) fill_gap(frame, weight);
    fold(frame, weight);
  }
  ++added_;

  if (options_.gap_fill > 0 && added_ < frame_count_) {
    previous_stars_ = star_field(frame);
    previous_weight_ = weight;
    previous_ = std::move(frame);
  }
}

void StarTrailStack::start(const LinearImage& frame, double weight) {
  accumulator_ = frame;
  if (options_.blend == TrailBlend::Average) {
    // The first frame carries the oldest comet weight like every other one. It seeds the
    // sum rather than going through `fold`, because there is nothing to add it to yet.
    for (float& value : accumulator_.rgb)
      value = static_cast<float>(value * weight);
    weight_sum_ = weight;
    return;
  }
  if (options_.foreground == TrailForeground::FirstFrame) {
    // The still half of the picture comes from this frame, so it keeps full strength even
    // under a comet decay: the ground is not a trail and fading it is not what the decay
    // slider is asking for. Everything later has to clear the gate to get in.
    base_luminance_ = luminance(frame);
    return;
  }
  for (float& value : accumulator_.rgb)
    value = static_cast<float>(value * weight);
}

void StarTrailStack::fold(const LinearImage& frame, double weight) {
  const size_t pixels = accumulator_.pixel_count();
  if (options_.blend == TrailBlend::Average) {
    for (size_t i = 0; i < pixels * 3; ++i) {
      accumulator_.rgb[i] += static_cast<float>(frame.rgb[i] * weight);
    }
    weight_sum_ += weight;
    return;
  }

  const bool gated = options_.foreground == TrailForeground::FirstFrame;
  const GrayF gray = gated ? luminance(frame) : GrayF{};
  const auto threshold =
      static_cast<float>(options_.foreground_threshold / 100.0 * kForegroundSpan);
  for (size_t i = 0; i < pixels; ++i) {
    // The gate is per pixel, not per channel: judging a channel at a time lets one noisy
    // blue photosite through and speckles the ground.
    if (gated && gray.v[i] <= base_luminance_.v[i] + threshold) continue;
    for (size_t channel = 0; channel < 3; ++channel) {
      float& target = accumulator_.rgb[(i * 3) + channel];
      target = std::max(target, static_cast<float>(frame.rgb[(i * 3) + channel] * weight));
    }
  }
}

void StarTrailStack::fill_gap(const LinearImage& frame, double weight) {
  const GrayF stars = star_field(frame);
  const Alignment alignment = align_overlap(previous_stars_, stars, kStarOverlap);
  const double drift = std::hypot(alignment.dx, alignment.dy);
  drift_total_ += drift;
  score_total_ += alignment.score;
  ++pairs_;
  if (drift < kMinDriftPx) return;

  // Sub-frames between the two: this frame pulled back toward where the previous one saw
  // the same stars. The weight walks with them, so a comet's tail stays smooth across the
  // synthetic frames instead of stepping at every real one.
  LinearImage warped = make_linear(frame.width, frame.height);
  std::vector<uint8_t> coverage;
  const auto steps = static_cast<double>(options_.gap_fill + 1);
  for (int step = 1; step <= options_.gap_fill; ++step) {
    const double fraction = static_cast<double>(step) / steps;
    warp_frame(frame, scaled(alignment, fraction), warped, coverage);
    fold(warped, weight + ((previous_weight_ - weight) * fraction));
  }
}

StarTrailOutcome StarTrailStack::finish() {
  if (finished_) throw std::runtime_error("this star trail merge is already finished");
  if (added_ < kMinFrames) {
    throw std::runtime_error("merge to star trails takes at least two frames, got " +
                             std::to_string(added_));
  }
  finished_ = true;
  previous_ = LinearImage{};
  previous_stars_ = GrayF{};

  StarTrailOutcome outcome;
  outcome.frames = added_;
  if (pairs_ > 0) {
    outcome.drift_px = drift_total_ / static_cast<double>(pairs_);
    outcome.match_score = score_total_ / static_cast<double>(pairs_);
  }
  if (options_.blend == TrailBlend::Average && weight_sum_ > 0) {
    const auto inverse = static_cast<float>(1.0 / weight_sum_);
    for (float& value : accumulator_.rgb)
      value *= inverse;
  }
  outcome.image = std::move(accumulator_);
  report(progress_, static_cast<int>(frame_count_), static_cast<int>(frame_count_), "stacked");
  return outcome;
}

StarTrailOutcome merge_star_trail(std::vector<LinearImage> frames, const StarTrailOptions& options,
                                  const MergeProgress& progress) {
  StarTrailStack stack(options, frames.size(), progress);
  for (LinearImage& frame : frames)
    stack.add(std::move(frame));
  return stack.finish();
}

}  // namespace latent

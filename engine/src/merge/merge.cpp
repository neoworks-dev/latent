#include "merge/merge.h"

#include <cmath>

#include <algorithm>
#include <numeric>
#include <stdexcept>

namespace latent {

namespace {

constexpr size_t kMinBracket = 2;
constexpr size_t kMaxBracket = 7;
// Two exposures closer than this are the same exposure as far as a bracket is concerned,
// and two offsets further apart than this are a different pattern.
constexpr double kEvTolerance = 0.3;

// Offsets of one group around its own mean, so two sets shot at different base exposures
// still compare equal — which is Lightroom's rule.
std::vector<double> offsets_of(const std::vector<double>& evs, size_t start, size_t size) {
  const double mean = std::accumulate(evs.begin() + static_cast<long>(start),
                                      evs.begin() + static_cast<long>(start + size), 0.0) /
                      static_cast<double>(size);
  std::vector<double> offsets;
  offsets.reserve(size);
  for (size_t i = 0; i < size; ++i)
    offsets.push_back(evs[start + i] - mean);
  return offsets;
}

bool group_is_a_bracket(const std::vector<double>& offsets) {
  for (size_t i = 0; i < offsets.size(); ++i) {
    for (size_t j = i + 1; j < offsets.size(); ++j) {
      if (std::abs(offsets[i] - offsets[j]) <= kEvTolerance) return false;
    }
  }
  return true;
}

}  // namespace

MergeKind merge_kind_from_name(const std::string& name) {
  if (name == "panorama") return MergeKind::Panorama;
  if (name == "hdrPanorama") return MergeKind::HdrPanorama;
  return MergeKind::Hdr;
}

const char* merge_kind_name(MergeKind kind) {
  switch (kind) {
    case MergeKind::Panorama:
      return "panorama";
    case MergeKind::HdrPanorama:
      return "hdrPanorama";
    case MergeKind::Hdr:
      break;
  }
  return "hdr";
}

const char* merge_suffix(MergeKind kind) {
  switch (kind) {
    case MergeKind::Panorama:
      return "Pano";
    case MergeKind::HdrPanorama:
      return "HDRPano";
    case MergeKind::Hdr:
      break;
  }
  return "HDR";
}

std::vector<std::vector<size_t>> bracket_groups(const std::vector<double>& evs) {
  for (size_t size = kMinBracket; size <= kMaxBracket; ++size) {
    if (evs.size() < size * 2 || evs.size() % size != 0) continue;
    const std::vector<double> pattern = offsets_of(evs, 0, size);
    if (!group_is_a_bracket(pattern)) continue;
    bool matches = true;
    for (size_t start = size; start < evs.size() && matches; start += size) {
      const std::vector<double> offsets = offsets_of(evs, start, size);
      for (size_t i = 0; i < size; ++i) {
        if (std::abs(offsets[i] - pattern[i]) <= kEvTolerance) continue;
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    std::vector<std::vector<size_t>> groups;
    for (size_t start = 0; start < evs.size(); start += size) {
      std::vector<size_t> group(size);
      std::iota(group.begin(), group.end(), start);
      groups.push_back(std::move(group));
    }
    return groups;
  }
  return {};
}

HdrPanoOutcome merge_hdr_panorama(std::vector<MergeFrame> frames, const HdrPanoOptions& options,
                                  const MergeProgress& progress) {
  std::vector<double> evs;
  evs.reserve(frames.size());
  for (const MergeFrame& frame : frames)
    evs.push_back(frame.ev);
  const std::vector<std::vector<size_t>> groups = bracket_groups(evs);
  if (groups.size() < 2) {
    throw std::runtime_error(
        "no repeating exposure pattern in these frames: merge them as a panorama instead");
  }

  HdrPanoOutcome outcome;
  outcome.groups = groups.size();
  outcome.group_size = groups.front().size();

  std::vector<HdrOutcome> merged;
  merged.reserve(groups.size());
  std::vector<double> focals;
  focals.reserve(groups.size());
  for (const std::vector<size_t>& group : groups) {
    std::vector<HdrFrame> bracket;
    bracket.reserve(group.size());
    for (size_t index : group) {
      bracket.push_back(HdrFrame{frames[index].image, frames[index].ev});
    }
    focals.push_back(frames[group.front()].focal_px);
    merged.push_back(merge_hdr(std::move(bracket), options.hdr, progress));
  }
  // The stitch has to see one radiance scale, not one per group: put every group's pixels
  // back on the brightest group's scale before they meet in the blend.
  double common = 1;
  for (const HdrOutcome& group : merged)
    common = std::max(common, group.scale);
  std::vector<PanoFrame> panels;
  panels.reserve(merged.size());
  for (size_t i = 0; i < merged.size(); ++i) {
    const auto factor = static_cast<float>(merged[i].scale / common);
    if (factor != 1.0F) {
      for (float& value : merged[i].image.rgb)
        value *= factor;
    }
    panels.push_back(PanoFrame{std::move(merged[i].image), focals[i]});
  }

  PanoOutcome stitched = merge_panorama(std::move(panels), options.pano, progress);
  outcome.image = std::move(stitched.image);
  outcome.projection = stitched.projection;
  outcome.scale = common;
  outcome.dynamic_range_ev = std::log2(common);
  return outcome;
}

}  // namespace latent

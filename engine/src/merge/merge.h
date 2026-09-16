// Merge to HDR Panorama: the two merges above, in that order.
//
// Lightroom's requirement list (reference/lightroom/hdr-panorama.md) is what
// `bracket_groups` enforces — every set the same size, the same EV *offsets*, captured
// contiguously, no two frames in a set sharing an exposure. The absolute exposures may
// differ between sets, which is why the offsets and not the values are compared.
#pragma once

#include "merge/hdr.h"
#include "merge/merge_image.h"
#include "merge/pano.h"

#include <cstddef>
#include <cstdint>

#include <string>
#include <vector>

namespace latent {

enum class MergeKind { Hdr, Panorama, HdrPanorama };

MergeKind merge_kind_from_name(const std::string& name);
// "hdr" | "panorama" | "hdrPanorama" — the protocol's spelling, and what the merged
// file's sidecar records.
const char* merge_kind_name(MergeKind kind);
// Lightroom's output suffix: HDR, Pano, HDRPano.
const char* merge_suffix(MergeKind kind);

struct MergeFrame {
  LinearImage image;
  double ev = 0;
  double focal_px = 0;
};

struct HdrPanoOptions {
  HdrOptions hdr;
  PanoOptions pano;
};

// One validated merge request, as the server hands it to its worker.
struct MergeRequest {
  MergeKind kind = MergeKind::Hdr;
  std::vector<std::string> paths;
  HdrOptions hdr;
  PanoOptions pano;
  // merge.preview: decode the embedded JPEGs instead of the raws, write a PNG, and put
  // nothing in the catalog.
  bool preview = false;
  uint32_t long_edge = 1024;
  std::string output_path;
};

struct HdrPanoOutcome {
  LinearImage image;
  Projection projection = Projection::Perspective;
  double scale = 1;
  double dynamic_range_ev = 0;
  size_t groups = 0;
  size_t group_size = 0;
};

// Splits `evs`, in shooting order, into contiguous equal-sized bracket sets. Empty when
// no pattern of 2..7 frames repeats over the whole list — the caller then offers a plain
// panorama, exactly as Lightroom does.
std::vector<std::vector<size_t>> bracket_groups(const std::vector<double>& evs);

// One HDR merge per bracket set, then one panorama over the results. Throws
// std::runtime_error when the exposure pattern does not divide the input.
HdrPanoOutcome merge_hdr_panorama(std::vector<MergeFrame> frames, const HdrPanoOptions& options,
                                  const MergeProgress& progress);

}  // namespace latent

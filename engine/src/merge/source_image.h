// A merged photo is a new *source* image, not an edit: the editor opens it the way it
// opens a raw and the whole op-stack applies on top. The carrier is a 16-bit TIFF holding
// linear, already-demosaiced, already-white-balanced RGB, plus a small JSON sidecar
// `<file>.latent-source.json` that says so.
//
// Why a sidecar and not TIFF tags: the fields the pipeline needs (which merge produced
// this, the radiance scale, the as-shot multipliers) have no standard tag, and a private
// tag is a second parser. The JSON is the same shape as every other file Latent writes.
//
// Why 16-bit int and not float or DNG: the pipeline's upload path is rgba16uint
// (PROMPT.md 6) and adding a float source format would be a second codepath through
// linearize.wgsl. Float/DNG output is Phase 3 (PROMPT.md 7).
#pragma once

#include "merge/merge_image.h"
#include "raw/raw_decode.h"
#include "raw/raw_metadata.h"

#include <cstdint>

#include <array>
#include <string>
#include <vector>

namespace latent {

struct SourceMetadata {
  // Always true today; the field exists so a future non-linear source is not a guess.
  bool linear = true;
  // Primaries of the stored data. "srgb" while decode_raw asks LibRaw for sRGB primaries;
  // it becomes "rec2020" in the same commit that moves the working space (PROMPT.md 4).
  std::string color_space = "srgb";
  std::string camera;
  // The as-shot multipliers LibRaw applied before the merge. Recorded, not re-applicable:
  // the pixels already carry them, and a WB op works from neutral.
  std::array<double, 3> white_balance = {1.0, 1.0, 1.0};
  // Stored value * scale = scene radiance relative to the brightest frame's white level.
  // 1.0 for a panorama; an HDR merge that spans 6 EV reports 64.
  double scale = 1.0;
  std::string merge;  // "hdr" | "panorama" | "hdrPanorama"
  std::vector<std::string> sources;
  std::string captured_at;
  std::string shutter;
  double aperture = 0;
  int iso = 0;
  double focal_length = 0;
};

// Writes the TIFF and its sidecar. Values are clamped into [0,1] and scaled by 65535.
void write_source_tiff(const std::string& path, const LinearImage& image,
                       const SourceMetadata& metadata);

// True when `path` is a .tif/.tiff that has a `<path>.latent-source.json` next to it.
// Anything else is left to LibRaw, which is the point: this never shadows a TIFF raw.
bool is_source_tiff(const std::string& path);

SourceMetadata read_source_metadata(const std::string& path);

// The TIFF as the decoder's own output type, so photo.open cannot tell the difference.
// Already demosaiced and in the working space, so there is no linearise or camera-matrix
// stage to skip — decode_raw returns this instead of calling LibRaw at all.
DecodedRaw read_source_tiff(const std::string& path);

// The catalog row a merged file deserves. `read_raw_metadata` goes through LibRaw, which
// refuses a plain TIFF, so every caller that would have asked it — catalog.import,
// photo.open — asks this instead for a source TIFF. Size comes from the TIFF header, the
// camera and exposure from the sidecar, i.e. from the first source frame.
RawMetadata read_source_row(const std::string& path);

// `<path>.latent-source.json`.
std::string source_sidecar_path(const std::string& path);

}  // namespace latent

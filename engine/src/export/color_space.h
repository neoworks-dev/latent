// The output colour transform and the ICC profile that describes it — the two halves of
// one decision, which is why they live in one file: if they ever disagree the exported
// file lies about its own pixels. `engine/tests/export_test.cpp` asserts they agree by
// pushing a known colour through both.
//
// Working space: **linear sRGB primaries**. LibRaw runs with `output_color = 1`
// (src/raw/raw_decode.cpp) and shaders/linearize.wgsl only divides by 65535, so that is
// what every pass downstream sees, PROMPT.md 4's "linear Rec.2020" notwithstanding.
#pragma once

#include "export/export_options.h"

#include <cstdint>

#include <array>
#include <vector>

namespace latent {

struct ColorTransform {
  // Row-major 3x3: linear sRGB -> the target space's linear primaries.
  std::array<float, 9> matrix = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  // The encoding curve. 0 means the sRGB piecewise curve; anything else is a pure gamma,
  // applied as pow(c, 1/gamma). shaders/export.wgsl reads the same two fields.
  float gamma = 0;
};

ColorTransform export_color_transform(ExportColorSpace space);

// The ICC bytes to embed, built by lcms2 from the same primaries and the same curve.
// Throws std::runtime_error if lcms2 refuses.
std::vector<uint8_t> export_icc_profile(ExportColorSpace space);

// The CPU mirror of shaders/export.wgsl: matrix, clamp, encode. Inputs and outputs are
// 0..1. Tests use it; the export path itself runs on the GPU.
std::array<double, 3> apply_color_transform(const ColorTransform& transform,
                                            const std::array<double, 3>& linear_srgb);

}  // namespace latent

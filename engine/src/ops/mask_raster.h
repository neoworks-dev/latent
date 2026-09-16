// Brush strokes to pixels. The only mask kind the CPU rasterises: the other inline kinds
// (linear, radial, luminance, color) are closed forms and run as fragment passes in
// shaders/mask.wgsl, but a stroke list is a list of stamps, and stamping it per pixel in
// a shader would cost O(pixels x stamps) every time the mask is rebuilt.
//
// The result is uploaded once and cached (pipeline/renderer.cpp); a slider tick on a
// masked op never reaches this file.
#pragma once

#include "image/gray.h"
#include "ops/mask.h"

#include <cstdint>

#include <vector>

namespace latent {

// `feather` is the component's 0..100 edge softness: 0 is a hard disc, 100 fades from the
// centre. Coordinates in the strokes are normalised over the content rect, so `width` and
// `height` are the content rect's size in pixels and the brush stays round.
GrayImage rasterize_brush(const std::vector<BrushStroke>& strokes, double feather, uint32_t width,
                          uint32_t height);

}  // namespace latent

#include "pipeline/renderer.h"

#include "export/color_space.h"
#include "generative/generative.h"
#include "image/png.h"
#include "ops/curve.h"
#include "ops/geometry.h"
#include "ops/mask.h"
#include "ops/mask_raster.h"
#include "ops/registry.h"

#include <chrono>
#include <cmath>
#include <latent_shaders.h>

#include <algorithm>
#include <array>
#include <numbers>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace latent {

namespace {

// Uniform buffer bindings must start on a 256-byte boundary, so each op pass gets a
// 256-byte slot in one buffer and the whole stack is uploaded in a single write.
constexpr uint64_t kOpUniformStride = 256;
// One tone curve: 256 entries of vec4f, .xyz being the red/green/blue outputs.
constexpr uint64_t kCurveFloats = 4 * kCurveLutSize;
constexpr uint64_t kCurveSlotStride = kCurveFloats * sizeof(float);
using CurveTable = std::array<float, kCurveFloats>;

struct OpUniform {
  float origin[2] = {0, 0};
  float size[2] = {1, 1};
  uint32_t kind = 0;
  float opacity = 1;
  uint32_t pad[2] = {0, 0};
  float v[28] = {};
};
static_assert(sizeof(OpUniform) == 144, "must match OpParams in ops.wgsl");

// Kind numbers must match the switch in shaders/mask.wgsl.
enum class MaskPass : uint32_t {
  None = 0,
  Linear = 1,
  Radial = 2,
  Luminance = 3,
  Color = 4,
  Raster = 5,
};

// Combine modes, matching the switch in shaders/mask_combine.wgsl. Replace seeds the
// accumulator with the first component that contributes, whatever its own mode says: a
// subtract or an intersect against nothing would leave the whole mask empty.
enum class CombineMode : uint32_t { Replace = 0, Add = 1, Subtract = 2, Intersect = 3 };
constexpr uint32_t kCombineModes = 4;

struct MaskUniform {
  float origin[2] = {0, 0};
  float size[2] = {1, 1};
  uint32_t kind = 0;
  uint32_t invert = 0;
  float feather = 0;
  float opacity = 1;
  // View pixel -> working frame, then the quadrant, the mirrors and the lens term: the
  // chain that turns this invocation's pixel into a point on the uncropped photo.
  float m0[4] = {1, 0, 0, 0};
  float m1[4] = {0, 1, 0, 0};
  float m2[4] = {0, 0, 1, 0};
  float geom[4] = {0, 1, 0, 1};
  float flip[4] = {1, 1, 0, 0};
  float v[24] = {};
};
static_assert(sizeof(MaskUniform) == 208, "must match MaskParams in mask.wgsl");
static_assert(sizeof(MaskUniform) <= kOpUniformStride, "a mask must fit its uniform slot");

struct CombineUniform {
  uint32_t mode = 0;
  uint32_t pad[3] = {0, 0, 0};
};
static_assert(sizeof(CombineUniform) == 16, "must match CombineParams in mask_combine.wgsl");

// One component's textures inside a view: the r8 raster mask.wgsl wrote, plus the upload
// a brush or an AI kind is rasterised from.
struct MaskComponentTexture {
  std::string hash;
  TextureHandle texture;
  TextureViewHandle view;
  std::string source_hash;
  TextureHandle source;
  TextureViewHandle source_view;
};

// One op's mask inside a view: two r8 accumulators the fold ping-pongs between, plus the
// per-component rasters mask.preview hands out one at a time.
struct MaskEntry {
  std::string hash;
  uint32_t width = 0;
  uint32_t height = 0;
  TextureHandle accum[2];
  TextureViewHandle accum_view[2];
  int final_index = 0;
  std::unordered_map<std::string, MaskComponentTexture> components;
};

// An AI component's raster as the engine holds it between mask.detect and the render that
// uses it: resolution-independent, resampled into whatever a view needs.
struct StoredRaster {
  std::string hash;
  GrayImage image;
};

// One generative op's result on the GPU: the PNG a backend returned, uploaded as rgba8 and
// still display-referred — composite.wgsl linearises it. `key` is the op's `result` path,
// which changes with the pixels, so a stale upload can never be mistaken for a fresh one.
struct StoredResult {
  std::string key;
  uint32_t width = 0;
  uint32_t height = 0;
  TextureHandle texture;
  TextureViewHandle view;
};

struct FitUniform {
  float scale[2] = {1, 1};
  float taps[2] = {1, 1};
  float size[2] = {1, 1};
  float origin[2] = {0, 0};
  float extent[2] = {1, 1};
  float flip[2] = {1, 1};
  float m0[4] = {1, 0, 0, 0};
  float m1[4] = {0, 1, 0, 0};
  float m2[4] = {0, 0, 1, 0};
  float params[4] = {0, 1, 0, 0};
};
static_assert(sizeof(FitUniform) == 112, "must match Fit in downscale.wgsl");

struct FrameUniform {
  float content_min[2] = {0, 0};
  float content_max[2] = {0, 0};
};
static_assert(sizeof(FrameUniform) == 16, "must match Frame in display.wgsl");

struct ExportUniform {
  float m0[4] = {1, 0, 0, 0};
  float m1[4] = {0, 1, 0, 0};
  float m2[4] = {0, 0, 1, 0};
  float params[4] = {0, 0, 0, 0};
};
static_assert(sizeof(ExportUniform) == 64, "must match Output in export.wgsl");

double param(const Op& op, const char* name, double fallback = 0.0) {
  const auto found = op.params.find(name);
  if (found == op.params.end() || !found->is_number()) return fallback;
  return found->get<double>();
}

bool flag(const Op& op, const char* name) {
  const auto found = op.params.find(name);
  return found != op.params.end() && found->is_boolean() && found->get<bool>();
}

std::string text(const Op& op, const char* name) {
  const auto found = op.params.find(name);
  if (found == op.params.end() || !found->is_string()) return {};
  return found->get<std::string>();
}

// CIE xy of a Planckian radiator (Kim et al.), then linear sRGB at unit luminance. Only
// used for the ratio between two temperatures, so the absolute scale does not matter.
std::array<double, 3> planckian_white(double kelvin) {
  const double t = std::clamp(kelvin, 1667.0, 25000.0);
  const double inverse = 1000.0 / t;
  const double inverse2 = inverse * inverse;
  const double inverse3 = inverse2 * inverse;
  double x = 0;
  if (t < 4000.0) {
    x = (-0.2661239 * inverse3) - (0.2343589 * inverse2) + (0.8776956 * inverse) + 0.179910;
  } else {
    x = (-3.0258469 * inverse3) + (2.1070379 * inverse2) + (0.2226347 * inverse) + 0.240390;
  }
  const double x2 = x * x;
  const double x3 = x2 * x;
  double y = 0;
  if (t < 2222.0) {
    y = (-1.1063814 * x3) - (1.34811020 * x2) + (2.18555832 * x) - 0.20219683;
  } else if (t < 4000.0) {
    y = (-0.9549476 * x3) - (1.37418593 * x2) + (2.09137015 * x) - 0.16748867;
  } else {
    y = (3.0817580 * x3) - (5.87338670 * x2) + (3.75112997 * x) - 0.37001483;
  }
  const double big_x = x / std::max(y, 1e-6);
  const double big_z = (1.0 - x - y) / std::max(y, 1e-6);
  return {(3.2404542 * big_x) - 1.5371385 - (0.4985314 * big_z),
          (-0.9692660 * big_x) + 1.8760108 + (0.0415560 * big_z),
          (0.0556434 * big_x) - 0.2040259 + (1.0572252 * big_z)};
}

// LibRaw hands the engine an as-shot-neutral image, so "the light was K" is expressed
// relative to a 5500 K reference: below it the image cools, above it warms. The camera's
// own as-shot temperature is not plumbed through yet, which is why 5500 is the default
// and a no-op.
std::array<float, 3> kelvin_gains(double kelvin, double tint) {
  const std::array<double, 3> reference = planckian_white(5500.0);
  const std::array<double, 3> target = planckian_white(kelvin);
  std::array<double, 3> gains = {reference[0] / std::max(target[0], 1e-6),
                                 reference[1] / std::max(target[1], 1e-6),
                                 reference[2] / std::max(target[2], 1e-6)};
  const double luminance = (0.2126 * gains[0]) + (0.7152 * gains[1]) + (0.0722 * gains[2]);
  const double green = std::exp2(-tint / 150.0 * 0.3);
  const double magenta = std::exp2(tint / 150.0 * 0.15);
  return {static_cast<float>(gains[0] / luminance * magenta),
          static_cast<float>(gains[1] / luminance * green),
          static_cast<float>(gains[2] / luminance * magenta)};
}

std::array<float, 3> white_balance_gains(const Op& op) {
  if (text(op, "mode") == "kelvin") {
    return kelvin_gains(param(op, "kelvin", 5500.0), param(op, "tint"));
  }
  // Relative to the camera's as-shot white balance: 0 is neutral, +-100 is about
  // +-half a stop of red/blue split. Not Lightroom's Kelvin scale. Unchanged since the
  // first sidecars were written, so their values still mean what they meant.
  const float temperature = static_cast<float>(param(op, "temperature") / 100.0);
  const float tint = static_cast<float>(param(op, "tint") / 100.0);
  return {std::exp2((0.5F * temperature) + (0.15F * tint)), std::exp2(-0.3F * tint),
          std::exp2((-0.5F * temperature) + (0.15F * tint))};
}

// The parametric regions, the RGB point curve and the per-channel point curves, composed
// into the one table the shader looks up. Returns false when the result is the identity,
// i.e. the pass can be skipped.
bool curve_table(const Op& op, CurveTable& table) {
  ParametricCurve regions;
  regions.highlights = param(op, "highlights");
  regions.lights = param(op, "lights");
  regions.darks = param(op, "darks");
  regions.shadows = param(op, "shadows");
  regions.shadow_split = param(op, "shadowSplit", 25.0);
  regions.midtone_split = param(op, "midtoneSplit", 50.0);
  regions.highlight_split = param(op, "highlightSplit", 75.0);

  const auto points_of = [&op](const char* name) {
    const auto found = op.params.find(name);
    if (found == op.params.end()) return std::vector<CurvePoint>{};
    return curve_points_from_json(*found);
  };
  const CurveLut shared =
      compose_lut(parametric_curve_lut(regions), point_curve_lut(points_of("rgb")));
  const std::array<CurveLut, 3> channels = {
      compose_lut(shared, point_curve_lut(points_of("red"))),
      compose_lut(shared, point_curve_lut(points_of("green"))),
      compose_lut(shared, point_curve_lut(points_of("blue")))};

  bool identity = true;
  for (const CurveLut& channel : channels) {
    identity = identity && is_identity_lut(channel);
  }
  for (size_t i = 0; i < kCurveLutSize; ++i) {
    table[i * 4] = channels[0][i];
    table[(i * 4) + 1] = channels[1][i];
    table[(i * 4) + 2] = channels[2][i];
    table[(i * 4) + 3] = 0;
  }
  return !identity;
}

// Every op's defaults are neutral, and a neutral op is a pass that would return exactly
// what it was given. Skipping it keeps a panel that added twenty ops at their defaults
// off the frame budget, and makes "the default renders like an empty stack" exact rather
// than a floating-point coincidence (engine/tests/render_test.cpp).
bool is_neutral(const Op& op, OpKind kind) {
  switch (kind) {
    case OpKind::WhiteBalance:
      if (text(op, "mode") == "kelvin") {
        return param(op, "kelvin", 5500.0) == 5500.0 && param(op, "tint") == 0;
      }
      return param(op, "temperature") == 0 && param(op, "tint") == 0;
    case OpKind::ColorMixer:
      for (const auto& entry : op.params.items()) {
        if (entry.value().is_number() && entry.value().get<double>() != 0) return false;
      }
      return true;
    case OpKind::ColorGrading:
      for (const char* range : {"shadow", "midtone", "highlight", "global"}) {
        if (param(op, (std::string(range) + "Saturation").c_str()) != 0) return false;
        if (param(op, (std::string(range) + "Luminance").c_str()) != 0) return false;
      }
      return true;
    case OpKind::LensVignetting:
      return param(op, "vignetting") == 0;
    case OpKind::Vignette:
    case OpKind::Grain:
    case OpKind::ColorNoiseReduction:
    case OpKind::Sharpening:
      return param(op, "amount") == 0;
    case OpKind::NoiseReduction:
      return param(op, "luminance") == 0;
    case OpKind::Defringe:
      return param(op, "purpleAmount") == 0 && param(op, "greenAmount") == 0;
    case OpKind::ChromaticAberration:
      return !flag(op, "enabled");
    case OpKind::ToneCurve:
    case OpKind::Geometry:
    // A generative op has no neutral value: whether it does anything is decided by whether
    // it has a result, which run_passes checks rather than guessing from the params.
    case OpKind::Generative:
    case OpKind::None:
      return false;
    default:
      return param(op, "value") == 0;
  }
}

// Neighbourhood ops are two passes: a horizontal filter into the scratch texture, then a
// vertical one that combines it with the untouched source. Defringe only ever looks at a
// 3x3 of the source, so it skips the pre-pass.
bool needs_prepass(OpKind kind) {
  return kind >= OpKind::Texture && kind < OpKind::Geometry && kind != OpKind::Defringe;
}

OpUniform op_uniform(const Op& op, OpKind kind, const ViewGeometry& geometry) {
  OpUniform uniform;
  uniform.kind = static_cast<uint32_t>(kind);
  uniform.origin[0] = static_cast<float>(geometry.content_x);
  uniform.origin[1] = static_cast<float>(geometry.content_y);
  uniform.size[0] = static_cast<float>(geometry.content_width);
  uniform.size[1] = static_cast<float>(geometry.content_height);
  // Detail radii are in proxy pixels: the preview filters what the preview shows, the
  // way Lightroom's do before you zoom to 1:1.
  const double short_edge = std::min(geometry.content_width, geometry.content_height);

  switch (kind) {
    case OpKind::WhiteBalance: {
      const std::array<float, 3> gains = white_balance_gains(op);
      uniform.v[0] = gains[0];
      uniform.v[1] = gains[1];
      uniform.v[2] = gains[2];
      return uniform;
    }
    case OpKind::ColorMixer: {
      static constexpr std::array<const char*, 8> kBands = {"red",  "orange", "yellow", "green",
                                                            "aqua", "blue",   "purple", "magenta"};
      for (size_t band = 0; band < kBands.size(); ++band) {
        const std::string prefix = kBands[band];
        uniform.v[band * 3] = static_cast<float>(param(op, (prefix + "Hue").c_str()) / 100.0);
        uniform.v[(band * 3) + 1] =
            static_cast<float>(param(op, (prefix + "Saturation").c_str()) / 100.0);
        uniform.v[(band * 3) + 2] =
            static_cast<float>(param(op, (prefix + "Luminance").c_str()) / 100.0);
      }
      return uniform;
    }
    case OpKind::ColorGrading: {
      static constexpr std::array<const char*, 4> kRanges = {"shadow", "midtone", "highlight",
                                                             "global"};
      for (size_t range = 0; range < kRanges.size(); ++range) {
        const std::string prefix = kRanges[range];
        uniform.v[range * 4] = static_cast<float>(param(op, (prefix + "Hue").c_str()));
        uniform.v[(range * 4) + 1] =
            static_cast<float>(param(op, (prefix + "Saturation").c_str()) / 100.0);
        uniform.v[(range * 4) + 2] =
            static_cast<float>(param(op, (prefix + "Luminance").c_str()) / 100.0);
      }
      uniform.v[16] = static_cast<float>(param(op, "blending", 50.0) / 100.0);
      uniform.v[17] = static_cast<float>(param(op, "balance") / 100.0);
      return uniform;
    }
    case OpKind::LensVignetting:
      uniform.v[0] = static_cast<float>(param(op, "vignetting") / 100.0);
      return uniform;
    case OpKind::Vignette:
      uniform.v[0] = static_cast<float>(param(op, "amount") / 100.0);
      uniform.v[1] = static_cast<float>(param(op, "midpoint", 50.0) / 100.0);
      uniform.v[2] = static_cast<float>(param(op, "feather", 50.0) / 100.0);
      uniform.v[3] = static_cast<float>(param(op, "roundness") / 100.0);
      uniform.v[4] = static_cast<float>(param(op, "highlights") / 100.0);
      return uniform;
    case OpKind::Grain:
      uniform.v[0] = static_cast<float>(param(op, "amount") / 100.0);
      uniform.v[1] = static_cast<float>(param(op, "size", 25.0) / 100.0);
      uniform.v[2] = static_cast<float>(param(op, "roughness", 50.0) / 100.0);
      return uniform;
    case OpKind::Texture:
      uniform.v[0] = static_cast<float>(param(op, "value") / 100.0);
      uniform.v[24] = 2;
      return uniform;
    case OpKind::Clarity:
      uniform.v[0] = static_cast<float>(param(op, "value") / 100.0);
      uniform.v[24] = static_cast<float>(std::clamp(short_edge * 0.02, 3.0, 12.0));
      return uniform;
    case OpKind::Dehaze:
      uniform.v[0] = static_cast<float>(param(op, "value") / 100.0);
      // The airlight a dark-channel prior divides out. Estimating it per frame would cost
      // a readback; diffuse white is close enough for a preview.
      uniform.v[1] = 0.9F;
      // A small patch: the wider the dark-channel window, the wider the halo it leaves.
      uniform.v[24] = static_cast<float>(std::clamp(short_edge * 0.005, 2.0, 5.0));
      return uniform;
    case OpKind::NoiseReduction:
      uniform.v[0] = static_cast<float>(param(op, "luminance") / 100.0);
      uniform.v[1] = static_cast<float>(param(op, "detail", 50.0) / 100.0);
      uniform.v[2] = static_cast<float>(param(op, "contrast") / 100.0);
      uniform.v[24] = 3;
      return uniform;
    case OpKind::ColorNoiseReduction:
      uniform.v[0] = static_cast<float>(param(op, "amount") / 100.0);
      uniform.v[1] = static_cast<float>(param(op, "detail", 50.0) / 100.0);
      uniform.v[2] = static_cast<float>(param(op, "smoothness", 50.0) / 100.0);
      uniform.v[24] = static_cast<float>(2.0 + (param(op, "smoothness", 50.0) / 100.0 * 6.0));
      return uniform;
    case OpKind::Sharpening:
      uniform.v[0] = static_cast<float>(param(op, "amount") / 100.0);
      uniform.v[1] = static_cast<float>(param(op, "detail", 25.0) / 100.0);
      uniform.v[2] = static_cast<float>(param(op, "masking") / 100.0);
      uniform.v[24] = static_cast<float>(std::max(param(op, "radius", 1.0), 0.5));
      return uniform;
    case OpKind::Defringe: {
      // The two hue sliders are 0..100 across the purple (240..330) and green (60..150)
      // parts of the wheel, which is the span Lightroom's fringe selector covers.
      uniform.v[0] = static_cast<float>(param(op, "purpleAmount") / 100.0);
      uniform.v[1] = static_cast<float>(240.0 + (param(op, "purpleHueLow", 30.0) * 0.9));
      uniform.v[2] = static_cast<float>(240.0 + (param(op, "purpleHueHigh", 70.0) * 0.9));
      uniform.v[4] = static_cast<float>(param(op, "greenAmount") / 100.0);
      uniform.v[5] = static_cast<float>(60.0 + (param(op, "greenHueLow", 40.0) * 0.9));
      uniform.v[6] = static_cast<float>(60.0 + (param(op, "greenHueHigh", 60.0) * 0.9));
      return uniform;
    }
    case OpKind::ChromaticAberration:
      uniform.v[24] = 2;
      return uniform;
    default:
      break;
  }
  const double value = param(op, "value");
  uniform.v[0] = static_cast<float>(kind == OpKind::Exposure ? value : value / 100.0);
  return uniform;
}

// Which branch of mask.wgsl rasterises this kind. Brush and every AI kind arrive as an
// uploaded raster, so they share one branch.
MaskPass mask_pass_kind(MaskKind kind) {
  switch (kind) {
    case MaskKind::Linear:
      return MaskPass::Linear;
    case MaskKind::Radial:
      return MaskPass::Radial;
    case MaskKind::Luminance:
      return MaskPass::Luminance;
    case MaskKind::Color:
      return MaskPass::Color;
    default:
      return MaskPass::Raster;
  }
}

CombineMode combine_mode(MaskMode mode) {
  switch (mode) {
    case MaskMode::Subtract:
      return CombineMode::Subtract;
    case MaskMode::Intersect:
      return CombineMode::Intersect;
    default:
      return CombineMode::Add;
  }
}

// Oklab from linear sRGB, the same transform shaders/mask.wgsl uses. Colour samples are
// converted here so the shader compares two points instead of transforming per pixel.
std::array<float, 3> linear_to_oklab(double red, double green, double blue) {
  const double l = (0.4122214708 * red) + (0.5363325363 * green) + (0.0514459929 * blue);
  const double m = (0.2119034982 * red) + (0.6806995451 * green) + (0.1073969566 * blue);
  const double s = (0.0883024619 * red) + (0.2817188376 * green) + (0.6299787005 * blue);
  const double lr = std::cbrt(std::max(l, 0.0));
  const double mr = std::cbrt(std::max(m, 0.0));
  const double sr = std::cbrt(std::max(s, 0.0));
  return {static_cast<float>((0.2104542553 * lr) + (0.7936177850 * mr) - (0.0040720468 * sr)),
          static_cast<float>((1.9779984951 * lr) - (2.4285922050 * mr) + (0.4505937099 * sr)),
          static_cast<float>((0.0259040371 * lr) + (0.7827717662 * mr) - (0.8086757660 * sr))};
}

double component_number(const nlohmann::json& params, const char* key, double fallback) {
  const auto found = params.find(key);
  if (found == params.end() || !found->is_number()) return fallback;
  return found->get<double>();
}

std::array<double, 2> component_pair(const nlohmann::json& params, const char* key, double x,
                                     double y) {
  const auto found = params.find(key);
  if (found == params.end() || !found->is_array() || found->size() != 2) return {x, y};
  return {(*found)[0].get<double>(), (*found)[1].get<double>()};
}

MaskUniform mask_uniform(const MaskComponent& component, const GeometryMap& map) {
  MaskUniform uniform;
  uniform.kind = static_cast<uint32_t>(mask_pass_kind(component.kind));
  uniform.invert = component.invert ? 1U : 0U;
  uniform.feather = static_cast<float>(component.feather / 100.0);
  uniform.opacity = static_cast<float>(component.opacity / 100.0);
  uniform.origin[0] = static_cast<float>(map.content.x);
  uniform.origin[1] = static_cast<float>(map.content.y);
  uniform.size[0] = static_cast<float>(map.content.width);
  uniform.size[1] = static_cast<float>(map.content.height);
  for (int i = 0; i < 3; ++i) {
    uniform.m0[i] = static_cast<float>(map.view_to_working[i]);
    uniform.m1[i] = static_cast<float>(map.view_to_working[3 + i]);
    uniform.m2[i] = static_cast<float>(map.view_to_working[6 + i]);
  }
  uniform.geom[0] = static_cast<float>(map.distortion_k);
  uniform.geom[1] = static_cast<float>(map.work_aspect);
  uniform.geom[2] = static_cast<float>(map.quadrant);
  uniform.geom[3] = static_cast<float>(map.image_aspect);
  uniform.flip[0] = map.flip_horizontal ? -1.0F : 1.0F;
  uniform.flip[1] = map.flip_vertical ? -1.0F : 1.0F;

  switch (component.kind) {
    case MaskKind::Linear: {
      const auto start = component_pair(component.params, "start", 0.5, 0.0);
      const auto end = component_pair(component.params, "end", 0.5, 1.0);
      uniform.v[0] = static_cast<float>(start[0]);
      uniform.v[1] = static_cast<float>(start[1]);
      uniform.v[2] = static_cast<float>(end[0]);
      uniform.v[3] = static_cast<float>(end[1]);
      return uniform;
    }
    case MaskKind::Radial: {
      const auto centre = component_pair(component.params, "center", 0.5, 0.5);
      const auto radius = component_pair(component.params, "radius", 0.3, 0.3);
      uniform.v[0] = static_cast<float>(centre[0]);
      uniform.v[1] = static_cast<float>(centre[1]);
      uniform.v[2] = static_cast<float>(radius[0]);
      uniform.v[3] = static_cast<float>(radius[1]);
      uniform.v[4] = static_cast<float>(component_number(component.params, "angle", 0.0) *
                                        std::numbers::pi / 180.0);
      return uniform;
    }
    case MaskKind::Luminance: {
      const auto range = component_pair(component.params, "range", 0.5, 1.0);
      uniform.v[0] = static_cast<float>(range[0]);
      uniform.v[1] = static_cast<float>(range[1]);
      uniform.v[2] = static_cast<float>(component_number(component.params, "smoothness", 0.1));
      return uniform;
    }
    case MaskKind::Color: {
      const auto samples = component.params.find("samples");
      size_t count = 0;
      if (samples != component.params.end() && samples->is_array()) {
        for (const nlohmann::json& sample : *samples) {
          if (count >= 5) break;
          const std::array<float, 3> lab = linear_to_oklab(
              sample[0].get<double>(), sample[1].get<double>(), sample[2].get<double>());
          uniform.v[((count + 1) * 4) + 0] = lab[0];
          uniform.v[((count + 1) * 4) + 1] = lab[1];
          uniform.v[((count + 1) * 4) + 2] = lab[2];
          ++count;
        }
      }
      uniform.v[0] = static_cast<float>(count);
      uniform.v[1] = static_cast<float>(component_number(component.params, "range", 0.2));
      uniform.v[2] = static_cast<float>(component_number(component.params, "smoothness", 0.1));
      return uniform;
    }
    default:
      // A brush's softness is already in its stamps (ops/mask_raster.cpp); blurring the
      // raster on top of that would feather it twice.
      if (component.kind == MaskKind::Brush) uniform.feather = 0;
      return uniform;
  }
}

// What invalidates a cached raster: the mask's own JSON, the view's size, the content rect
// inside it, the geometry stage that put it there, and the base it samples. The geometry is
// the whole point of image space — the coordinates no longer move when a crop does, but the
// *pixels* they land on do, so a straighten that leaves the content rect's size alone still
// has to re-rasterise. Luminance and colour components sample the view's base, the photo
// before any op, as Lightroom's range masks do (issue #1): nothing in the stack can make
// them stale, so the key only needs to know when the base itself was redrawn.
std::string mask_cache_key(const nlohmann::json& canonical, const GeometryMap& map,
                           const GeometryParams& params, const ViewGeometry& geometry,
                           uint64_t base_generation) {
  const nlohmann::json keyed = {
      {"m", canonical},
      {"r", {map.content.x, map.content.y, map.content.width, map.content.height}},
      {"g", geometry_to_json(params)},
      {"b", base_generation}};
  return mask_hash(keyed, geometry.width, geometry.height);
}

// Brush strokes and model rasters are stored in image space, so their size follows the
// photo's own aspect and not the cropped content rect: the same buffer serves every crop.
// It is the fit of the photo into the view's box — the resolution the user would see with
// nothing cropped — and the shader samples it bilinearly, so a zoomed 1:1 view upsamples
// it rather than paying to rebuild it on every zoom step.
std::array<uint32_t, 2> image_raster_size(uint32_t photo_width, uint32_t photo_height,
                                          uint32_t view_width, uint32_t view_height) {
  const double aspect =
      static_cast<double>(std::max(1U, photo_width)) / std::max(1U, photo_height);
  double width = view_width;
  double height = width / aspect;
  if (height > view_height) {
    height = view_height;
    width = height * aspect;
  }
  return {std::max(1U, static_cast<uint32_t>(std::lround(width))),
          std::max(1U, static_cast<uint32_t>(std::lround(height)))};
}

WGPUBindGroupEntry texture_entry(uint32_t binding, WGPUTextureView view) {
  WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
  entry.binding = binding;
  entry.textureView = view;
  return entry;
}

WGPUBindGroupEntry buffer_entry(uint32_t binding, WGPUBuffer buffer, uint64_t offset,
                                uint64_t size) {
  WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
  entry.binding = binding;
  entry.buffer = buffer;
  entry.offset = offset;
  entry.size = size;
  return entry;
}

}  // namespace

OpKind op_kind(std::string_view name) {
  if (name == "white_balance") return OpKind::WhiteBalance;
  if (name == "exposure") return OpKind::Exposure;
  if (name == "contrast") return OpKind::Contrast;
  if (name == "highlights") return OpKind::Highlights;
  if (name == "shadows") return OpKind::Shadows;
  if (name == "whites") return OpKind::Whites;
  if (name == "blacks") return OpKind::Blacks;
  if (name == "saturation") return OpKind::Saturation;
  if (name == "vibrance") return OpKind::Vibrance;
  if (name == "tone_curve") return OpKind::ToneCurve;
  if (name == "color_mixer") return OpKind::ColorMixer;
  if (name == "color_grading") return OpKind::ColorGrading;
  // Only the vignetting half is a pass; the distortion half is geometry.
  if (name == "lens_correction") return OpKind::LensVignetting;
  if (name == "vignette") return OpKind::Vignette;
  if (name == "grain") return OpKind::Grain;
  if (name == "texture") return OpKind::Texture;
  if (name == "clarity") return OpKind::Clarity;
  if (name == "dehaze") return OpKind::Dehaze;
  if (name == "noise_reduction") return OpKind::NoiseReduction;
  if (name == "color_noise_reduction") return OpKind::ColorNoiseReduction;
  if (name == "sharpening") return OpKind::Sharpening;
  if (name == "defringe") return OpKind::Defringe;
  if (name == "chromatic_aberration") return OpKind::ChromaticAberration;
  if (name == "crop" || name == "rotate" || name == "flip" || name == "transform") {
    return OpKind::Geometry;
  }
  if (is_generative_op(name)) return OpKind::Generative;
  return OpKind::None;
}

struct Renderer::Photo {
  uint32_t width = 0;
  uint32_t height = 0;
  TextureHandle linear;
  TextureViewHandle linear_view;
  // AI mask rasters by componentId: written by mask.detect, reloaded from the PNG cache
  // at photo.open, shared by every view of this photo.
  std::unordered_map<std::string, StoredRaster> rasters;
  // Generative results by opId. Unlike a mask raster these are uploaded once at their own
  // resolution and sampled through the composite's rect, so no view holds a copy.
  std::unordered_map<std::string, StoredResult> results;
};

struct Renderer::View {
  int64_t photo_id = 0;
  ViewGeometry geometry;
  bool base_valid = false;
  // Bumped every time `base` is redrawn; range masks sample it, so it is in their cache key.
  uint64_t base_generation = 0;
  GeometryParams geometry_params;
  // What the user asked to look at, and the stage resolved for it: every mask pass, every
  // op pass and the `imageTransform` on the wire read this one object.
  Viewport viewport;
  GeometryMap map;
  TextureHandle base;
  TextureViewHandle base_view;
  TextureHandle ping[2];
  TextureViewHandle ping_view[2];
  TextureHandle scratch;
  TextureViewHandle scratch_view;
  TextureHandle output;
  TextureViewHandle output_view;
  BufferHandle fit_uniform;
  BufferHandle frame_uniform;
  BufferHandle op_uniforms;
  BufferHandle curve_uniforms;
  uint32_t op_capacity = 0;
  uint32_t curve_capacity = 0;
  // One entry per masked op, keyed by opId and invalidated by the mask's hash.
  std::unordered_map<std::string, MaskEntry> masks;
};

Renderer::Renderer(uint32_t max_texture_dim) : gpu_(max_texture_dim) {
  const ShaderModuleHandle linearize = gpu_.create_shader(shaders::kLinearize, "linearize");
  const ShaderModuleHandle downscale = gpu_.create_shader(shaders::kDownscale, "downscale");
  const ShaderModuleHandle ops = gpu_.create_shader(shaders::kOps, "ops");
  const ShaderModuleHandle blur = gpu_.create_shader(shaders::kBlur, "blur");
  const ShaderModuleHandle neighborhood =
      gpu_.create_shader(shaders::kNeighborhood, "neighborhood");
  const ShaderModuleHandle display = gpu_.create_shader(shaders::kDisplay, "display");
  linearize_pipeline_ =
      gpu_.create_fullscreen_pipeline(linearize.get(), WGPUTextureFormat_RGBA16Float, "linearize");
  downscale_pipeline_ =
      gpu_.create_fullscreen_pipeline(downscale.get(), WGPUTextureFormat_RGBA16Float, "downscale");
  ops_pipeline_ = gpu_.create_fullscreen_pipeline(ops.get(), WGPUTextureFormat_RGBA16Float, "ops");
  blur_pipeline_ =
      gpu_.create_fullscreen_pipeline(blur.get(), WGPUTextureFormat_RGBA16Float, "blur");
  neighborhood_pipeline_ = gpu_.create_fullscreen_pipeline(
      neighborhood.get(), WGPUTextureFormat_RGBA16Float, "neighborhood");
  display_pipeline_ =
      gpu_.create_fullscreen_pipeline(display.get(), WGPUTextureFormat_RGBA8Unorm, "display");

  const ShaderModuleHandle mask = gpu_.create_shader(shaders::kMask, "mask");
  const ShaderModuleHandle mask_combine = gpu_.create_shader(shaders::kMaskCombine, "mask-combine");
  mask_pipeline_ = gpu_.create_fullscreen_pipeline(mask.get(), WGPUTextureFormat_R8Unorm, "mask");
  mask_combine_pipeline_ = gpu_.create_fullscreen_pipeline(
      mask_combine.get(), WGPUTextureFormat_R8Unorm, "mask-combine");

  const ShaderModuleHandle composite = gpu_.create_shader(shaders::kComposite, "composite");
  composite_pipeline_ = gpu_.create_fullscreen_pipeline(
      composite.get(), WGPUTextureFormat_RGBA16Float, "composite");

  const auto sampled =
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
  const uint8_t white = 255;
  const uint8_t black = 0;
  white_mask_ = gpu_.create_texture(1, 1, WGPUTextureFormat_R8Unorm, sampled, "mask-white");
  gpu_.write_texture(white_mask_.get(), 1, 1, 1, &white, 1);
  white_mask_view_.reset(wgpuTextureCreateView(white_mask_.get(), nullptr));
  empty_mask_ = gpu_.create_texture(1, 1, WGPUTextureFormat_R8Unorm, sampled, "mask-empty");
  gpu_.write_texture(empty_mask_.get(), 1, 1, 1, &black, 1);
  empty_mask_view_.reset(wgpuTextureCreateView(empty_mask_.get(), nullptr));

  combine_uniforms_ = gpu_.create_uniform_buffer(kOpUniformStride * kCombineModes, "mask-modes");
  for (uint32_t mode = 0; mode < kCombineModes; ++mode) {
    const CombineUniform uniform{mode, {0, 0, 0}};
    gpu_.write_buffer(combine_uniforms_.get(), kOpUniformStride * mode, &uniform, sizeof(uniform));
  }
}

Renderer::~Renderer() {
  views_.clear();
  photos_.clear();
}

void Renderer::load_photo(int64_t photo_id, const DecodedRaw& raw) {
  auto photo = std::make_unique<Photo>();
  photo->width = raw.width;
  photo->height = raw.height;

  const TextureHandle camera = gpu_.create_texture(
      raw.width, raw.height, WGPUTextureFormat_RGBA16Uint,
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst),
      "camera-rgba16uint");
  gpu_.write_texture(camera.get(), raw.width, raw.height, 8, raw.rgba.data(), raw.rgba.size() * 2);
  const TextureViewHandle camera_view(wgpuTextureCreateView(camera.get(), nullptr));

  photo->linear =
      gpu_.create_texture(raw.width, raw.height, WGPUTextureFormat_RGBA16Float,
                          static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment |
                                                        WGPUTextureUsage_TextureBinding),
                          "linear-rgba16float");
  photo->linear_view.reset(wgpuTextureCreateView(photo->linear.get(), nullptr));

  const std::array<WGPUBindGroupEntry, 1> entries = {texture_entry(0, camera_view.get())};
  const BindGroupHandle bind_group = gpu_.create_bind_group(linearize_pipeline_.get(), entries);
  WGPUCommandEncoder encoder = gpu_.begin_commands("linearize");
  gpu_.encode_fullscreen_pass(encoder, linearize_pipeline_.get(), bind_group.get(),
                              photo->linear_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();

  photos_[photo_id] = std::move(photo);
}

void Renderer::unload_photo(int64_t photo_id) {
  close_views_of_photo(photo_id);
  photos_.erase(photo_id);
}

bool Renderer::has_photo(int64_t photo_id) const {
  return photos_.contains(photo_id);
}

void Renderer::open_view(uint32_t view_id, int64_t photo_id, uint32_t width, uint32_t height) {
  if (!photos_.contains(photo_id)) throw std::runtime_error("view.open on an unknown photo");
  auto view = std::make_unique<View>();
  view->photo_id = photo_id;
  view->fit_uniform = gpu_.create_uniform_buffer(sizeof(FitUniform), "fit");
  view->frame_uniform = gpu_.create_uniform_buffer(sizeof(FrameUniform), "frame");
  // The curve binding is part of every op pass's layout, so there is always one slot to
  // point it at, whether or not the stack holds a tone curve.
  view->curve_uniforms = gpu_.create_uniform_buffer(kCurveSlotStride, "curves");
  view->curve_capacity = 1;
  views_[view_id] = std::move(view);
  resize_view(view_id, width, height);
}

void Renderer::close_view(uint32_t view_id) {
  views_.erase(view_id);
}

void Renderer::close_views_of_photo(int64_t photo_id) {
  for (auto entry = views_.begin(); entry != views_.end();) {
    if (entry->second->photo_id != photo_id) {
      ++entry;
    } else {
      entry = views_.erase(entry);
    }
  }
}

bool Renderer::has_view(uint32_t view_id) const {
  return views_.contains(view_id);
}

int64_t Renderer::view_photo(uint32_t view_id) const {
  return views_.at(view_id)->photo_id;
}

ViewGeometry Renderer::view_geometry(uint32_t view_id) const {
  return views_.at(view_id)->geometry;
}

Renderer::View& Renderer::view_for(uint32_t view_id) {
  const auto found = views_.find(view_id);
  if (found == views_.end()) throw std::runtime_error("unknown viewId");
  return *found->second;
}

void Renderer::resize_view(uint32_t view_id, uint32_t width, uint32_t height) {
  View& view = view_for(view_id);
  if (view.geometry.width == width && view.geometry.height == height && view.base_valid) return;
  const uint32_t limit = gpu_.report().max_texture_dimension_2d;
  if (width == 0 || height == 0 || width > limit || height > limit) {
    throw std::runtime_error("view size out of range");
  }

  view.geometry.width = width;
  view.geometry.height = height;
  const auto usage = static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment |
                                                   WGPUTextureUsage_TextureBinding);
  view.base = gpu_.create_texture(width, height, WGPUTextureFormat_RGBA16Float, usage, "view-base");
  view.base_view.reset(wgpuTextureCreateView(view.base.get(), nullptr));
  for (int i = 0; i < 2; ++i) {
    view.ping[i] =
        gpu_.create_texture(width, height, WGPUTextureFormat_RGBA16Float, usage, "view-ping");
    view.ping_view[i].reset(wgpuTextureCreateView(view.ping[i].get(), nullptr));
  }
  view.scratch =
      gpu_.create_texture(width, height, WGPUTextureFormat_RGBA16Float, usage, "view-scratch");
  view.scratch_view.reset(wgpuTextureCreateView(view.scratch.get(), nullptr));
  view.output = gpu_.create_texture(
      width, height, WGPUTextureFormat_RGBA8Unorm,
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc),
      "view-output");
  view.output_view.reset(wgpuTextureCreateView(view.output.get(), nullptr));
  view.base_valid = false;
  build_base(view);
}

void Renderer::build_base(View& view) {
  const Photo& photo = *photos_.at(view.photo_id);
  view.map = geometry_map(view.geometry_params, photo.width, photo.height, view.geometry.width,
                          view.geometry.height, view.viewport);

  ViewGeometry& geometry = view.geometry;
  geometry.content_x = view.map.content.x;
  geometry.content_y = view.map.content.y;
  geometry.content_width = view.map.content.width;
  geometry.content_height = view.map.content.height;

  const bool turned = (view.geometry_params.quadrant % 2) != 0;
  const double work_width = turned ? photo.height : photo.width;
  const double work_height = turned ? photo.width : photo.height;
  const double crop_width = view.geometry_params.right - view.geometry_params.left;
  const double crop_height = view.geometry_params.bottom - view.geometry_params.top;
  const double scale = std::max(view.geometry_params.scale, 1.0) / 100.0;

  FitUniform fit;
  const double source_scale_x = turned ? (work_height * crop_height) / geometry.content_height
                                       : (work_width * crop_width) / geometry.content_width;
  const double source_scale_y = turned ? (work_width * crop_width) / geometry.content_width
                                       : (work_height * crop_height) / geometry.content_height;
  fit.scale[0] = static_cast<float>(source_scale_x / scale);
  fit.scale[1] = static_cast<float>(source_scale_y / scale);
  fit.taps[0] = std::clamp(std::floor(fit.scale[0]), 1.0F, 16.0F);
  fit.taps[1] = std::clamp(std::floor(fit.scale[1]), 1.0F, 16.0F);
  fit.size[0] = static_cast<float>(photo.width);
  fit.size[1] = static_cast<float>(photo.height);
  fit.origin[0] = static_cast<float>(geometry.content_x);
  fit.origin[1] = static_cast<float>(geometry.content_y);
  fit.extent[0] = static_cast<float>(geometry.content_width);
  fit.extent[1] = static_cast<float>(geometry.content_height);
  fit.flip[0] = view.geometry_params.flip_horizontal ? -1.0F : 1.0F;
  fit.flip[1] = view.geometry_params.flip_vertical ? -1.0F : 1.0F;
  // The pass walks destination pixels and asks where each came from, which is exactly the
  // content-normalised half of the map (ops/geometry.cpp); it does its own origin/extent
  // subtraction, so the matrix it wants is the one without them folded in.
  const Mat3 matrix = mat3_multiply(
      view.map.view_to_working,
      Mat3{static_cast<double>(geometry.content_width), 0, static_cast<double>(geometry.content_x),
           0, static_cast<double>(geometry.content_height),
           static_cast<double>(geometry.content_y), 0, 0, 1});
  for (int i = 0; i < 3; ++i) {
    fit.m0[i] = static_cast<float>(matrix[i]);
    fit.m1[i] = static_cast<float>(matrix[3 + i]);
    fit.m2[i] = static_cast<float>(matrix[6 + i]);
  }
  fit.params[0] = static_cast<float>(view.map.distortion_k);
  fit.params[1] = static_cast<float>(view.map.work_aspect);
  fit.params[2] = static_cast<float>(view.geometry_params.quadrant);
  gpu_.write_buffer(view.fit_uniform.get(), 0, &fit, sizeof(fit));

  FrameUniform frame;
  frame.content_min[0] = static_cast<float>(geometry.content_x);
  frame.content_min[1] = static_cast<float>(geometry.content_y);
  frame.content_max[0] = static_cast<float>(geometry.content_x + geometry.content_width);
  frame.content_max[1] = static_cast<float>(geometry.content_y + geometry.content_height);
  gpu_.write_buffer(view.frame_uniform.get(), 0, &frame, sizeof(frame));

  const std::array<WGPUBindGroupEntry, 2> entries = {
      texture_entry(0, photo.linear_view.get()),
      buffer_entry(1, view.fit_uniform.get(), 0, sizeof(FitUniform))};
  const BindGroupHandle bind_group = gpu_.create_bind_group(downscale_pipeline_.get(), entries);
  WGPUCommandEncoder encoder = gpu_.begin_commands("downscale");
  gpu_.encode_fullscreen_pass(encoder, downscale_pipeline_.get(), bind_group.get(),
                              view.base_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();
  view.base_valid = true;
  ++view.base_generation;
}

struct Renderer::Pass {
  OpKind kind = OpKind::None;
  OpUniform uniform;
  int curve_slot = 0;
  const Op* op = nullptr;
  // Empty when the op has no mask; otherwise the canonical mask JSON and its cache key.
  nlohmann::json mask_json;
  std::string mask_hash;
  bool mask_dirty = false;
  WGPUTextureView mask_view = nullptr;
  // A generative op's uploaded result, or null when the engine has not been handed one.
  WGPUTextureView result_view = nullptr;
};

void Renderer::build_mask(View& view, const Op& op, const nlohmann::json& canonical,
                          const std::string& hash) {
  const Mask mask = mask_from_json(canonical);
  const Photo& photo = *photos_.at(view.photo_id);
  MaskEntry& entry = view.masks[op.id];
  const uint32_t width = view.geometry.width;
  const uint32_t height = view.geometry.height;
  const auto usage =
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment |
                                    WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc);
  if (entry.width != width || entry.height != height) {
    entry.components.clear();
    for (int i = 0; i < 2; ++i) {
      entry.accum[i] =
          gpu_.create_texture(width, height, WGPUTextureFormat_R8Unorm, usage, "mask-accum");
      entry.accum_view[i].reset(wgpuTextureCreateView(entry.accum[i].get(), nullptr));
    }
    entry.width = width;
    entry.height = height;
  }

  // A pending or failed component contributes nothing, and so does an AI component whose
  // raster this engine has not been handed — binding the white placeholder for it would
  // select the whole frame, which is the opposite of "not ready yet".
  std::vector<const MaskComponent*> active;
  for (const MaskComponent& component : mask.components) {
    if (!component.contributes()) continue;
    if (mask_kind_is_ai(component.kind) && !photo.rasters.contains(component.id)) continue;
    active.push_back(&component);
  }
  if (mask_uniform_capacity_ < active.size()) {
    mask_uniforms_ =
        gpu_.create_uniform_buffer(kOpUniformStride * std::max<size_t>(active.size(), 1), "masks");
    mask_uniform_capacity_ = static_cast<uint32_t>(active.size());
  }

  // Brush stroke lists and model rasters become r8 uploads before anything is encoded: a
  // queue write between two render passes of the same encoder is not ordered against them.
  const std::array<uint32_t, 2> raster_size = image_raster_size(
      photo.width, photo.height, view.geometry.width, view.geometry.height);
  for (const MaskComponent* component : active) {
    if (mask_pass_kind(component->kind) != MaskPass::Raster) continue;
    MaskComponentTexture& texture = entry.components[component->id];
    GrayImage image;
    std::string source_key;
    if (component->kind == MaskKind::Brush) {
      // No geometry in this key: the stroke list is in image space, so a crop or a zoom
      // re-renders the pass below but never re-stamps the strokes.
      source_key = mask_hash(component->params, raster_size[0], raster_size[1]);
      if (texture.source_hash == source_key) continue;
      image = rasterize_brush(brush_strokes(component->params), component->feather,
                              raster_size[0], raster_size[1]);
    } else {
      const StoredRaster& stored = photo.rasters.at(component->id);
      source_key = stored.hash + "@" + std::to_string(raster_size[0]) + "x" +
                   std::to_string(raster_size[1]);
      if (texture.source_hash == source_key) continue;
      image = resample_gray(stored.image, raster_size[0], raster_size[1]);
    }
    texture.source = gpu_.create_texture(
        image.width, image.height, WGPUTextureFormat_R8Unorm,
        static_cast<WGPUTextureUsage>(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst),
        "mask-source");
    gpu_.write_texture(texture.source.get(), image.width, image.height, 1, image.pixels.data(),
                       image.pixels.size());
    texture.source_view.reset(wgpuTextureCreateView(texture.source.get(), nullptr));
    texture.source_hash = source_key;
    // A new upload invalidates the raster that was rendered from the old one.
    texture.hash.clear();
  }

  std::vector<BindGroupHandle> keep;
  WGPUCommandEncoder encoder = gpu_.begin_commands("mask-build");
  int accum_index = 0;
  bool first = true;
  size_t slot = 0;
  for (const MaskComponent* component : active) {
    MaskComponentTexture& texture = entry.components[component->id];
    const std::string key =
        mask_cache_key(component_to_json(*component), view.map, view.geometry_params, view.geometry,
                       view.base_generation);
    if (!texture.texture) {
      texture.texture =
          gpu_.create_texture(width, height, WGPUTextureFormat_R8Unorm, usage, "mask-component");
      texture.view.reset(wgpuTextureCreateView(texture.texture.get(), nullptr));
      texture.hash.clear();
    }
    if (texture.hash != key) {
      const MaskUniform uniform = mask_uniform(*component, view.map);
      gpu_.write_buffer(mask_uniforms_.get(), kOpUniformStride * slot, &uniform, sizeof(uniform));
      WGPUTextureView raster =
          texture.source_view ? texture.source_view.get() : white_mask_view_.get();
      const std::array<WGPUBindGroupEntry, 3> entries = {
          texture_entry(0, view.base_view.get()),
          buffer_entry(1, mask_uniforms_.get(), kOpUniformStride * slot, sizeof(MaskUniform)),
          texture_entry(2, raster)};
      keep.push_back(gpu_.create_bind_group(mask_pipeline_.get(), entries));
      gpu_.encode_fullscreen_pass(encoder, mask_pipeline_.get(), keep.back().get(),
                                  texture.view.get());
      texture.hash = key;
      ++slot;
    }

    const CombineMode mode = first ? CombineMode::Replace : combine_mode(component->mode);
    const int target = first ? 0 : 1 - accum_index;
    WGPUTextureView above = first ? empty_mask_view_.get() : entry.accum_view[accum_index].get();
    const std::array<WGPUBindGroupEntry, 3> fold = {
        texture_entry(0, above), texture_entry(1, texture.view.get()),
        buffer_entry(2, combine_uniforms_.get(), kOpUniformStride * static_cast<uint32_t>(mode),
                     sizeof(CombineUniform))};
    keep.push_back(gpu_.create_bind_group(mask_combine_pipeline_.get(), fold));
    gpu_.encode_fullscreen_pass(encoder, mask_combine_pipeline_.get(), keep.back().get(),
                                entry.accum_view[target].get());
    accum_index = target;
    first = false;
  }
  if (first) {
    // Every component is still pending: the mask is empty, so the op does nothing.
    const std::array<WGPUBindGroupEntry, 3> fold = {
        texture_entry(0, empty_mask_view_.get()), texture_entry(1, empty_mask_view_.get()),
        buffer_entry(2, combine_uniforms_.get(), 0, sizeof(CombineUniform))};
    keep.push_back(gpu_.create_bind_group(mask_combine_pipeline_.get(), fold));
    gpu_.encode_fullscreen_pass(encoder, mask_combine_pipeline_.get(), keep.back().get(),
                                entry.accum_view[0].get());
  }
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();

  entry.final_index = accum_index;
  entry.hash = hash;
  std::erase_if(entry.components,
                [&mask](const auto& kept) { return find_component(mask, kept.first) == nullptr; });
}

WGPUTextureView Renderer::run_passes(View& view, const Stack& stack, bool bypass_crop) {
  // Geometry is not a pass: it changes where the proxy samples from and how big the image
  // rect is, so a change to it rebuilds the base. Everything else leaves the base alone.
  GeometryParams geometry_params = geometry_from_stack(stack);
  // The crop tool asks for the uncropped image so the user sees what is being cut away.
  // Only the crop op's own rect and straighten go; rotate, flip and Transform move the
  // whole image and stay. The flag is part of what `base_valid` is compared against, so
  // entering and leaving the tool each rebuild the base exactly once.
  if (bypass_crop) {
    geometry_params.left = 0;
    geometry_params.top = 0;
    geometry_params.right = 1;
    geometry_params.bottom = 1;
    geometry_params.angle = 0;
  }
  // The viewport is part of the stage: a zoom or a pan changes which source texels each
  // proxy pixel samples, so the base is resampled — one fullscreen pass, the same cost as
  // a window resize, and nothing above it in the chain notices.
  if (!view.base_valid || !(view.geometry_params == geometry_params)) {
    view.geometry_params = geometry_params;
    build_base(view);
  }

  // The stack is the user's order; the passes run in Lightroom's (PipelineStage in
  // ops/registry.h). A stable sort keeps two ops of the same stage in stack order.
  std::vector<const Op*> ordered;
  ordered.reserve(stack.size());
  for (const Op& op : stack) {
    if (op.enabled) ordered.push_back(&op);
  }
  std::stable_sort(ordered.begin(), ordered.end(), [](const Op* a, const Op* b) {
    const OpDefinition* left = find_op_definition(a->name);
    const OpDefinition* right = find_op_definition(b->name);
    const int left_stage = left == nullptr ? 0 : static_cast<int>(left->stage);
    const int right_stage = right == nullptr ? 0 : static_cast<int>(right->stage);
    return left_stage < right_stage;
  });

  std::vector<Pass> passes;
  std::vector<CurveTable> curves;
  for (const Op* op : ordered) {
    const OpKind kind = op_kind(op->name);
    if (kind == OpKind::None || kind == OpKind::Geometry) continue;
    if (is_neutral(*op, kind)) continue;
    Pass pass;
    pass.kind = kind;
    pass.op = op;
    if (kind == OpKind::ToneCurve) {
      CurveTable table{};
      if (!curve_table(*op, table)) continue;
      pass.curve_slot = static_cast<int>(curves.size());
      curves.push_back(table);
    }
    pass.uniform = op_uniform(*op, kind, view.geometry);
    pass.uniform.opacity = static_cast<float>(std::clamp(op->opacity, 0.0, kFullOpacity) / 100.0);
    // A generative op is a cached raster, so it draws nothing until a job has produced one
    // and the engine has been handed it. `result_rect` is normalised over the content rect,
    // which the viewport's zoom and pan scale along with everything else.
    if (kind == OpKind::Generative) {
      const Photo& photo = *photos_.at(view.photo_id);
      const auto stored = photo.results.find(op->id);
      const std::optional<GenerativeRect> rect = rect_from_json(op->result_rect);
      if (stored == photo.results.end() || stored->second.key != op->result) continue;
      if (!rect.has_value()) continue;
      pass.result_view = stored->second.view.get();
      const auto edge = [](double at, int32_t origin, uint32_t extent) {
        return static_cast<float>(origin + (at * extent));
      };
      pass.uniform.v[0] = edge(rect->x0, view.geometry.content_x, view.geometry.content_width);
      pass.uniform.v[1] = edge(rect->y0, view.geometry.content_y, view.geometry.content_height);
      pass.uniform.v[2] = edge(rect->x1, view.geometry.content_x, view.geometry.content_width);
      pass.uniform.v[3] = edge(rect->y1, view.geometry.content_y, view.geometry.content_height);
      pass.uniform.v[4] = static_cast<float>(stored->second.width);
      pass.uniform.v[5] = static_cast<float>(stored->second.height);
    }
    // An empty component list is not a mask: the op still applies everywhere, at its
    // opacity. A list whose components are all pending is, and rasterises to nothing.
    if (op->mask.has_value() && op->mask->contains("components") &&
        !(*op->mask)["components"].empty()) {
      pass.mask_json = *op->mask;
      pass.mask_hash = mask_cache_key(pass.mask_json, view.map, view.geometry_params, view.geometry,
                                      view.base_generation);
      const auto found = view.masks.find(op->id);
      pass.mask_dirty = found == view.masks.end() || found->second.hash != pass.mask_hash;
    }
    passes.push_back(std::move(pass));
  }

  if (view.op_capacity < passes.size()) {
    view.op_uniforms =
        gpu_.create_uniform_buffer(kOpUniformStride * std::max<size_t>(passes.size(), 1), "ops");
    view.op_capacity = static_cast<uint32_t>(passes.size());
  }
  if (view.curve_capacity < curves.size()) {
    view.curve_uniforms =
        gpu_.create_uniform_buffer(kCurveSlotStride * std::max<size_t>(curves.size(), 1), "curves");
    view.curve_capacity = static_cast<uint32_t>(curves.size());
  }
  for (size_t i = 0; i < passes.size(); ++i) {
    gpu_.write_buffer(view.op_uniforms.get(), kOpUniformStride * i, &passes[i].uniform,
                      sizeof(OpUniform));
  }
  for (size_t i = 0; i < curves.size(); ++i) {
    gpu_.write_buffer(view.curve_uniforms.get(), kCurveSlotStride * i, curves[i].data(),
                      kCurveSlotStride);
  }

  // Masks read the base, not the op's input, so every dirty one is built before the chain is
  // encoded and a mask edit never splits the render. A cached one costs nothing.
  for (const Pass& pass : passes) {
    if (!pass.mask_dirty) continue;
    build_mask(view, *pass.op, pass.mask_json, pass.mask_hash);
  }

  std::vector<BindGroupHandle> bind_groups;
  WGPUCommandEncoder encoder = gpu_.begin_commands("view-render");
  WGPUTextureView source = view.base_view.get();
  size_t target_index = 0;
  for (size_t i = 0; i < passes.size(); ++i) {
    Pass& pass = passes[i];
    pass.mask_view = white_mask_view_.get();
    if (!pass.mask_hash.empty()) {
      const MaskEntry& entry = view.masks.at(pass.op->id);
      pass.mask_view = entry.accum_view[entry.final_index].get();
    }

    const WGPUBindGroupEntry uniform =
        buffer_entry(1, view.op_uniforms.get(), kOpUniformStride * i, sizeof(OpUniform));
    // The generative composite mixes a cached raster in at this op's position instead of
    // computing anything (PROMPT.md 3.5). It has to be tested before the neighbourhood
    // branch, which claims every kind above Texture.
    if (pass.kind == OpKind::Generative) {
      const std::array<WGPUBindGroupEntry, 4> entries = {
          texture_entry(0, source), uniform, texture_entry(2, pass.result_view),
          texture_entry(3, pass.mask_view)};
      bind_groups.push_back(gpu_.create_bind_group(composite_pipeline_.get(), entries));
      WGPUTextureView target = view.ping_view[target_index % 2].get();
      gpu_.encode_fullscreen_pass(encoder, composite_pipeline_.get(), bind_groups.back().get(),
                                  target);
      source = target;
      ++target_index;
      continue;
    }
    if (pass.kind >= OpKind::Texture) {
      WGPUTextureView neighbours = source;
      if (needs_prepass(pass.kind)) {
        const std::array<WGPUBindGroupEntry, 2> blur_entries = {texture_entry(0, source), uniform};
        bind_groups.push_back(gpu_.create_bind_group(blur_pipeline_.get(), blur_entries));
        gpu_.encode_fullscreen_pass(encoder, blur_pipeline_.get(), bind_groups.back().get(),
                                    view.scratch_view.get());
        neighbours = view.scratch_view.get();
      }
      const std::array<WGPUBindGroupEntry, 4> entries = {
          texture_entry(0, source), texture_entry(1, neighbours),
          buffer_entry(2, view.op_uniforms.get(), kOpUniformStride * i, sizeof(OpUniform)),
          texture_entry(3, pass.mask_view)};
      bind_groups.push_back(gpu_.create_bind_group(neighborhood_pipeline_.get(), entries));
      WGPUTextureView target = view.ping_view[target_index % 2].get();
      gpu_.encode_fullscreen_pass(encoder, neighborhood_pipeline_.get(), bind_groups.back().get(),
                                  target);
      source = target;
      ++target_index;
      continue;
    }
    const std::array<WGPUBindGroupEntry, 4> entries = {
        texture_entry(0, source), uniform,
        buffer_entry(2, view.curve_uniforms.get(),
                     kCurveSlotStride * static_cast<uint64_t>(pass.curve_slot), kCurveSlotStride),
        texture_entry(3, pass.mask_view)};
    bind_groups.push_back(gpu_.create_bind_group(ops_pipeline_.get(), entries));
    WGPUTextureView target = view.ping_view[target_index % 2].get();
    gpu_.encode_fullscreen_pass(encoder, ops_pipeline_.get(), bind_groups.back().get(), target);
    source = target;
    ++target_index;
  }
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();
  return source;
}

void Renderer::set_viewport(uint32_t view_id, const Viewport& viewport) {
  View& view = view_for(view_id);
  if (view.viewport == viewport) return;
  view.viewport = viewport;
  view.base_valid = false;
}

Viewport Renderer::view_viewport(uint32_t view_id) const {
  return views_.at(view_id)->viewport;
}

GeometryMap Renderer::view_map(uint32_t view_id) const {
  return views_.at(view_id)->map;
}

void Renderer::put_mask_raster(int64_t photo_id, std::string_view component_id,
                               std::string_view hash, GrayImage raster) {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) return;
  StoredRaster& stored = found->second->rasters[std::string(component_id)];
  stored.hash = std::string(hash);
  stored.image = std::move(raster);
  // Every view holding an upload of the old raster has to redo it.
  for (auto& [view_id, view] : views_) {
    if (view->photo_id != photo_id) continue;
    for (auto& [op_id, entry] : view->masks) {
      entry.components.erase(std::string(component_id));
      entry.hash.clear();
    }
  }
}

bool Renderer::has_mask_raster(int64_t photo_id, std::string_view component_id,
                               std::string_view hash) const {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) return false;
  const auto stored = found->second->rasters.find(std::string(component_id));
  return stored != found->second->rasters.end() && stored->second.hash == hash;
}

void Renderer::put_generative_result(int64_t photo_id, std::string_view op_id,
                                     std::string_view key, const Rgb8Image& image) {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) return;
  if (image.width == 0 || image.height == 0) return;

  // The GPU wants four channels; the PNG a backend returns has three. One copy, once per
  // job, rather than a shader branch on every frame.
  std::vector<uint8_t> rgba(static_cast<size_t>(image.width) * image.height * 4, 255);
  for (size_t pixel = 0; pixel < static_cast<size_t>(image.width) * image.height; ++pixel) {
    rgba[pixel * 4] = image.pixels[pixel * 3];
    rgba[(pixel * 4) + 1] = image.pixels[(pixel * 3) + 1];
    rgba[(pixel * 4) + 2] = image.pixels[(pixel * 3) + 2];
  }

  StoredResult stored;
  stored.key = std::string(key);
  stored.width = image.width;
  stored.height = image.height;
  stored.texture = gpu_.create_texture(
      image.width, image.height, WGPUTextureFormat_RGBA8Unorm,
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst),
      "generative-result");
  gpu_.write_texture(stored.texture.get(), image.width, image.height, 4, rgba.data(), rgba.size());
  stored.view.reset(wgpuTextureCreateView(stored.texture.get(), nullptr));
  found->second->results[std::string(op_id)] = std::move(stored);
}

bool Renderer::has_generative_result(int64_t photo_id, std::string_view op_id,
                                     std::string_view key) const {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) return false;
  const auto stored = found->second->results.find(std::string(op_id));
  return stored != found->second->results.end() && stored->second.key == key;
}

MaskReadout Renderer::read_mask(uint32_t view_id, const Stack& stack, std::string_view op_id,
                                std::string_view component_id, std::vector<uint8_t>& out,
                                size_t offset) {
  View& view = view_for(view_id);
  run_passes(view, stack, false);

  const Op* op = find_op(stack, op_id);
  if (op == nullptr) throw std::runtime_error("unknown opId '" + std::string(op_id) + "'");
  if (!op->mask.has_value() || !op->mask->contains("components") ||
      (*op->mask)["components"].empty()) {
    throw std::runtime_error("op '" + std::string(op_id) + "' has no mask");
  }
  // A disabled or neutral op has no pass, so run_passes never built its mask; the overlay
  // still has to be able to show it.
  const std::string hash = mask_cache_key(*op->mask, view.map, view.geometry_params, view.geometry,
                                          view.base_generation);
  const auto found = view.masks.find(op->id);
  if (found == view.masks.end() || found->second.hash != hash) {
    build_mask(view, *op, *op->mask, hash);
  }

  const MaskEntry& entry = view.masks.at(op->id);
  WGPUTexture texture = entry.accum[entry.final_index].get();
  if (!component_id.empty()) {
    const auto component = entry.components.find(std::string(component_id));
    if (component == entry.components.end() || !component->second.texture) {
      throw std::runtime_error("component '" + std::string(component_id) + "' has no raster");
    }
    texture = component->second.texture.get();
  }

  const size_t bytes = static_cast<size_t>(entry.width) * entry.height;
  if (out.size() < offset + bytes) throw std::runtime_error("mask buffer too small");
  gpu_.read_texture(texture, entry.width, entry.height, 1,
                    std::span<uint8_t>(out.data() + offset, bytes));

  MaskReadout readout;
  readout.width = entry.width;
  readout.height = entry.height;
  // Over the image the user can actually see: zoomed in, the content rect runs off the
  // frame, and counting pixels that were never rendered would make every mask look empty.
  size_t inside = 0;
  size_t counted = 0;
  const int32_t x0 = std::max(view.geometry.content_x, 0);
  const int32_t y0 = std::max(view.geometry.content_y, 0);
  const auto x1 = static_cast<int32_t>(
      std::min<int64_t>(view.geometry.content_x + view.geometry.content_width, entry.width));
  const auto y1 = static_cast<int32_t>(
      std::min<int64_t>(view.geometry.content_y + view.geometry.content_height, entry.height));
  for (int32_t y = y0; y < y1; ++y) {
    for (int32_t x = x0; x < x1; ++x) {
      ++counted;
      if (out[offset + (static_cast<size_t>(y) * entry.width) + x] > 127) ++inside;
    }
  }
  readout.coverage =
      counted == 0 ? 0.0 : static_cast<double>(inside) / static_cast<double>(counted);
  return readout;
}

RenderTiming Renderer::render(uint32_t view_id, const Stack& stack, std::vector<uint8_t>& out,
                              size_t offset, bool bypass_crop) {
  using clock = std::chrono::steady_clock;
  View& view = view_for(view_id);
  const auto started = clock::now();

  WGPUTextureView source = run_passes(view, stack, bypass_crop);
  const std::array<WGPUBindGroupEntry, 2> display_entries = {
      texture_entry(0, source), buffer_entry(1, view.frame_uniform.get(), 0, sizeof(FrameUniform))};
  const BindGroupHandle display = gpu_.create_bind_group(display_pipeline_.get(), display_entries);
  WGPUCommandEncoder encoder = gpu_.begin_commands("view-display");
  gpu_.encode_fullscreen_pass(encoder, display_pipeline_.get(), display.get(),
                              view.output_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();
  const auto rendered = clock::now();

  const size_t bytes = static_cast<size_t>(view.geometry.width) * view.geometry.height * 4;
  if (out.size() < offset + bytes) throw std::runtime_error("frame buffer too small");
  gpu_.read_texture(view.output.get(), view.geometry.width, view.geometry.height, 4,
                    std::span<uint8_t>(out.data() + offset, bytes));
  const auto read = clock::now();

  RenderTiming timing;
  timing.render_ms = std::chrono::duration<double, std::milli>(rendered - started).count();
  timing.readback_ms = std::chrono::duration<double, std::milli>(read - rendered).count();
  return timing;
}

Rgb16Image Renderer::render_export(int64_t photo_id, const Stack& stack,
                                   const ExportRenderOptions& options) {
  const auto found = photos_.find(photo_id);
  if (found == photos_.end()) throw std::runtime_error("export on an unknown photo");
  const Photo& photo = *found->second;

  // The photo's native size *as the stack shows it*: the crop rect at sensor resolution,
  // with the axes swapped when a quadrant rotation turned it.
  const GeometryParams geometry_params = geometry_from_stack(stack);
  const bool turned = (geometry_params.quadrant % 2) != 0;
  const double work_width = turned ? photo.height : photo.width;
  const double work_height = turned ? photo.width : photo.height;
  const double native_width = work_width * (geometry_params.right - geometry_params.left);
  const double native_height = work_height * (geometry_params.bottom - geometry_params.top);

  // build_base letterboxes the content inside the frame, so asking for exactly the
  // content's own aspect is what makes the two the same rectangle — an export has no bars.
  const auto full_width = std::max(1U, static_cast<uint32_t>(std::lround(native_width)));
  const double content_aspect = native_width / std::max(native_height, 1.0);
  const auto full_height =
      std::max(1U, static_cast<uint32_t>(std::lround(full_width / content_aspect)));
  const uint32_t limit = gpu_.report().max_texture_dimension_2d;
  if (std::max(full_width, full_height) > limit) {
    throw std::runtime_error("export size exceeds the adapter's maxTextureDimension2D (" +
                             std::to_string(limit) + "); tiled export is not implemented");
  }

  const auto usage = static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment |
                                                   WGPUTextureUsage_TextureBinding);
  // A view of its own, never in views_: it lives for this call, so a 24 MP ping-pong is
  // not held against the next slider tick.
  View view;
  view.photo_id = photo_id;
  view.geometry.width = full_width;
  view.geometry.height = full_height;
  view.fit_uniform = gpu_.create_uniform_buffer(sizeof(FitUniform), "export-fit");
  view.frame_uniform = gpu_.create_uniform_buffer(sizeof(FrameUniform), "export-frame");
  view.curve_uniforms = gpu_.create_uniform_buffer(kCurveSlotStride, "export-curves");
  view.curve_capacity = 1;
  view.base = gpu_.create_texture(full_width, full_height, WGPUTextureFormat_RGBA16Float, usage,
                                  "export-base");
  view.base_view.reset(wgpuTextureCreateView(view.base.get(), nullptr));
  for (int i = 0; i < 2; ++i) {
    view.ping[i] = gpu_.create_texture(full_width, full_height, WGPUTextureFormat_RGBA16Float,
                                       usage, "export-ping");
    view.ping_view[i].reset(wgpuTextureCreateView(view.ping[i].get(), nullptr));
  }
  view.scratch = gpu_.create_texture(full_width, full_height, WGPUTextureFormat_RGBA16Float, usage,
                                     "export-scratch");
  view.scratch_view.reset(wgpuTextureCreateView(view.scratch.get(), nullptr));

  WGPUTextureView source = run_passes(view, stack, false);

  // The developed image is letterboxed inside the frame like any other view, so the resize
  // pass doubles as the crop that lifts it out: it always runs, and at 1:1 it is an exact
  // texel-for-texel copy of the content rect. That is cheaper to reason about than trying
  // to pick a frame size whose rounding leaves no bar.
  const int32_t content_x = view.geometry.content_x;
  const int32_t content_y = view.geometry.content_y;
  const uint32_t content_width = std::max(1U, view.geometry.content_width);
  const uint32_t content_height = std::max(1U, view.geometry.content_height);
  const ExportSize out = export_resize_fit(options.resize, content_width, content_height);
  if (std::max(out.width, out.height) > limit) {
    throw std::runtime_error("resized export exceeds the adapter's maxTextureDimension2D (" +
                             std::to_string(limit) + ")");
  }

  // Resize in linear light, before the output curve: the box filter is downscale.wgsl with
  // the content rect as its homography, so a resized export and a proxy of the same size
  // come out of the same code.
  const TextureHandle resized = gpu_.create_texture(
      out.width, out.height, WGPUTextureFormat_RGBA16Float, usage, "export-resized");
  const TextureViewHandle resized_view(wgpuTextureCreateView(resized.get(), nullptr));
  {
    FitUniform fit;
    fit.scale[0] = static_cast<float>(static_cast<double>(content_width) / out.width);
    fit.scale[1] = static_cast<float>(static_cast<double>(content_height) / out.height);
    // Upscaling leaves one tap, i.e. nearest neighbour. Enlarging past native is not what
    // an export is for; the clamp keeps it honest rather than pretending to interpolate.
    fit.taps[0] = std::clamp(std::floor(fit.scale[0]), 1.0F, 16.0F);
    fit.taps[1] = std::clamp(std::floor(fit.scale[1]), 1.0F, 16.0F);
    fit.size[0] = static_cast<float>(full_width);
    fit.size[1] = static_cast<float>(full_height);
    fit.extent[0] = static_cast<float>(out.width);
    fit.extent[1] = static_cast<float>(out.height);
    // Destination 0..1 -> the content rect, normalised over the frame texture. No rotation
    // or crop here: run_passes already applied the whole geometry stage.
    fit.m0[0] = static_cast<float>(static_cast<double>(content_width) / full_width);
    fit.m0[2] = static_cast<float>(static_cast<double>(content_x) / full_width);
    fit.m1[1] = static_cast<float>(static_cast<double>(content_height) / full_height);
    fit.m1[2] = static_cast<float>(static_cast<double>(content_y) / full_height);
    fit.params[1] = static_cast<float>(content_aspect);
    const BufferHandle resize_uniform =
        gpu_.create_uniform_buffer(sizeof(FitUniform), "export-resize");
    gpu_.write_buffer(resize_uniform.get(), 0, &fit, sizeof(fit));
    const std::array<WGPUBindGroupEntry, 2> entries = {
        texture_entry(0, source), buffer_entry(1, resize_uniform.get(), 0, sizeof(FitUniform))};
    const BindGroupHandle bind_group = gpu_.create_bind_group(downscale_pipeline_.get(), entries);
    WGPUCommandEncoder encoder = gpu_.begin_commands("export-resize");
    gpu_.encode_fullscreen_pass(encoder, downscale_pipeline_.get(), bind_group.get(),
                                resized_view.get());
    gpu_.submit(encoder);
    gpu_.wait_idle();
    gpu_.raise_pending_error();
    source = resized_view.get();
  }

  // Output sharpening is the last thing that touches pixel values, exactly as in
  // Lightroom: it is compensation for the output medium, not part of the develop.
  const SharpenSettings sharpen = export_sharpen_settings(options.sharpen);
  TextureHandle sharpen_blur;
  TextureViewHandle sharpen_blur_view;
  TextureHandle sharpened;
  TextureViewHandle sharpened_view;
  BufferHandle sharpen_uniform;
  if (sharpen.radius > 0 && sharpen.amount > 0) {
    OpUniform uniform;
    uniform.kind = static_cast<uint32_t>(OpKind::Sharpening);
    uniform.size[0] = static_cast<float>(out.width);
    uniform.size[1] = static_cast<float>(out.height);
    uniform.opacity = 1;
    uniform.v[0] = sharpen.amount;
    uniform.v[1] = 0.5F;  // detail: the middle of the develop op's own range
    uniform.v[2] = 0;     // masking off — output sharpening is uniform by definition
    uniform.v[24] = sharpen.radius;
    sharpen_uniform = gpu_.create_uniform_buffer(sizeof(OpUniform), "export-sharpen");
    gpu_.write_buffer(sharpen_uniform.get(), 0, &uniform, sizeof(uniform));
    sharpen_blur = gpu_.create_texture(out.width, out.height, WGPUTextureFormat_RGBA16Float, usage,
                                       "export-sharpen-blur");
    sharpen_blur_view.reset(wgpuTextureCreateView(sharpen_blur.get(), nullptr));
    sharpened = gpu_.create_texture(out.width, out.height, WGPUTextureFormat_RGBA16Float, usage,
                                    "export-sharpened");
    sharpened_view.reset(wgpuTextureCreateView(sharpened.get(), nullptr));

    const WGPUBindGroupEntry slot = buffer_entry(1, sharpen_uniform.get(), 0, sizeof(OpUniform));
    const std::array<WGPUBindGroupEntry, 2> blur_entries = {texture_entry(0, source), slot};
    const BindGroupHandle blur = gpu_.create_bind_group(blur_pipeline_.get(), blur_entries);
    const std::array<WGPUBindGroupEntry, 4> combine_entries = {
        texture_entry(0, source), texture_entry(1, sharpen_blur_view.get()),
        buffer_entry(2, sharpen_uniform.get(), 0, sizeof(OpUniform)),
        texture_entry(3, white_mask_view_.get())};
    const BindGroupHandle combine =
        gpu_.create_bind_group(neighborhood_pipeline_.get(), combine_entries);
    WGPUCommandEncoder encoder = gpu_.begin_commands("export-sharpen");
    gpu_.encode_fullscreen_pass(encoder, blur_pipeline_.get(), blur.get(), sharpen_blur_view.get());
    gpu_.encode_fullscreen_pass(encoder, neighborhood_pipeline_.get(), combine.get(),
                                sharpened_view.get());
    gpu_.submit(encoder);
    gpu_.wait_idle();
    gpu_.raise_pending_error();
    source = sharpened_view.get();
  }

  if (!export_pipeline_) {
    const ShaderModuleHandle shader = gpu_.create_shader(shaders::kExport, "export");
    export_pipeline_ =
        gpu_.create_fullscreen_pipeline(shader.get(), WGPUTextureFormat_RGBA16Uint, "export");
  }
  const ColorTransform transform = export_color_transform(options.color_space);
  ExportUniform colors;
  for (int i = 0; i < 3; ++i) {
    colors.m0[i] = transform.matrix[i];
    colors.m1[i] = transform.matrix[3 + i];
    colors.m2[i] = transform.matrix[6 + i];
  }
  colors.params[0] = transform.gamma;
  const BufferHandle color_uniform =
      gpu_.create_uniform_buffer(sizeof(ExportUniform), "export-colors");
  gpu_.write_buffer(color_uniform.get(), 0, &colors, sizeof(colors));

  const TextureHandle target = gpu_.create_texture(
      out.width, out.height, WGPUTextureFormat_RGBA16Uint,
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc),
      "export-target");
  const TextureViewHandle target_view(wgpuTextureCreateView(target.get(), nullptr));
  const std::array<WGPUBindGroupEntry, 2> entries = {
      texture_entry(0, source), buffer_entry(1, color_uniform.get(), 0, sizeof(ExportUniform))};
  const BindGroupHandle bind_group = gpu_.create_bind_group(export_pipeline_.get(), entries);
  WGPUCommandEncoder encoder = gpu_.begin_commands("export-transform");
  gpu_.encode_fullscreen_pass(encoder, export_pipeline_.get(), bind_group.get(), target_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();

  std::vector<uint8_t> rgba(static_cast<size_t>(out.width) * out.height * 8);
  gpu_.read_texture(target.get(), out.width, out.height, 8, rgba);

  Rgb16Image image;
  image.width = out.width;
  image.height = out.height;
  image.pixels.resize(image.expected_size());
  const auto* source_values = reinterpret_cast<const uint16_t*>(rgba.data());
  for (size_t pixel = 0; pixel < static_cast<size_t>(out.width) * out.height; ++pixel) {
    image.pixels[pixel * 3] = source_values[pixel * 4];
    image.pixels[(pixel * 3) + 1] = source_values[(pixel * 4) + 1];
    image.pixels[(pixel * 3) + 2] = source_values[(pixel * 4) + 2];
  }
  return image;
}

}  // namespace latent

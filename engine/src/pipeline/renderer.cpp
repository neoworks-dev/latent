#include "pipeline/renderer.h"

#include "image/png.h"
#include "ops/curve.h"
#include "ops/mask.h"
#include "ops/mask_raster.h"
#include "ops/registry.h"

#include <chrono>
#include <cmath>
#include <latent_shaders.h>

#include <algorithm>
#include <array>
#include <numbers>
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
  float v[24] = {};
};
static_assert(sizeof(MaskUniform) == 128, "must match MaskParams in mask.wgsl");

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

// Row-major 3x3, applied to (x, y, 1).
using Mat3 = std::array<double, 9>;

Mat3 multiply(const Mat3& a, const Mat3& b) {
  Mat3 out{};
  for (size_t row = 0; row < 3; ++row) {
    for (size_t column = 0; column < 3; ++column) {
      out[(row * 3) + column] = (a[row * 3] * b[column]) + (a[(row * 3) + 1] * b[3 + column]) +
                                (a[(row * 3) + 2] * b[6 + column]);
    }
  }
  return out;
}

// Everything that moves pixels rather than changing them: resolved from the stack once
// per render and folded into the proxy's sampling pass.
struct GeometryParams {
  double left = 0;
  double top = 0;
  double right = 1;
  double bottom = 1;
  double angle = 0;
  int quadrant = 0;
  bool flip_horizontal = false;
  bool flip_vertical = false;
  double vertical = 0;
  double horizontal = 0;
  double rotate = 0;
  double aspect = 0;
  double scale = 100;
  double offset_x = 0;
  double offset_y = 0;
  double distortion = 0;

  bool operator==(const GeometryParams& other) const = default;
};

GeometryParams geometry_from_stack(const Stack& stack) {
  GeometryParams geometry;
  for (const Op& op : stack) {
    if (!op.enabled) continue;
    if (op.name == "crop") {
      geometry.left = std::clamp(param(op, "left"), 0.0, 1.0);
      geometry.top = std::clamp(param(op, "top"), 0.0, 1.0);
      geometry.right = std::clamp(param(op, "right", 1.0), 0.0, 1.0);
      geometry.bottom = std::clamp(param(op, "bottom", 1.0), 0.0, 1.0);
      geometry.angle = param(op, "angle");
      continue;
    }
    if (op.name == "rotate") {
      geometry.quadrant = static_cast<int>(std::lround(param(op, "value") / 90.0)) & 3;
      continue;
    }
    if (op.name == "flip") {
      geometry.flip_horizontal = flag(op, "horizontal");
      geometry.flip_vertical = flag(op, "vertical");
      continue;
    }
    if (op.name == "transform") {
      geometry.vertical = param(op, "vertical");
      geometry.horizontal = param(op, "horizontal");
      geometry.rotate = param(op, "rotate");
      geometry.aspect = param(op, "aspect");
      geometry.scale = param(op, "scale", 100.0);
      geometry.offset_x = param(op, "offsetX");
      geometry.offset_y = param(op, "offsetY");
      continue;
    }
    if (op.name == "lens_correction") geometry.distortion = param(op, "distortion");
  }
  // A collapsed or inverted crop rect would divide by zero; keep at least one per cent.
  geometry.right = std::max(geometry.right, geometry.left + 0.01);
  geometry.bottom = std::max(geometry.bottom, geometry.top + 0.01);
  return geometry;
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

MaskUniform mask_uniform(const MaskComponent& component, const ViewGeometry& geometry) {
  MaskUniform uniform;
  uniform.kind = static_cast<uint32_t>(mask_pass_kind(component.kind));
  uniform.invert = component.invert ? 1U : 0U;
  uniform.feather = static_cast<float>(component.feather / 100.0);
  uniform.opacity = static_cast<float>(component.opacity / 100.0);
  uniform.origin[0] = static_cast<float>(geometry.content_x);
  uniform.origin[1] = static_cast<float>(geometry.content_y);
  uniform.size[0] = static_cast<float>(geometry.content_width);
  uniform.size[1] = static_cast<float>(geometry.content_height);

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

// What invalidates a cached raster: the mask's own JSON, the view's size, and the content
// rect inside it — mask coordinates are normalised over that rect, so a crop moves them.
// The op's *input* deliberately does not: a masked slider drag must not re-rasterise, and
// the price is that a luminance or colour mask keeps the levels it was built from until
// the mask or the frame changes (see the report's UI to-do for mask.refresh).
std::string mask_cache_key(const nlohmann::json& canonical, const ViewGeometry& geometry) {
  const nlohmann::json keyed = {
      {"m", canonical},
      {"r",
       {geometry.content_x, geometry.content_y, geometry.content_width, geometry.content_height}}};
  return mask_hash(keyed, geometry.width, geometry.height);
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
};

struct Renderer::View {
  int64_t photo_id = 0;
  ViewGeometry geometry;
  bool base_valid = false;
  GeometryParams geometry_params;
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
  const GeometryParams& geometry_params = view.geometry_params;
  const bool turned = (geometry_params.quadrant % 2) != 0;
  const double work_width = turned ? photo.height : photo.width;
  const double work_height = turned ? photo.width : photo.height;
  const double crop_width = geometry_params.right - geometry_params.left;
  const double crop_height = geometry_params.bottom - geometry_params.top;
  const double content_aspect = (work_width * crop_width) / (work_height * crop_height);

  ViewGeometry& geometry = view.geometry;
  geometry.content_width = geometry.width;
  geometry.content_height =
      std::max(1U, static_cast<uint32_t>(std::lround(geometry.width / content_aspect)));
  if (geometry.content_height > geometry.height) {
    geometry.content_height = geometry.height;
    geometry.content_width =
        std::max(1U, static_cast<uint32_t>(std::lround(geometry.height * content_aspect)));
  }
  geometry.content_width = std::min(geometry.content_width, geometry.width);
  geometry.content_x = (geometry.width - geometry.content_width) / 2;
  geometry.content_y = (geometry.height - geometry.content_height) / 2;

  // Destination pixel -> source texel, right to left: crop the 0..1 destination into the
  // working frame, centre it on the crop's middle with the frame's aspect, undo the user's
  // transform, and put it back. Every step is the inverse of what the slider says it does,
  // because the pass walks destination pixels and asks where each came from.
  const double work_aspect = work_width / work_height;
  const double centre_x = (geometry_params.left + geometry_params.right) / 2.0;
  const double centre_y = (geometry_params.top + geometry_params.bottom) / 2.0;
  const Mat3 crop = {crop_width, 0, geometry_params.left, 0, crop_height, geometry_params.top, 0,
                     0,          1};
  const Mat3 to_centre = {work_aspect, 0, -work_aspect * centre_x, 0, 1, -centre_y, 0, 0, 1};
  const Mat3 from_centre = {1.0 / work_aspect, 0, centre_x, 0, 1, centre_y, 0, 0, 1};

  const double scale = std::max(geometry_params.scale, 1.0) / 100.0;
  const Mat3 unscale = {1.0 / scale, 0, 0, 0, 1.0 / scale, 0, 0, 0, 1};
  const Mat3 unoffset = {1, 0, -geometry_params.offset_x / 100.0 * work_aspect,
                         0, 1, -geometry_params.offset_y / 100.0,
                         0, 0, 1};
  const double radians =
      (geometry_params.angle + geometry_params.rotate) * std::numbers::pi / 180.0;
  const Mat3 unrotate = {
      std::cos(radians), std::sin(radians), 0, -std::sin(radians), std::cos(radians), 0, 0, 0, 1};
  const double stretch = std::exp2(geometry_params.aspect / 100.0 * 0.5);
  const Mat3 unstretch = {1.0 / stretch, 0, 0, 0, stretch, 0, 0, 0, 1};
  const Mat3 unkeystone = {1,
                           0,
                           0,
                           0,
                           1,
                           0,
                           -geometry_params.horizontal / 100.0 * 0.5,
                           -geometry_params.vertical / 100.0 * 0.5,
                           1};
  Mat3 matrix = multiply(unscale, multiply(to_centre, crop));
  matrix = multiply(unoffset, matrix);
  matrix = multiply(unrotate, matrix);
  matrix = multiply(unstretch, matrix);
  matrix = multiply(unkeystone, matrix);
  matrix = multiply(from_centre, matrix);

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
  fit.flip[0] = geometry_params.flip_horizontal ? -1.0F : 1.0F;
  fit.flip[1] = geometry_params.flip_vertical ? -1.0F : 1.0F;
  for (int i = 0; i < 3; ++i) {
    fit.m0[i] = static_cast<float>(matrix[i]);
    fit.m1[i] = static_cast<float>(matrix[3 + i]);
    fit.m2[i] = static_cast<float>(matrix[6 + i]);
  }
  fit.params[0] = static_cast<float>(geometry_params.distortion / 100.0 * 0.3);
  fit.params[1] = static_cast<float>(work_aspect);
  fit.params[2] = static_cast<float>(geometry_params.quadrant);
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
};

void Renderer::build_mask(View& view, const Op& op, const nlohmann::json& canonical,
                          const std::string& hash, WGPUTextureView input) {
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
  for (const MaskComponent* component : active) {
    if (mask_pass_kind(component->kind) != MaskPass::Raster) continue;
    MaskComponentTexture& texture = entry.components[component->id];
    GrayImage image;
    std::string source_key;
    if (component->kind == MaskKind::Brush) {
      source_key = mask_cache_key(component->params, view.geometry);
      if (texture.source_hash == source_key) continue;
      image = rasterize_brush(brush_strokes(component->params), component->feather,
                              view.geometry.content_width, view.geometry.content_height);
    } else {
      const StoredRaster& stored = photo.rasters.at(component->id);
      source_key = stored.hash + "@" + std::to_string(view.geometry.content_width) + "x" +
                   std::to_string(view.geometry.content_height);
      if (texture.source_hash == source_key) continue;
      image =
          resample_gray(stored.image, view.geometry.content_width, view.geometry.content_height);
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
    const std::string key = mask_cache_key(component_to_json(*component), view.geometry);
    if (!texture.texture) {
      texture.texture =
          gpu_.create_texture(width, height, WGPUTextureFormat_R8Unorm, usage, "mask-component");
      texture.view.reset(wgpuTextureCreateView(texture.texture.get(), nullptr));
      texture.hash.clear();
    }
    if (texture.hash != key) {
      const MaskUniform uniform = mask_uniform(*component, view.geometry);
      gpu_.write_buffer(mask_uniforms_.get(), kOpUniformStride * slot, &uniform, sizeof(uniform));
      WGPUTextureView raster =
          texture.source_view ? texture.source_view.get() : white_mask_view_.get();
      const std::array<WGPUBindGroupEntry, 3> entries = {
          texture_entry(0, input),
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

WGPUTextureView Renderer::run_passes(View& view, const Stack& stack) {
  // Geometry is not a pass: it changes where the proxy samples from and how big the image
  // rect is, so a change to it rebuilds the base. Everything else leaves the base alone.
  const GeometryParams geometry_params = geometry_from_stack(stack);
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
    // An empty component list is not a mask: the op still applies everywhere, at its
    // opacity. A list whose components are all pending is, and rasterises to nothing.
    if (op->mask.has_value() && op->mask->contains("components") &&
        !(*op->mask)["components"].empty()) {
      pass.mask_json = *op->mask;
      pass.mask_hash = mask_cache_key(pass.mask_json, view.geometry);
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

  std::vector<BindGroupHandle> bind_groups;
  WGPUCommandEncoder encoder = gpu_.begin_commands("view-render");
  WGPUTextureView source = view.base_view.get();
  size_t target_index = 0;
  for (size_t i = 0; i < passes.size(); ++i) {
    Pass& pass = passes[i];
    // A luminance or colour component reads the op's input, so the chain below it has to
    // have run. Everything already encoded goes out, the mask is built, and the encoder
    // starts again. Only a mask edit lands here: a cached one costs nothing.
    if (pass.mask_dirty) {
      gpu_.submit(encoder);
      gpu_.wait_idle();
      gpu_.raise_pending_error();
      bind_groups.clear();
      build_mask(view, *pass.op, pass.mask_json, pass.mask_hash, source);
      encoder = gpu_.begin_commands("view-render");
    }
    pass.mask_view = white_mask_view_.get();
    if (!pass.mask_hash.empty()) {
      const MaskEntry& entry = view.masks.at(pass.op->id);
      pass.mask_view = entry.accum_view[entry.final_index].get();
    }

    const WGPUBindGroupEntry uniform =
        buffer_entry(1, view.op_uniforms.get(), kOpUniformStride * i, sizeof(OpUniform));
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

MaskReadout Renderer::read_mask(uint32_t view_id, const Stack& stack, std::string_view op_id,
                                std::string_view component_id, std::vector<uint8_t>& out,
                                size_t offset) {
  View& view = view_for(view_id);
  WGPUTextureView last = run_passes(view, stack);

  const Op* op = find_op(stack, op_id);
  if (op == nullptr) throw std::runtime_error("unknown opId '" + std::string(op_id) + "'");
  if (!op->mask.has_value() || !op->mask->contains("components") ||
      (*op->mask)["components"].empty()) {
    throw std::runtime_error("op '" + std::string(op_id) + "' has no mask");
  }
  // A disabled or neutral op has no pass, so run_passes never built its mask; the overlay
  // still has to be able to show it.
  const std::string hash = mask_cache_key(*op->mask, view.geometry);
  const auto found = view.masks.find(op->id);
  if (found == view.masks.end() || found->second.hash != hash) {
    build_mask(view, *op, *op->mask, hash, last);
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
  size_t inside = 0;
  size_t counted = 0;
  for (uint32_t y = view.geometry.content_y;
       y < view.geometry.content_y + view.geometry.content_height; ++y) {
    for (uint32_t x = view.geometry.content_x;
         x < view.geometry.content_x + view.geometry.content_width; ++x) {
      ++counted;
      if (out[offset + (static_cast<size_t>(y) * entry.width) + x] > 127) ++inside;
    }
  }
  readout.coverage =
      counted == 0 ? 0.0 : static_cast<double>(inside) / static_cast<double>(counted);
  return readout;
}

RenderTiming Renderer::render(uint32_t view_id, const Stack& stack, std::vector<uint8_t>& out,
                              size_t offset) {
  using clock = std::chrono::steady_clock;
  View& view = view_for(view_id);
  const auto started = clock::now();

  WGPUTextureView source = run_passes(view, stack);
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

}  // namespace latent

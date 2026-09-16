#include "export/color_space.h"

#include <cmath>

#include <algorithm>
#include <stdexcept>
#include <string>

#include <lcms2.h>

namespace latent {

namespace {

using Mat3 = std::array<double, 9>;

struct Chromaticity {
  double x = 0;
  double y = 0;
};

struct Primaries {
  Chromaticity red;
  Chromaticity green;
  Chromaticity blue;
  Chromaticity white;
};

// D65 and D50 as the ICC specification rounds them.
constexpr Chromaticity kD65{0.3127, 0.3290};
constexpr Chromaticity kD50{0.34567, 0.35850};

Primaries primaries_of(ExportColorSpace space) {
  switch (space) {
    case ExportColorSpace::DisplayP3:
      return {{0.680, 0.320}, {0.265, 0.690}, {0.150, 0.060}, kD65};
    case ExportColorSpace::AdobeRgb:
      return {{0.640, 0.330}, {0.210, 0.710}, {0.150, 0.060}, kD65};
    case ExportColorSpace::Rec2020:
      return {{0.708, 0.292}, {0.170, 0.797}, {0.131, 0.046}, kD65};
    case ExportColorSpace::ProPhoto:
      return {{0.734699, 0.265301}, {0.159597, 0.840403}, {0.036598, 0.000105}, kD50};
    default:
      return {{0.640, 0.330}, {0.300, 0.600}, {0.150, 0.060}, kD65};
  }
}

// 0 = the sRGB piecewise curve, which is also what the Display P3 and Rec.2020 ICCs here
// carry; AdobeRGB's own gamma is 563/256, and ProPhoto's ROMM curve is a gamma of 1.8.
float gamma_of(ExportColorSpace space) {
  switch (space) {
    case ExportColorSpace::AdobeRgb:
      return 563.0F / 256.0F;
    case ExportColorSpace::ProPhoto:
      return 1.8F;
    default:
      return 0;
  }
}

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

std::array<double, 3> multiply(const Mat3& m, const std::array<double, 3>& v) {
  return {(m[0] * v[0]) + (m[1] * v[1]) + (m[2] * v[2]),
          (m[3] * v[0]) + (m[4] * v[1]) + (m[5] * v[2]),
          (m[6] * v[0]) + (m[7] * v[1]) + (m[8] * v[2])};
}

Mat3 inverse(const Mat3& m) {
  const double determinant = (m[0] * ((m[4] * m[8]) - (m[5] * m[7]))) -
                             (m[1] * ((m[3] * m[8]) - (m[5] * m[6]))) +
                             (m[2] * ((m[3] * m[7]) - (m[4] * m[6])));
  if (std::abs(determinant) < 1e-12) throw std::runtime_error("singular colour matrix");
  const double scale = 1.0 / determinant;
  return {((m[4] * m[8]) - (m[5] * m[7])) * scale, ((m[2] * m[7]) - (m[1] * m[8])) * scale,
          ((m[1] * m[5]) - (m[2] * m[4])) * scale, ((m[5] * m[6]) - (m[3] * m[8])) * scale,
          ((m[0] * m[8]) - (m[2] * m[6])) * scale, ((m[2] * m[3]) - (m[0] * m[5])) * scale,
          ((m[3] * m[7]) - (m[4] * m[6])) * scale, ((m[1] * m[6]) - (m[0] * m[7])) * scale,
          ((m[0] * m[4]) - (m[1] * m[3])) * scale};
}

std::array<double, 3> xyz_of(const Chromaticity& c) {
  const double y = std::max(c.y, 1e-9);
  return {c.x / y, 1.0, (1.0 - c.x - c.y) / y};
}

// The textbook construction: the primaries as columns, scaled so that RGB = (1,1,1) lands
// exactly on the white point.
Mat3 rgb_to_xyz(const Primaries& p) {
  const std::array<double, 3> red = xyz_of(p.red);
  const std::array<double, 3> green = xyz_of(p.green);
  const std::array<double, 3> blue = xyz_of(p.blue);
  const Mat3 columns = {red[0],  green[0], blue[0],  red[1], green[1],
                        blue[1], red[2],   green[2], blue[2]};
  const std::array<double, 3> scale = multiply(inverse(columns), xyz_of(p.white));
  return {columns[0] * scale[0], columns[1] * scale[1], columns[2] * scale[2],
          columns[3] * scale[0], columns[4] * scale[1], columns[5] * scale[2],
          columns[6] * scale[0], columns[7] * scale[1], columns[8] * scale[2]};
}

// Bradford chromatic adaptation. Only ProPhoto needs it — it is the one D50 space here.
Mat3 adaptation(const Chromaticity& from, const Chromaticity& to) {
  constexpr Mat3 kBradford = {0.8951, 0.2664, -0.1614, -0.7502, 1.7135,
                              0.0367, 0.0389, -0.0685, 1.0296};
  const std::array<double, 3> source = multiply(kBradford, xyz_of(from));
  const std::array<double, 3> target = multiply(kBradford, xyz_of(to));
  const Mat3 ratio = {target[0] / source[0], 0, 0, 0, target[1] / source[1], 0, 0, 0,
                      target[2] / source[2]};
  return multiply(inverse(kBradford), multiply(ratio, kBradford));
}

double encode_channel(double value, double gamma) {
  const double c = std::clamp(value, 0.0, 1.0);
  if (gamma == 0) {
    if (c <= 0.0031308) return 12.92 * c;
    return (1.055 * std::pow(c, 1.0 / 2.4)) - 0.055;
  }
  return std::pow(c, 1.0 / gamma);
}

// RAII for the three lcms handles this file opens; lcms is a C API and the error paths
// below must not leak a profile or a curve.
struct ToneCurveHandle {
  cmsToneCurve* curve = nullptr;
  ~ToneCurveHandle() {
    if (curve != nullptr) cmsFreeToneCurve(curve);
  }
  ToneCurveHandle() = default;
  ToneCurveHandle(const ToneCurveHandle&) = delete;
  ToneCurveHandle& operator=(const ToneCurveHandle&) = delete;
};

struct ProfileHandle {
  cmsHPROFILE profile = nullptr;
  ~ProfileHandle() {
    if (profile != nullptr) cmsCloseProfile(profile);
  }
  ProfileHandle() = default;
  ProfileHandle(const ProfileHandle&) = delete;
  ProfileHandle& operator=(const ProfileHandle&) = delete;
};

struct MluHandle {
  cmsMLU* mlu = nullptr;
  ~MluHandle() {
    if (mlu != nullptr) cmsMLUfree(mlu);
  }
  MluHandle() = default;
  MluHandle(const MluHandle&) = delete;
  MluHandle& operator=(const MluHandle&) = delete;
};

}  // namespace

ColorTransform export_color_transform(ExportColorSpace space) {
  ColorTransform transform;
  transform.gamma = gamma_of(space);
  const Primaries source = primaries_of(ExportColorSpace::Srgb);
  const Primaries target = primaries_of(space);
  Mat3 matrix = rgb_to_xyz(source);
  if (!(source.white.x == target.white.x && source.white.y == target.white.y)) {
    matrix = multiply(adaptation(source.white, target.white), matrix);
  }
  matrix = multiply(inverse(rgb_to_xyz(target)), matrix);
  for (size_t i = 0; i < 9; ++i)
    transform.matrix[i] = static_cast<float>(matrix[i]);
  return transform;
}

std::array<double, 3> apply_color_transform(const ColorTransform& transform,
                                            const std::array<double, 3>& linear_srgb) {
  std::array<double, 3> out{};
  for (size_t row = 0; row < 3; ++row) {
    const double value = (static_cast<double>(transform.matrix[row * 3]) * linear_srgb[0]) +
                         (static_cast<double>(transform.matrix[(row * 3) + 1]) * linear_srgb[1]) +
                         (static_cast<double>(transform.matrix[(row * 3) + 2]) * linear_srgb[2]);
    out[row] = encode_channel(value, transform.gamma);
  }
  return out;
}

std::vector<uint8_t> export_icc_profile(ExportColorSpace space) {
  const Primaries primaries = primaries_of(space);
  const float gamma = gamma_of(space);

  ToneCurveHandle tone;
  if (gamma == 0) {
    // Parametric type 4 is the IEC 61966-2-1 curve: g, a, b, c, d.
    std::array<cmsFloat64Number, 5> srgb = {2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045};
    tone.curve = cmsBuildParametricToneCurve(nullptr, 4, srgb.data());
  } else {
    tone.curve = cmsBuildGamma(nullptr, gamma);
  }
  if (tone.curve == nullptr) throw std::runtime_error("lcms2 could not build the output curve");

  cmsCIExyY white{primaries.white.x, primaries.white.y, 1.0};
  cmsCIExyYTRIPLE rgb{{primaries.red.x, primaries.red.y, 1.0},
                      {primaries.green.x, primaries.green.y, 1.0},
                      {primaries.blue.x, primaries.blue.y, 1.0}};
  std::array<cmsToneCurve*, 3> curves = {tone.curve, tone.curve, tone.curve};

  ProfileHandle profile;
  profile.profile = cmsCreateRGBProfile(&white, &rgb, curves.data());
  if (profile.profile == nullptr) throw std::runtime_error("lcms2 could not build the profile");

  MluHandle description;
  description.mlu = cmsMLUalloc(nullptr, 1);
  const std::string name = "Latent " + std::string(export_color_space_name(space));
  if (description.mlu != nullptr) {
    cmsMLUsetASCII(description.mlu, "en", "US", name.c_str());
    cmsWriteTag(profile.profile, cmsSigProfileDescriptionTag, description.mlu);
  }

  cmsUInt32Number size = 0;
  if (cmsSaveProfileToMem(profile.profile, nullptr, &size) == 0 || size == 0) {
    throw std::runtime_error("lcms2 could not size the profile");
  }
  std::vector<uint8_t> bytes(size);
  if (cmsSaveProfileToMem(profile.profile, bytes.data(), &size) == 0) {
    throw std::runtime_error("lcms2 could not serialise the profile");
  }
  bytes.resize(size);
  return bytes;
}

}  // namespace latent

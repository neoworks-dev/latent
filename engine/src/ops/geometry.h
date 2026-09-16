// The geometry stage, resolved once and shared by everything that needs to know where a
// pixel came from: the proxy's sampling pass, the mask rasteriser, the overlay transform
// the UI draws with, and the migration that moves old content-space masks into image
// space. There is one implementation of this arithmetic and it lives here.
//
// Three coordinate spaces, and the names used for them everywhere in the engine:
//
//   image      0..1 over the decoded photo, the size `photo.open` reports — upright,
//              because LibRaw's dcraw_process has already applied the camera flip. Crop,
//              straighten, rotate, flip and the Transform sliders do not move it, which is
//              why masks are stored in it.
//   working    0..1 over the image after the 90 degree quadrant and the mirrors, before
//              crop. What downscale.wgsl samples the full-res texture in.
//   view       pixels of the proxy frame. The developed image sits at `content` inside it,
//              letterboxed, and the viewport's zoom and pan move and scale that rect.
//
// Lens distortion is the one part of the stage that is not a matrix: it is a radial term
// with no closed form inverse. `view_to_image` therefore omits it, and so does the
// `imageTransform` on the wire; the shader applies it separately in the forward direction,
// where it is exact. With `lens_correction.distortion` at its default 0 the two agree.
#pragma once

#include "ops/op.h"

#include <cstdint>

#include <array>

#include <nlohmann/json.hpp>

namespace latent {

// Row-major 3x3, applied to (x, y, 1) with a homogeneous divide. The Transform sliders'
// keystone makes the stage projective, so an affine 2x3 would not hold it.
using Mat3 = std::array<double, 9>;

Mat3 mat3_identity();
Mat3 mat3_multiply(const Mat3& a, const Mat3& b);
// Throws std::runtime_error when the matrix is singular, which a valid stage never is.
Mat3 mat3_inverse(const Mat3& matrix);
std::array<double, 2> mat3_apply(const Mat3& matrix, double x, double y);

// Everything in the stack that moves pixels rather than changing them, resolved in stack
// order: the last crop op wins, the last transform op wins, and so on.
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

GeometryParams geometry_from_stack(const Stack& stack);
// True when the stack holds an enabled op that moves pixels. `geometry_from_stack` of a
// stack without one is the identity stage.
bool is_geometry_op(std::string_view name);
// Everything the stage is, in a form a cache key can hash. Two stacks with the same
// geometry produce the same object, so a mask raster is only rebuilt when the stage moved.
nlohmann::json geometry_to_json(const GeometryParams& params);

// Drops the crop rect and the straighten angle, keeping rotate, flip and Transform: the
// uncropped frame `view.render`'s `geometry: "full"` asks for.
GeometryParams without_crop(GeometryParams params);

// What the user is looking at inside the developed image. `scale` 1 is fit-to-view, 2 is
// twice that; the centre is the image-normalised point the view is centred on and is
// ignored while `fit` is set, which keeps the frame centred the way it always was.
struct Viewport {
  double scale = 1;
  double center_x = 0.5;
  double center_y = 0.5;
  bool fit = true;

  bool operator==(const Viewport& other) const = default;
};

// The lowest and highest zoom the engine will honour. Below 1 the image would be smaller
// than the view for no gain; above 32 a proxy pixel is a source texel many times over.
inline constexpr double kMinViewportScale = 1.0;
inline constexpr double kMaxViewportScale = 32.0;

// The developed image's rect inside the view, in view pixels. Rounded to whole pixels so
// the matrices below and the `contentRect` on the wire agree exactly, and signed because a
// zoomed view is a window into a rect that starts off the left edge.
struct ContentRect {
  int32_t x = 0;
  int32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

struct GeometryMap {
  ContentRect content;
  // view pixel -> image 0..1 and back. Lens distortion excluded (see the file header).
  Mat3 view_to_image = mat3_identity();
  Mat3 image_to_view = mat3_identity();
  // view pixel -> working 0..1: the homography downscale.wgsl and mask.wgsl walk, with the
  // content rect's origin and extent already folded in.
  Mat3 view_to_working = mat3_identity();
  // content rect 0..1 -> image 0..1. Independent of the view's size, which is what makes
  // the legacy mask migration possible without opening a view.
  Mat3 content_to_image = mat3_identity();
  double work_aspect = 1;
  double image_aspect = 1;
  int quadrant = 0;
  bool flip_horizontal = false;
  bool flip_vertical = false;
  // The radial term downscale.wgsl and mask.wgsl apply between the homography and the
  // quadrant, already scaled out of the slider's 0..100.
  double distortion_k = 0;
};

GeometryMap geometry_map(const GeometryParams& params, uint32_t photo_width, uint32_t photo_height,
                         uint32_t view_width, uint32_t view_height, const Viewport& viewport);

// The same, fitted: what every caller that has no viewport of its own wants.
GeometryMap geometry_map(const GeometryParams& params, uint32_t photo_width, uint32_t photo_height,
                         uint32_t view_width, uint32_t view_height);

// working 0..1 -> image 0..1: the quadrant rotation and the mirrors, as a matrix.
Mat3 working_to_image(int quadrant, bool flip_horizontal, bool flip_vertical);

// `imageTransform` as it goes on the wire: the nine numbers of `image_to_view`, row-major.
std::array<double, 9> image_transform_wire(const GeometryMap& map);

}  // namespace latent

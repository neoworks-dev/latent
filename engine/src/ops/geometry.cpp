#include "ops/geometry.h"

#include <cmath>

#include <algorithm>
#include <numbers>
#include <stdexcept>

namespace latent {

namespace {

double param(const Op& op, const char* name, double fallback = 0.0) {
  const auto found = op.params.find(name);
  if (found == op.params.end() || !found->is_number()) return fallback;
  return found->get<double>();
}

bool flag(const Op& op, const char* name) {
  const auto found = op.params.find(name);
  return found != op.params.end() && found->is_boolean() && found->get<bool>();
}

// A whole number of pixels, never zero: an extent of 0 would divide by zero one line later.
uint32_t round_extent(double value) {
  const double rounded = std::lround(std::clamp(value, 1.0, 1e7));
  return static_cast<uint32_t>(rounded);
}

// Where a rect of `extent` pixels sits on one axis of a `view` long view. Smaller than the
// view it is centred, larger it is dragged to `centre` and clamped so the view never shows
// anything but image on that axis.
int32_t place(double view, double extent, double centre, bool fit, double inset_start = 0,
              double inset_end = 0) {
  // The client's floating panels take the edges of the view; what is left is the hole the
  // photo belongs in. Everything below is measured against that hole rather than the view,
  // so a zoomed rect is dragged until *it* is filled and may run on behind the panels. With
  // no insets the hole is the view and this is what it always was.
  const double inner = std::max(1.0, view - inset_start - inset_end);
  // Floor, not round: the letterbox has always put the odd pixel on the right, and a
  // client that computes the same rect from the photo's size has to land on it exactly.
  if (fit || extent <= inner) {
    return static_cast<int32_t>(std::floor(inset_start + (inner - extent) / 2.0));
  }
  const double wanted = inset_start + (inner / 2.0) - (centre * extent);
  return static_cast<int32_t>(
      std::lround(std::clamp(wanted, inset_start + inner - extent, inset_start)));
}

}  // namespace

Mat3 mat3_identity() {
  return {1, 0, 0, 0, 1, 0, 0, 0, 1};
}

Mat3 mat3_multiply(const Mat3& a, const Mat3& b) {
  Mat3 out{};
  for (size_t row = 0; row < 3; ++row) {
    for (size_t column = 0; column < 3; ++column) {
      out[(row * 3) + column] = (a[row * 3] * b[column]) + (a[(row * 3) + 1] * b[3 + column]) +
                                (a[(row * 3) + 2] * b[6 + column]);
    }
  }
  return out;
}

Mat3 mat3_inverse(const Mat3& m) {
  const double c00 = (m[4] * m[8]) - (m[5] * m[7]);
  const double c01 = (m[5] * m[6]) - (m[3] * m[8]);
  const double c02 = (m[3] * m[7]) - (m[4] * m[6]);
  const double determinant = (m[0] * c00) + (m[1] * c01) + (m[2] * c02);
  if (std::abs(determinant) < 1e-12) throw std::runtime_error("singular geometry matrix");
  const double inverse = 1.0 / determinant;
  return {c00 * inverse,
          ((m[2] * m[7]) - (m[1] * m[8])) * inverse,
          ((m[1] * m[5]) - (m[2] * m[4])) * inverse,
          c01 * inverse,
          ((m[0] * m[8]) - (m[2] * m[6])) * inverse,
          ((m[2] * m[3]) - (m[0] * m[5])) * inverse,
          c02 * inverse,
          ((m[1] * m[6]) - (m[0] * m[7])) * inverse,
          ((m[0] * m[4]) - (m[1] * m[3])) * inverse};
}

std::array<double, 2> mat3_apply(const Mat3& matrix, double x, double y) {
  const double w = (matrix[6] * x) + (matrix[7] * y) + matrix[8];
  if (std::abs(w) < 1e-12) return {0, 0};
  return {((matrix[0] * x) + (matrix[1] * y) + matrix[2]) / w,
          ((matrix[3] * x) + (matrix[4] * y) + matrix[5]) / w};
}

bool is_geometry_op(std::string_view name) {
  return name == "crop" || name == "rotate" || name == "flip" || name == "transform";
}

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

nlohmann::json geometry_to_json(const GeometryParams& params) {
  return {{"c", {params.left, params.top, params.right, params.bottom, params.angle}},
          {"q", params.quadrant},
          {"f", {params.flip_horizontal, params.flip_vertical}},
          {"t",
           {params.vertical, params.horizontal, params.rotate, params.aspect, params.scale,
            params.offset_x, params.offset_y}},
          {"d", params.distortion}};
}

GeometryParams without_crop(GeometryParams params) {
  params.left = 0;
  params.top = 0;
  params.right = 1;
  params.bottom = 1;
  params.angle = 0;
  return params;
}

Mat3 working_to_image(int quadrant, bool flip_horizontal, bool flip_vertical) {
  // The inverse of downscale.wgsl's `to_source`, which is the same thing read forwards:
  // quadrant 1 sends (x, y) to (y, 1 - x), and so on.
  Mat3 turn = mat3_identity();
  if (quadrant == 1) turn = {0, 1, 0, -1, 0, 1, 0, 0, 1};
  if (quadrant == 2) turn = {-1, 0, 1, 0, -1, 1, 0, 0, 1};
  if (quadrant == 3) turn = {0, -1, 1, 1, 0, 0, 0, 0, 1};
  const Mat3 mirror = {flip_horizontal ? -1.0 : 1.0,
                       0,
                       flip_horizontal ? 1.0 : 0.0,
                       0,
                       flip_vertical ? -1.0 : 1.0,
                       flip_vertical ? 1.0 : 0.0,
                       0,
                       0,
                       1};
  return mat3_multiply(mirror, turn);
}

GeometryMap geometry_map(const GeometryParams& params, uint32_t photo_width, uint32_t photo_height,
                         uint32_t view_width, uint32_t view_height, const Viewport& viewport) {
  GeometryMap map;
  const double photo_w = std::max(1U, photo_width);
  const double photo_h = std::max(1U, photo_height);
  const bool turned = (params.quadrant % 2) != 0;
  const double work_width = turned ? photo_h : photo_w;
  const double work_height = turned ? photo_w : photo_h;
  const double crop_width = params.right - params.left;
  const double crop_height = params.bottom - params.top;

  map.image_aspect = photo_w / photo_h;
  map.work_aspect = work_width / work_height;
  map.quadrant = params.quadrant;
  map.flip_horizontal = params.flip_horizontal;
  map.flip_vertical = params.flip_vertical;
  map.distortion_k = params.distortion / 100.0 * 0.3;

  // Destination pixel -> source texel, right to left: crop the 0..1 destination into the
  // working frame, centre it on the crop's middle with the frame's aspect, undo the user's
  // transform, and put it back. Every step is the inverse of what the slider says it does,
  // because the pass walks destination pixels and asks where each came from.
  const double centre_x = (params.left + params.right) / 2.0;
  const double centre_y = (params.top + params.bottom) / 2.0;
  const Mat3 crop = {crop_width, 0, params.left, 0, crop_height, params.top, 0, 0, 1};
  const Mat3 to_centre = {
      map.work_aspect, 0, -map.work_aspect * centre_x, 0, 1, -centre_y, 0, 0, 1};
  const Mat3 from_centre = {1.0 / map.work_aspect, 0, centre_x, 0, 1, centre_y, 0, 0, 1};

  const double scale = std::max(params.scale, 1.0) / 100.0;
  const Mat3 unscale = {1.0 / scale, 0, 0, 0, 1.0 / scale, 0, 0, 0, 1};
  const Mat3 unoffset = {
      1, 0, -params.offset_x / 100.0 * map.work_aspect, 0, 1, -params.offset_y / 100.0, 0, 0, 1};
  const double radians = (params.angle + params.rotate) * std::numbers::pi / 180.0;
  const Mat3 unrotate = {
      std::cos(radians), std::sin(radians), 0, -std::sin(radians), std::cos(radians), 0, 0, 0, 1};
  const double stretch = std::exp2(params.aspect / 100.0 * 0.5);
  const Mat3 unstretch = {1.0 / stretch, 0, 0, 0, stretch, 0, 0, 0, 1};
  const Mat3 unkeystone = {
      1, 0, 0, 0, 1, 0, -params.horizontal / 100.0 * 0.5, -params.vertical / 100.0 * 0.5, 1};

  Mat3 content_to_working = mat3_multiply(unscale, mat3_multiply(to_centre, crop));
  content_to_working = mat3_multiply(unoffset, content_to_working);
  content_to_working = mat3_multiply(unrotate, content_to_working);
  content_to_working = mat3_multiply(unstretch, content_to_working);
  content_to_working = mat3_multiply(unkeystone, content_to_working);
  content_to_working = mat3_multiply(from_centre, content_to_working);

  const Mat3 to_image =
      working_to_image(params.quadrant, params.flip_horizontal, params.flip_vertical);
  map.content_to_image = mat3_multiply(to_image, content_to_working);

  // The fit: the developed image's aspect inside the view, then the viewport's zoom on top
  // of it. Zoom grows the rect around the centred image point and pan slides it, clamped so
  // a zoomed view never shows a letterbox bar it could fill with photo.
  const double view_w = std::max(1U, view_width);
  const double view_h = std::max(1U, view_height);
  // The box the photo is fitted into: the view minus whatever the client says floats over
  // it. Zoom multiplies this fit, so the first notch grows the picture that is on screen
  // instead of jumping to the size it would have had without the panels.
  const double inner_w = std::max(
      1.0, view_w - std::max(0.0, viewport.inset_left) - std::max(0.0, viewport.inset_right));
  const double inner_h = std::max(
      1.0, view_h - std::max(0.0, viewport.inset_top) - std::max(0.0, viewport.inset_bottom));
  const double content_aspect = (work_width * crop_width) / (work_height * crop_height);
  double fit_width = inner_w;
  double fit_height = std::max(1.0, inner_w / content_aspect);
  if (fit_height > inner_h) {
    fit_height = inner_h;
    fit_width = std::max(1.0, inner_h * content_aspect);
  }
  const double zoom = std::clamp(viewport.scale, kMinViewportScale, kMaxViewportScale);
  map.content.width = round_extent(fit_width * zoom);
  map.content.height = round_extent(fit_height * zoom);

  std::array<double, 2> centre = {0.5, 0.5};
  if (!viewport.fit) {
    centre = mat3_apply(mat3_inverse(map.content_to_image), viewport.center_x, viewport.center_y);
  }
  map.content.x = place(view_w, map.content.width, centre[0], viewport.fit,
                        std::max(0.0, viewport.inset_left), std::max(0.0, viewport.inset_right));
  map.content.y = place(view_h, map.content.height, centre[1], viewport.fit,
                        std::max(0.0, viewport.inset_top), std::max(0.0, viewport.inset_bottom));

  const Mat3 view_to_content = {1.0 / map.content.width,
                                0,
                                -static_cast<double>(map.content.x) / map.content.width,
                                0,
                                1.0 / map.content.height,
                                -static_cast<double>(map.content.y) / map.content.height,
                                0,
                                0,
                                1};
  map.view_to_working = mat3_multiply(content_to_working, view_to_content);
  map.view_to_image = mat3_multiply(map.content_to_image, view_to_content);
  map.image_to_view = mat3_inverse(map.view_to_image);
  return map;
}

GeometryMap geometry_map(const GeometryParams& params, uint32_t photo_width, uint32_t photo_height,
                         uint32_t view_width, uint32_t view_height) {
  return geometry_map(params, photo_width, photo_height, view_width, view_height, Viewport{});
}

std::array<double, 9> image_transform_wire(const GeometryMap& map) {
  return map.image_to_view;
}

}  // namespace latent

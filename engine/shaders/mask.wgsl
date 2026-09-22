// One fragment pass per mask component, writing an r8unorm raster the op passes sample
// (PROMPT.md 3.7). Kind numbers must match MaskPass in src/pipeline/renderer.cpp.
//
// Coordinates. Every shape is evaluated in *image space*: the view pixel this invocation
// owns is carried back through the geometry stage (crop, straighten, rotate, flip, the
// Transform sliders, lens distortion and the viewport's zoom and pan) into 0..1 over the
// uncropped photo, and the shape is asked about that point. A mask therefore stays on the
// subject when the geometry moves afterwards, which is what Lightroom does. The output is
// still a view-sized raster, so mask.preview's frame maps 1:1 onto the viewer's canvas.
//
// Shapes are computed in aspect-corrected image space so a radial is round on the photo
// and a gradient's iso-lines are square to the drag; feather is in the same units, which
// means it scales with the image and not with the window.
//
//   1 linear     v0 = start.xy, end.xy
//   2 radial     v0 = centre.xy, radius.xy; v1.x = angle in radians
//   3 luminance  v0 = lo, hi, smoothness     (over the view's base: the photo before any op)
//   4 color      v0 = sample count, range, smoothness; v1..v5 = samples in Oklab
//   5 raster     the `raster` binding: a brush stroke list or an AI model's output
//   6 depth      v0 = near, far, smoothness  (over the `raster` binding's depth map)
//
// `feather` softens the edge; `invert` flips; `opacity` scales. Everything else — the
// add/subtract/intersect fold — is mask_combine.wgsl.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Keep in sync with MaskUniform in src/pipeline/renderer.cpp. vec2f first so the u32 pair
// cannot split an alignment.
struct MaskParams {
  origin: vec2f,  // content rect inside the letterboxed view, in pixels
  size: vec2f,
  kind: u32,
  invert: u32,
  feather: f32,  // 0..1
  opacity: f32,  // 0..1
  m0: vec4f,     // rows of the view pixel -> working frame homography, xyz used
  m1: vec4f,
  m2: vec4f,
  geom: vec4f,   // x: lens distortion k, y: working aspect, z: quadrant, w: image aspect
  flip: vec4f,   // xy: -1 mirrors that axis of the working frame
  v: array<vec4f, 6>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> mask: MaskParams;
@group(0) @binding(2) var raster: texture_2d<f32>;

// View pixel -> image 0..1, the same chain downscale.wgsl walks to find its source texel:
// the homography, then the radial distortion term, then the quadrant and the mirrors.
// Kept in step with it by hand; both read the geometry ops through ops/geometry.cpp.
fn to_image(pos: vec2f) -> vec2f {
  let h = vec3f(pos, 1.0);
  let w = dot(mask.m2.xyz, h);
  if (abs(w) < 1e-6) { return vec2f(-1.0, -1.0); }
  var working = vec2f(dot(mask.m0.xyz, h), dot(mask.m1.xyz, h)) / w;

  let k = mask.geom.x;
  if (k != 0.0) {
    let aspect = vec2f(mask.geom.y, 1.0);
    let norm = 1.0 / length(aspect);
    let centred = (working - 0.5) * 2.0 * aspect * norm;
    working = (centred * (1.0 + k * dot(centred, centred))) / (2.0 * aspect * norm) + 0.5;
  }

  let quadrant = i32(mask.geom.z + 0.5);
  if (quadrant == 1) { working = vec2f(working.y, 1.0 - working.x); }
  else if (quadrant == 2) { working = vec2f(1.0 - working.x, 1.0 - working.y); }
  else if (quadrant == 3) { working = vec2f(1.0 - working.y, working.x); }
  return select(working, 1.0 - working, mask.flip.xy < vec2f(0.0));
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// The luminance range is the one the user sees, so the slider is linear in perceived
// brightness rather than in scene light.
fn tone_position(c: vec3f) -> f32 {
  return clamp(pow(max(luma(c), 0.0), 1.0 / 2.2), 0.0, 1.0);
}

// Oklab (Björn Ottosson) from linear sRGB: the distance that makes "within this much of
// that colour" mean the same thing for a dark blue and a bright yellow.
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3f(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
               1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
               0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}

fn raster_texel(coord: vec2i) -> f32 {
  let dims = vec2i(textureDimensions(raster));
  return textureLoad(raster, clamp(coord, vec2i(0, 0), dims - vec2i(1, 1)), 0).r;
}

// Bilinear, so a cached raster from a model's own resolution does not arrive as stairs.
fn sample_raster(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(raster));
  let p = clamp(uv, vec2f(0.0), vec2f(1.0)) * dims - vec2f(0.5);
  let base = floor(p);
  let f = p - base;
  let i = vec2i(base);
  let a = mix(raster_texel(i), raster_texel(i + vec2i(1, 0)), f.x);
  let b = mix(raster_texel(i + vec2i(0, 1)), raster_texel(i + vec2i(1, 1)), f.x);
  return mix(a, b, f.y);
}

// Feather for a raster has no closed form, so it is a 5x5 box over a radius the feather
// slider sets. Cheap because a mask is rasterised on an edit, never on a slider tick.
fn blurred_raster(uv: vec2f) -> f32 {
  if (mask.feather <= 0.0) { return sample_raster(uv); }
  let radius = mask.feather * 0.03;
  var sum = 0.0;
  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      sum = sum + sample_raster(uv + vec2f(f32(x), f32(y)) * radius * 0.5);
    }
  }
  return sum / 25.0;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  // Image space, not the frame: `uv` is where this view pixel sits on the uncropped photo.
  let uv = to_image(in.pos.xy);
  let aspect = mask.geom.w;
  let point = vec2f(uv.x * aspect, uv.y);
  let feather = max(mask.feather, 0.001);
  var value = 0.0;

  switch (mask.kind) {
    // linear: a ramp along the drag, feather widening the band it takes to get there.
    case 1u: {
      let start = vec2f(mask.v[0].x * aspect, mask.v[0].y);
      let end = vec2f(mask.v[0].z * aspect, mask.v[0].w);
      let axis = end - start;
      let length_squared = max(dot(axis, axis), 1e-8);
      let t = dot(point - start, axis) / length_squared;
      let half_band = feather * 0.5;
      value = smoothstep(0.5 - half_band, 0.5 + half_band, t);
    }
    // radial: an ellipse, rotated, soft from (1 - feather) of its radius outwards.
    case 2u: {
      let centre = vec2f(mask.v[0].x * aspect, mask.v[0].y);
      let radius = max(vec2f(mask.v[0].z * aspect, mask.v[0].w), vec2f(1e-4));
      let angle = mask.v[1].x;
      let delta = point - centre;
      let c = cos(angle);
      let s = sin(angle);
      let turned = vec2f(delta.x * c + delta.y * s, -delta.x * s + delta.y * c);
      let reach = length(turned / radius);
      value = 1.0 - smoothstep(1.0 - feather, 1.0, reach);
    }
    // luminance: a band of the base (the photo before any op), smoothness and feather both
    // softening its ends.
    case 3u: {
      let level = tone_position(textureLoad(src, vec2i(in.pos.xy), 0).rgb);
      let edge = max(mask.v[0].z, mask.feather) * 0.5 + 0.004;
      value = smoothstep(mask.v[0].x - edge, mask.v[0].x + edge, level) *
              (1.0 - smoothstep(mask.v[0].y - edge, mask.v[0].y + edge, level));
    }
    // color: distance in Oklab to the nearest sampled colour.
    case 4u: {
      let count = u32(mask.v[0].x);
      if (count > 0u) {
        let lab = linear_to_oklab(textureLoad(src, vec2i(in.pos.xy), 0).rgb);
        var nearest = 1e9;
        for (var i = 0u; i < count; i = i + 1u) {
          nearest = min(nearest, distance(lab, mask.v[i + 1u].xyz));
        }
        let range = mask.v[0].y;
        let edge = max(max(mask.v[0].z, mask.feather) * range, 1e-4);
        value = 1.0 - smoothstep(max(range - edge, 0.0), range, nearest);
      }
    }
    // raster: a brush stroke list or a model's output, both stored in image space.
    case 5u: {
      value = blurred_raster(uv);
    }
    // depth: a band of the depth map, 0 far and 1 near (engine/src/ai/depth.h). The same
    // band arithmetic as luminance, over the raster instead of over the pixels, so the
    // range is a live slider and never another model run.
    case 6u: {
      // Not the blurred read: `feather` widens the band below, and softening the map as
      // well would feather the same edge twice.
      let nearness = sample_raster(uv);
      let edge = max(mask.v[0].z, mask.feather) * 0.5 + 0.004;
      value = smoothstep(mask.v[0].x - edge, mask.v[0].x + edge, nearness) *
              (1.0 - smoothstep(mask.v[0].y - edge, mask.v[0].y + edge, nearness));
    }
    default: {}
  }

  if (mask.invert != 0u) { value = 1.0 - value; }
  return vec4f(clamp(value, 0.0, 1.0) * mask.opacity, 0.0, 0.0, 1.0);
}

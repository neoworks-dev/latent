// One fragment pass per mask component, writing an r8unorm raster the op passes sample
// (PROMPT.md 3.7). Kind numbers must match MaskPass in src/pipeline/renderer.cpp.
//
// Coordinates. `uv` is normalised over the *content rect* — the image as the view shows
// it after crop, rotate and transform — so what the user paints on is what the mask
// covers, and mask.preview's raster maps 1:1 onto the frame. Shapes are computed in
// aspect-corrected space so a radial is round and a gradient's iso-lines are square to
// the drag.
//
//   1 linear     v0 = start.xy, end.xy
//   2 radial     v0 = centre.xy, radius.xy; v1.x = angle in radians
//   3 luminance  v0 = lo, hi, smoothness     (over the op's input, display-referred)
//   4 color      v0 = sample count, range, smoothness; v1..v5 = samples in Oklab
//   5 raster     the `raster` binding: a brush stroke list or an AI model's output
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
  v: array<vec4f, 6>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> mask: MaskParams;
@group(0) @binding(2) var raster: texture_2d<f32>;

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
  let uv = (in.pos.xy - mask.origin) / max(mask.size, vec2f(1.0));
  let aspect = mask.size.x / max(mask.size.y, 1.0);
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
    // luminance: a band of the op's input, smoothness and feather both softening its ends.
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
    // raster: a brush stroke list or a model's output, already in content space.
    case 5u: {
      value = blurred_raster(uv);
    }
    default: {}
  }

  if (mask.invert != 0u) { value = 1.0 - value; }
  return vec4f(clamp(value, 0.0, 1.0) * mask.opacity, 0.0, 0.0, 1.0);
}

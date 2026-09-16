// The generative composite (PROMPT.md 3.5): the cached raster an inpaint job produced,
// put back where it was cut from.
//
//   out = mix(below, result, mask * opacity)   inside the result's rect
//   out = below                                 outside it, verbatim
//
// The second line is the contract: a pixel the mask does not cover comes back bit for bit,
// so adding a fill cannot quietly resample the rest of the frame.
//
// The backend returns display-sRGB 8 bit — what Flux Fill and Qwen-Image-Edit emit — so the
// result is linearised here with the exact inverse of display.wgsl's OETF. The working
// space is linear with sRGB primaries (ops.wgsl), so there is no primary matrix to apply.
//
// v0 = rect.min.xy, rect.max.xy, in view pixels; v1.xy = the result texture's size.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Keep in sync with OpUniform in src/pipeline/renderer.cpp — the same buffer slot the
// per-pixel passes read, so a generative op needs no uniform of its own.
struct OpParams {
  origin: vec2f,
  size: vec2f,
  kind: u32,
  opacity: f32,
  pad1: u32,
  pad2: u32,
  v: array<vec4f, 7>,
};

@group(0) @binding(0) var below: texture_2d<f32>;
@group(0) @binding(1) var<uniform> op: OpParams;
// rgba8unorm, display-referred: the PNG the backend returned, uploaded as it arrived.
@group(0) @binding(2) var result: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;

fn eotf(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}

// Bilinear by hand: nothing in this engine binds a sampler, and the crop is placed at
// roughly the scale it was rendered at, so point sampling would show its own grid.
fn sample_result(at: vec2f) -> vec3f {
  let dims = vec2i(textureDimensions(result));
  let limit = dims - vec2i(1, 1);
  let base = floor(at - vec2f(0.5));
  let frac = at - vec2f(0.5) - base;
  let p0 = clamp(vec2i(base), vec2i(0, 0), limit);
  let p1 = clamp(vec2i(base) + vec2i(1, 1), vec2i(0, 0), limit);
  let c00 = textureLoad(result, vec2i(p0.x, p0.y), 0).rgb;
  let c10 = textureLoad(result, vec2i(p1.x, p0.y), 0).rgb;
  let c01 = textureLoad(result, vec2i(p0.x, p1.y), 0).rgb;
  let c11 = textureLoad(result, vec2i(p1.x, p1.y), 0).rgb;
  let top = mix(c00, c10, frac.x);
  let bottom = mix(c01, c11, frac.x);
  return mix(top, bottom, frac.y);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let position = in.pos.xy;
  let source = textureLoad(below, vec2i(position), 0);
  let rect_min = op.v[0].xy;
  let rect_max = op.v[0].zw;
  if (any(position < rect_min) || any(position >= rect_max)) {
    return source;
  }

  let dims = vec2i(textureDimensions(mask));
  let mask_at = clamp(vec2i(position), vec2i(0, 0), dims - vec2i(1, 1));
  let coverage = textureLoad(mask, mask_at, 0).r * op.opacity;
  if (coverage <= 0.0) {
    return source;
  }

  // Where this pixel sits inside the rect, then inside the result texture.
  let unit = (position - rect_min) / max(rect_max - rect_min, vec2f(1.0));
  let encoded = sample_result(unit * op.v[1].xy);
  let linear = vec3f(eotf(encoded.r), eotf(encoded.g), eotf(encoded.b));
  return vec4f(mix(source.rgb, linear, coverage), source.a);
}

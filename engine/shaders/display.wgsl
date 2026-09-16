// Final pass: linear proxy -> rgba8 display frame. Clamp, sRGB OETF, letterbox bars.
// The target is rgba8unorm, not rgba8unorm-srgb, so the OETF is applied here and only here.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

struct Frame {
  content_min: vec2f,
  content_max: vec2f,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> frame: Frame;

fn oetf(c: f32) -> f32 {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let p = in.pos.xy;
  if (any(p < frame.content_min) || any(p >= frame.content_max)) {
    return vec4f(0.08, 0.08, 0.09, 1.0);
  }
  let c = clamp(textureLoad(src, vec2i(p), 0).rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(oetf(c.r), oetf(c.g), oetf(c.b), 1.0);
}

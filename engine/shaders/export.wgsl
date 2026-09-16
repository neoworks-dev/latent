// Export's last pass: the linear working image (sRGB primaries, see
// src/export/color_space.h) -> the chosen output space, written as rgba16uint so the
// readback is exact 16-bit integers and needs no half-float decode on the CPU.
//
// It is display.wgsl's job with two differences: a 3x3 primary conversion in front of the
// curve, and no letterbox — an export has no bars, the content is the whole texture.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Matches ExportUniform in src/pipeline/renderer.cpp and ColorTransform in
// src/export/color_space.h: the rows of the matrix, then gamma in params.x, where 0 means
// the sRGB piecewise curve.
struct Output {
  m0: vec4f,
  m1: vec4f,
  m2: vec4f,
  params: vec4f,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> out_params: Output;

fn encode(c: f32, gamma: f32) -> f32 {
  if (gamma == 0.0) {
    if (c <= 0.0031308) { return 12.92 * c; }
    return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  }
  return pow(c, 1.0 / gamma);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<u32> {
  let linear = textureLoad(src, vec2i(in.pos.xy), 0).rgb;
  let converted = vec3f(dot(out_params.m0.xyz, linear), dot(out_params.m1.xyz, linear),
                        dot(out_params.m2.xyz, linear));
  let c = clamp(converted, vec3f(0.0), vec3f(1.0));
  let g = out_params.params.x;
  let encoded = vec3f(encode(c.r, g), encode(c.g, g), encode(c.b, g));
  return vec4<u32>(vec3<u32>(round(encoded * 65535.0)), 65535u);
}

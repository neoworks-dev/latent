// Horizontal half of every neighbourhood op: one pass over the proxy that writes a
// scratch rgba16float, which neighborhood.wgsl finishes vertically and combines with the
// original. Two separable passes instead of one square kernel is what keeps clarity and
// noise reduction inside the frame budget.
//
// `kind` picks the filter; the radius comes from the CPU in v[6].x, already in proxy
// pixels. Sampling is clamped to the image rect so the letterbox bars never bleed in.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Keep in sync with OpUniform in src/pipeline/renderer.cpp and the copy in ops.wgsl.
struct OpParams {
  origin: vec2f,
  size: vec2f,
  kind: u32,
  opacity: f32,  // unused here: the blend happens in neighborhood.wgsl's combine pass
  pad1: u32,
  pad2: u32,
  v: array<vec4f, 7>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> op: OpParams;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn tap(x: i32, y: i32) -> vec3f {
  let low = vec2i(op.origin);
  let high = vec2i(op.origin + op.size) - vec2i(1, 1);
  return textureLoad(src, clamp(vec2i(x, y), low, high), 0).rgb;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let centre = vec2i(in.pos.xy);
  let radius = i32(op.v[6].x);
  let sigma = max(op.v[6].x * 0.5, 0.5);
  let middle = tap(centre.x, centre.y);

  // dehaze: the horizontal half of the dark-channel estimate. A gaussian rather than the
  // textbook minimum, because a min filter's halo around a dark subject is a hard ring
  // and a blur's is a gradient nobody sees.
  if (op.kind == 102u) {
    var dark = 0.0;
    var dark_weight = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
      let c = tap(centre.x + i, centre.y);
      let weight = exp(-0.5 * f32(i * i) / (sigma * sigma));
      dark = dark + min(c.r, min(c.g, c.b)) * weight;
      dark_weight = dark_weight + weight;
    }
    return vec4f(middle, dark / max(dark_weight, 1e-5));
  }

  // noise_reduction: bilateral, so an edge is not dragged across.
  if (op.kind == 103u) {
    let range = mix(0.15, 0.02, op.v[0].y);
    let centre_luma = luma(middle);
    var sum = vec3f(0.0);
    var weight_sum = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
      let c = tap(centre.x + i, centre.y);
      let spatial = exp(-0.5 * f32(i * i) / (sigma * sigma));
      let difference = (luma(c) - centre_luma) / range;
      let weight = spatial * exp(-0.5 * difference * difference);
      sum = sum + c * weight;
      weight_sum = weight_sum + weight;
    }
    return vec4f(sum / max(weight_sum, 1e-5), 1.0);
  }

  // Everything else is a plain gaussian: texture, clarity, sharpening, both chroma ops.
  var sum = vec3f(0.0);
  var weight_sum = 0.0;
  for (var i = -radius; i <= radius; i = i + 1) {
    let weight = exp(-0.5 * f32(i * i) / (sigma * sigma));
    sum = sum + tap(centre.x + i, centre.y) * weight;
    weight_sum = weight_sum + weight;
  }
  return vec4f(sum / max(weight_sum, 1e-5), 1.0);
}

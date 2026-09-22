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

// The range windows manual_denoise filters through, sized from what sensor noise actually is
// sensor noise is proportional to signal, so a fixed threshold either misses it in the
// highlights or eats the shadows. The floor keeps a near-black frame — where high-ISO noise
// is worst and the signal is smallest — from collapsing the window to nothing. Chroma gets
// the far looser window: colour noise arrives as multi-pixel blobs and real colour edges are
// rare, so smoothing across them costs nothing a viewer can see. Each coarser level halves
// the window, because the level below already averaged its noise away and what reaches this
// one is mostly signal. Duplicated in neighborhood.wgsl, which finishes the pass.
fn denoise_sigmas(signal: f32, detail: f32, colour_detail: f32, level: f32) -> vec2f {
  // Sensor noise is read noise plus photon noise: a floor that does not care how dark the
  // pixel is, and a term that grows as the square root of the signal. A window proportional
  // to the signal instead — the obvious thing — is far too tight in the shadows, which is
  // exactly where high-ISO noise lives, and that is what makes a naive bilateral useless on
  // a lifted night frame.
  let noise = sqrt(0.000016 + (0.0016 * max(signal, 0.0)));
  let falloff = pow(0.6, level);
  let light = mix(4.0, 0.5, clamp(detail, 0.0, 1.0)) * noise * falloff;
  let colour = mix(14.0, 1.5, clamp(colour_detail, 0.0, 1.0)) * noise * falloff;
  return vec2f(max(light, 1e-5), max(colour, 1e-5));
}

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

  // manual_denoise: the horizontal half of one à trous wavelet level. The taps are the
  // B3 spline [1 4 6 4 1], spread `step` pixels apart — one level covers five pixels, the
  // next ten, the third twenty, which is the reach chroma blobs need and a radius-3
  // bilateral never had. Two filters run in the same pass because the two kinds of noise
  // want different windows: `rgb` carries the loosely filtered colour and `a` the tightly
  // filtered luminance, and neighborhood.wgsl finishes both vertically.
  if (op.kind == 108u) {
    let step = max(i32(op.v[6].x), 1);
    // The reference the taps are judged against is the three centre taps averaged, not the
    // centre pixel itself. A pixel that is its own reference always weighs 1, so a single
    // outlier — the dark speckles a hot pixel or a deep-shadow draw leaves — keeps full
    // weight while every neighbour is rejected, and survives the filter untouched at any
    // strength. Averaging first means the speckle is the one tap that gets thrown away.
    let reference = luma(tap(centre.x - step, centre.y) + middle + tap(centre.x + step, centre.y)) /
                    3.0;
    let centre_luma = reference;
    let sigmas = denoise_sigmas(centre_luma, op.v[0].y, op.v[0].w, op.v[6].y);
    var spline = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
    var colour = vec3f(0.0);
    var colour_weight = 0.0;
    var light = 0.0;
    var light_weight = 0.0;
    for (var i = -2; i <= 2; i = i + 1) {
      let c = tap(centre.x + i * step, centre.y);
      let spatial = spline[i + 2];
      let difference = luma(c) - centre_luma;
      let light_weighting = spatial * exp(-0.5 * difference * difference / (sigmas.x * sigmas.x));
      let colour_weighting = spatial * exp(-0.5 * difference * difference / (sigmas.y * sigmas.y));
      colour = colour + c * colour_weighting;
      colour_weight = colour_weight + colour_weighting;
      light = light + luma(c) * light_weighting;
      light_weight = light_weight + light_weighting;
    }
    return vec4f(colour / max(colour_weight, 1e-5), light / max(light_weight, 1e-5));
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

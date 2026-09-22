// Vertical half of every neighbourhood op, plus the combine with the untouched source.
// `src` is what the op was handed, `mid` is blur.wgsl's horizontal pass over it, so a
// tap here is a full 2D kernel for the cost of two 1D ones.
// Kind numbers must match OpKind in src/pipeline/renderer.h.
//
// Parameter packing, per kind, matching op_uniform() in src/pipeline/renderer.cpp:
//   100 texture              v0.x amount            v6.x radius
//   101 clarity              v0.x amount            v6.x radius
//   102 dehaze               v0.x amount, v0.y airlight, v6.x radius
//   103 noise_reduction      v0 = luminance, detail, contrast
//   104 color_noise_...      v0 = amount, detail, smoothness
//   105 sharpening           v0 = amount, detail, masking
//   106 defringe             v0 = purple amount, hue low, hue high; v1 = the same in green
//   107 chromatic_aberration v6.x radius
//   108 manual_denoise       v0 = luminance, detail, color, colorDetail
//                            v6.x = tap spacing of this à trous level, v6.y = level index

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
  opacity: f32,
  pad1: u32,
  pad2: u32,
  v: array<vec4f, 7>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var mid: texture_2d<f32>;
@group(0) @binding(2) var<uniform> op: OpParams;
// The op's combined mask, r8; a 1x1 white texture when the op has none. A neighbourhood
// op blends here, in its combine pass, not in the blur that feeds it: the filter still
// reads unmasked pixels, so an edge of the mask does not become an edge in the filter.
@group(0) @binding(3) var mask: texture_2d<f32>;

fn mask_at(position: vec2f) -> f32 {
  let dims = vec2i(textureDimensions(mask));
  let at = clamp(vec2i(position), vec2i(0, 0), dims - vec2i(1, 1));
  return textureLoad(mask, at, 0).r * op.opacity;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Kept in step with the copy in blur.wgsl: the two halves of one à trous level have to
// weight their taps the same way or the filter is not separable any more.
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

fn tone_position(c: vec3f) -> f32 {
  return clamp(pow(max(luma(c), 0.0), 1.0 / 2.2), 0.0, 1.0);
}

fn clamped(p: vec2i) -> vec2i {
  let low = vec2i(op.origin);
  let high = vec2i(op.origin + op.size) - vec2i(1, 1);
  return clamp(p, low, high);
}

fn source_tap(x: i32, y: i32) -> vec3f {
  return textureLoad(src, clamped(vec2i(x, y)), 0).rgb;
}

fn mid_tap(x: i32, y: i32) -> vec4f {
  return textureLoad(mid, clamped(vec2i(x, y)), 0);
}

fn gaussian_column(centre: vec2i, radius: i32, sigma: f32) -> vec3f {
  var sum = vec3f(0.0);
  var weight_sum = 0.0;
  for (var i = -radius; i <= radius; i = i + 1) {
    let weight = exp(-0.5 * f32(i * i) / (sigma * sigma));
    sum = sum + mid_tap(centre.x, centre.y + i).rgb * weight;
    weight_sum = weight_sum + weight;
  }
  return sum / max(weight_sum, 1e-5);
}

fn bilateral_column(centre: vec2i, radius: i32, sigma: f32, range: f32, centre_luma: f32) -> vec3f {
  var sum = vec3f(0.0);
  var weight_sum = 0.0;
  for (var i = -radius; i <= radius; i = i + 1) {
    let c = mid_tap(centre.x, centre.y + i).rgb;
    let spatial = exp(-0.5 * f32(i * i) / (sigma * sigma));
    let difference = (luma(c) - centre_luma) / range;
    let weight = spatial * exp(-0.5 * difference * difference);
    sum = sum + c * weight;
    weight_sum = weight_sum + weight;
  }
  return sum / max(weight_sum, 1e-5);
}

fn dark_column(centre: vec2i, radius: i32, sigma: f32) -> f32 {
  var dark = 0.0;
  var weight_sum = 0.0;
  for (var i = -radius; i <= radius; i = i + 1) {
    let weight = exp(-0.5 * f32(i * i) / (sigma * sigma));
    dark = dark + mid_tap(centre.x, centre.y + i).a * weight;
    weight_sum = weight_sum + weight;
  }
  return dark / max(weight_sum, 1e-5);
}

// Sobel magnitude, on the perceptual position rather than on linear luminance: a
// threshold in linear light would mean something different in every exposure, and this is
// the measure the sharpening mask and both fringe ops key off.
fn edge_strength(centre: vec2i) -> f32 {
  let tl = tone_position(source_tap(centre.x - 1, centre.y - 1));
  let tc = tone_position(source_tap(centre.x, centre.y - 1));
  let tr = tone_position(source_tap(centre.x + 1, centre.y - 1));
  let ml = tone_position(source_tap(centre.x - 1, centre.y));
  let mr = tone_position(source_tap(centre.x + 1, centre.y));
  let bl = tone_position(source_tap(centre.x - 1, centre.y + 1));
  let bc = tone_position(source_tap(centre.x, centre.y + 1));
  let br = tone_position(source_tap(centre.x + 1, centre.y + 1));
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  return sqrt(gx * gx + gy * gy);
}

fn hue_degrees(c: vec3f) -> f32 {
  let high = max(c.r, max(c.g, c.b));
  let low = min(c.r, min(c.g, c.b));
  let chroma = high - low;
  if (chroma <= 1e-6) { return 0.0; }
  var hue = 0.0;
  if (high == c.r) { hue = (c.g - c.b) / chroma; }
  else if (high == c.g) { hue = 2.0 + (c.b - c.r) / chroma; }
  else { hue = 4.0 + (c.r - c.g) / chroma; }
  return fract(hue / 6.0) * 360.0;
}

// How far inside [low, high] a hue sits, with a 15 degree soft edge on either side.
fn hue_window(hue: f32, low: f32, high: f32) -> f32 {
  return smoothstep(low - 15.0, low, hue) * (1.0 - smoothstep(high, high + 15.0, hue));
}

fn desaturate(rgb: vec3f, amount: f32) -> vec3f {
  return mix(rgb, vec3f(luma(rgb)), clamp(amount, 0.0, 1.0));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let centre = vec2i(in.pos.xy);
  let source = textureLoad(src, centre, 0).rgb;
  let radius = i32(op.v[6].x);
  let sigma = max(op.v[6].x * 0.5, 0.5);
  var rgb = source;

  switch (op.kind) {
    // texture: fine-detail unsharp that leaves colour and overall tone alone.
    case 100u: {
      let amount = op.v[0].x;
      if (amount == 0.0) { break; }
      let detail = source - gaussian_column(centre, radius, sigma);
      rgb = source + detail * amount * 1.5;
    }
    // clarity: the same idea at a much larger radius, held to the midtones so highlights
    // do not halo.
    case 101u: {
      let amount = op.v[0].x;
      if (amount == 0.0) { break; }
      let blurred = gaussian_column(centre, radius, sigma);
      let position = tone_position(source);
      let weight = mix(0.35, 1.0, 4.0 * position * (1.0 - position));
      rgb = source + (source - blurred) * amount * weight;
    }
    // dehaze: dark-channel prior. Positive divides the haze back out, negative mixes the
    // airlight back in.
    case 102u: {
      let amount = op.v[0].x;
      if (amount == 0.0) { break; }
      let airlight = op.v[0].y;
      // Half the neighbourhood's dark channel, half the pixel's own: the neighbourhood
      // keeps the estimate stable over texture and noise, the pixel keeps the correction
      // following the picture instead of glowing around whatever is darkest nearby.
      let own = min(source.r, min(source.g, source.b));
      let dark = mix(dark_column(centre, radius, sigma), own, 0.5);
      if (amount > 0.0) {
        let transmission = clamp(1.0 - 0.95 * amount * (dark / max(airlight, 1e-3)), 0.15, 1.0);
        rgb = max((source - airlight) / transmission + airlight, vec3f(0.0));
      } else {
        rgb = mix(source, vec3f(airlight), -amount * 0.5 * (1.0 - tone_position(source) * 0.5));
      }
    }
    // noise_reduction: bilateral smoothing of luminance only, so colour never shifts.
    case 103u: {
      let strength = op.v[0].x;
      if (strength <= 0.0) { break; }
      let centre_luma = luma(source);
      let range = mix(0.15, 0.02, op.v[0].y);
      let smoothed = bilateral_column(centre, radius, sigma, range, centre_luma);
      // Contrast gives back part of what the filter took, which is what Lightroom's
      // Contrast slider does: cleaner at 0, blotchier but punchier at 100.
      let wanted = mix(luma(smoothed), centre_luma, op.v[0].z * 0.5);
      rgb = source * (mix(centre_luma, wanted, strength) / max(centre_luma, 1e-4));
    }
    // color_noise_reduction: blur the chroma, keep the luminance, protect real colour
    // edges with Detail.
    case 104u: {
      let amount = op.v[0].x;
      if (amount <= 0.0) { break; }
      let blurred = gaussian_column(centre, radius, sigma);
      let centre_luma = luma(source);
      let chroma = source - centre_luma;
      let blurred_chroma = blurred - luma(blurred);
      // Relative to the pixel's own level, so Detail means the same thing in a bright
      // frame and a dark one.
      let edge = length(chroma - blurred_chroma) / max(centre_luma, 1e-3);
      let protect = smoothstep(0.0, mix(0.4, 0.02, op.v[0].y), edge);
      rgb = centre_luma + mix(chroma, blurred_chroma, amount * (1.0 - protect));
    }
    // sharpening: unsharp mask, Detail weights the high frequencies, Masking keeps it off
    // flat areas.
    case 105u: {
      let amount = op.v[0].x;
      if (amount <= 0.0) { break; }
      let blurred = gaussian_column(centre, radius, sigma);
      let detail = source - blurred;
      let mask = mix(1.0, smoothstep(0.02, 0.35, edge_strength(centre)), op.v[0].z);
      rgb = source + detail * amount * mix(0.6, 1.6, op.v[0].y) * mask;
    }
    // defringe: desaturate the purple and green hue windows where an edge is steep.
    case 106u: {
      let hue = hue_degrees(source);
      let edge = smoothstep(0.05, 0.4, edge_strength(centre));
      let purple = op.v[0].x * hue_window(hue, op.v[0].y, op.v[0].z);
      let green = op.v[1].x * hue_window(hue, op.v[1].y, op.v[1].z);
      rgb = desaturate(source, edge * max(purple, green));
    }
    // manual_denoise: the vertical half of one à trous level, then the mix back. `mid` is
    // blur.wgsl's horizontal pass, so `mid.rgb` is already colour-filtered and `mid.a`
    // already luminance-filtered, and the range weight keys off `mid.a` — a luminance that
    // has had a pass of noise taken out of it is a far steadier edge detector than the raw
    // pixel is at ISO 12800.
    case 108u: {
      let step = max(i32(op.v[6].x), 1);
      // Same outlier rule as the horizontal half: the reference is the three centre taps
      // averaged, so a speckle cannot vouch for itself.
      let centre_light = (mid_tap(centre.x, centre.y - step).a + mid_tap(centre.x, centre.y).a +
                          mid_tap(centre.x, centre.y + step).a) /
                         3.0;
      let sigmas = denoise_sigmas(centre_light, op.v[0].y, op.v[0].w, op.v[6].y);
      var spline = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
      var colour = vec3f(0.0);
      var colour_weight = 0.0;
      var light = 0.0;
      var light_weight = 0.0;
      for (var i = -2; i <= 2; i = i + 1) {
        let c = mid_tap(centre.x, centre.y + i * step);
        let spatial = spline[i + 2];
        let difference = c.a - centre_light;
        let light_weighting = spatial * exp(-0.5 * difference * difference / (sigmas.x * sigmas.x));
        let colour_weighting =
            spatial * exp(-0.5 * difference * difference / (sigmas.y * sigmas.y));
        colour = colour + c.rgb * colour_weighting;
        colour_weight = colour_weight + colour_weighting;
        light = light + c.a * light_weighting;
        light_weight = light_weight + light_weighting;
      }
      let filtered_colour = colour / max(colour_weight, 1e-5);
      let filtered_light = light / max(light_weight, 1e-5);
      let source_light = luma(source);
      // The two sliders mix their own half back and nothing else: Luminance moves only the
      // brightness, Color only the offset from grey. A run at Color 100 and Luminance 0 is
      // exactly what a high-ISO frame usually wants — the blotches gone, the grain intact.
      // Each of the three levels mixes at the full slider value, so the levels compound:
      // 50 is a real denoise, not half of one.
      let out_light = mix(source_light, filtered_light, clamp(op.v[0].x, 0.0, 1.0));
      let out_chroma = mix(source - source_light, filtered_colour - luma(filtered_colour),
                           clamp(op.v[0].z, 0.0, 1.0));
      rgb = max(out_light + out_chroma, vec3f(0.0));
    }
    // chromatic_aberration: lateral fringes are chroma that only exists at a steep edge,
    // so pull the chroma there towards the local average and halve what is left. Without
    // a lens profile this is a suppressor, not a geometric correction.
    case 107u: {
      let blurred = gaussian_column(centre, radius, sigma);
      let centre_luma = luma(source);
      let chroma = source - centre_luma;
      let blurred_chroma = blurred - luma(blurred);
      let edge = smoothstep(0.08, 0.45, edge_strength(centre));
      rgb = centre_luma + mix(chroma, blurred_chroma * 0.5, edge);
    }
    default: {}
  }
  return vec4f(mix(source, rgb, mask_at(in.pos.xy)), 1.0);
}

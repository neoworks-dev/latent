// One fragment pass per per-pixel op, ping-ponging two rgba16float proxies. `kind`
// selects the op; `v` carries its parameters, already normalised on the CPU.
// Kind numbers must match OpKind in src/pipeline/renderer.h. Ops that need a
// neighbourhood live in blur.wgsl + neighborhood.wgsl instead.
//
// Tone ops multiply by a scalar gain derived from a luma weight, so hue is preserved and
// every op is neutral at its default and monotonic in its parameter. They approximate
// Lightroom's curves rather than reproducing them.
//
// The working space is linear, sRGB primaries (raw_decode.cpp), 1.0 = diffuse white.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Keep in sync with OpUniform in src/pipeline/renderer.cpp, and with the copies in
// blur.wgsl and neighborhood.wgsl. vec2f first so the u32 pair cannot split an alignment.
struct OpParams {
  origin: vec2f,  // image rect inside the letterboxed view, in pixels
  size: vec2f,
  kind: u32,
  // Layer opacity 0..1, and two words of padding so `v` starts on the 16-byte boundary a
  // vec4f needs. A uniform array<u32, 2> would not do: in the uniform address space its
  // stride is 16.
  opacity: f32,
  pad1: u32,
  pad2: u32,
  v: array<vec4f, 7>,
};

// 256 entries of the tone curve: .x/.y/.z are the red/green/blue outputs for the input
// the entry indexes, in the display-referred domain. Bound at a per-op dynamic offset.
struct CurveLut {
  entries: array<vec4f, 256>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> op: OpParams;
@group(0) @binding(2) var<uniform> curve: CurveLut;
// The op's combined mask (shaders/mask.wgsl), r8. An unmasked op binds a 1x1 white
// texture, which the clamp below turns into "everywhere" for free.
@group(0) @binding(3) var mask: texture_2d<f32>;

// out = mix(in, op(in), mask * opacity) — PROMPT.md 3.7, and the only place an op's
// result is allowed to be partial.
fn mask_at(position: vec2f) -> f32 {
  let dims = vec2i(textureDimensions(mask));
  let at = clamp(vec2i(position), vec2i(0, 0), dims - vec2i(1, 1));
  return textureLoad(mask, at, 0).r * op.opacity;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Rough perceptual position of a linear value, used only to weight the tone ops.
fn tone_position(c: vec3f) -> f32 {
  return clamp(pow(max(luma(c), 0.0), 1.0 / 2.2), 0.0, 1.0);
}

fn rgb_to_hsv(c: vec3f) -> vec3f {
  let high = max(c.r, max(c.g, c.b));
  let low = min(c.r, min(c.g, c.b));
  let chroma = high - low;
  var hue = 0.0;
  if (chroma > 1e-6) {
    if (high == c.r) { hue = (c.g - c.b) / chroma; }
    else if (high == c.g) { hue = 2.0 + (c.b - c.r) / chroma; }
    else { hue = 4.0 + (c.r - c.g) / chroma; }
    hue = fract(hue / 6.0);
  }
  let saturation = select(0.0, chroma / high, high > 1e-6);
  return vec3f(hue, saturation, high);
}

fn hsv_to_rgb(c: vec3f) -> vec3f {
  let h = fract(c.x) * 6.0;
  let i = floor(h);
  let f = h - i;
  let p = c.z * (1.0 - c.y);
  let q = c.z * (1.0 - c.y * f);
  let t = c.z * (1.0 - c.y * (1.0 - f));
  if (i < 1.0) { return vec3f(c.z, t, p); }
  if (i < 2.0) { return vec3f(q, c.z, p); }
  if (i < 3.0) { return vec3f(p, c.z, t); }
  if (i < 4.0) { return vec3f(p, q, c.z); }
  if (i < 5.0) { return vec3f(t, p, c.z); }
  return vec3f(c.z, p, q);
}

// The curve is drawn on gamma-encoded axes, so the lookup encodes, interpolates between
// the two neighbouring entries, and decodes. Anything above diffuse white keeps its
// headroom instead of being clipped into the table.
fn apply_curve(rgb: vec3f) -> vec3f {
  let clamped = clamp(rgb, vec3f(0.0), vec3f(1.0));
  let position = pow(clamped, vec3f(1.0 / 2.2)) * 255.0;
  let low = vec3u(clamp(position, vec3f(0.0), vec3f(255.0)));
  let high = min(low + vec3u(1u), vec3u(255u));
  let t = position - floor(position);
  let out = vec3f(mix(curve.entries[low.x].x, curve.entries[high.x].x, t.x),
                  mix(curve.entries[low.y].y, curve.entries[high.y].y, t.y),
                  mix(curve.entries[low.z].z, curve.entries[high.z].z, t.z));
  return pow(max(out, vec3f(0.0)), vec3f(2.2)) + max(rgb - 1.0, vec3f(0.0));
}

// The eight Color Mixer bands, at Lightroom's hue centres in degrees.
const kBandHues = array<f32, 8>(0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 285.0, 315.0);

fn band_weight(hue_degrees: f32, centre: f32) -> f32 {
  let delta = abs(fract((hue_degrees - centre) / 360.0 + 0.5) - 0.5) * 360.0;
  return max(0.0, 1.0 - delta / 60.0);
}

// One Color Grading range: push the hue of the tint in without moving luminance, then
// apply the range's own luminance offset.
fn grade(rgb: vec3f, hue: f32, saturation: f32, luminance: f32, weight: f32) -> vec3f {
  if (weight <= 0.0 || (saturation <= 0.0 && luminance == 0.0)) { return rgb; }
  let tint = hsv_to_rgb(vec3f(hue / 360.0, 1.0, 1.0));
  let tinted = rgb * (tint / max(luma(tint), 1e-4));
  let mixed = mix(rgb, tinted, clamp(saturation, 0.0, 1.0) * weight);
  return mixed * exp2(luminance * 0.5 * weight);
}

// Value noise: one hash per lattice cell, bilinear between them.
fn hash21(p: vec2f) -> f32 {
  let h = fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
  return h;
}

fn value_noise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash21(cell);
  let b = hash21(cell + vec2f(1.0, 0.0));
  let c = hash21(cell + vec2f(0.0, 1.0));
  let d = hash21(cell + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// Distance from the centre of the image rect, 1.0 at the edge midpoints. `roundness`
// bends it from an ellipse that follows the frame (0) towards a circle in pixels (+1).
fn vignette_radius(position: vec2f, roundness: f32) -> f32 {
  let d = ((position - op.origin) / op.size - 0.5) * 2.0;
  let aspect = op.size.x / max(op.size.y, 1.0);
  return length(vec2f(d.x * pow(aspect, -clamp(roundness, -1.0, 1.0)), d.y));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = textureLoad(src, vec2i(in.pos.xy), 0);
  var rgb = texel.rgb;
  let v = op.v[0].x;
  switch (op.kind) {
    // white_balance: channel multipliers computed from temperature/tint or from Kelvin.
    case 1u: {
      rgb = rgb * op.v[0].rgb;
    }
    // exposure, in stops.
    case 2u: {
      rgb = rgb * exp2(v);
    }
    // contrast: power curve pivoted on mid grey.
    case 3u: {
      let slope = exp2(0.6 * v);
      rgb = 0.18 * pow(max(rgb, vec3f(1e-5)) / 0.18, vec3f(slope));
    }
    // highlights: upper half only.
    case 4u: {
      let w = smoothstep(0.5, 1.0, tone_position(rgb));
      rgb = rgb * exp2(0.7 * v * w);
    }
    // shadows: lower half only.
    case 5u: {
      let w = 1.0 - smoothstep(0.0, 0.5, tone_position(rgb));
      rgb = rgb * exp2(0.7 * v * w);
    }
    // whites: ramp weighted towards the top end.
    case 6u: {
      let w = tone_position(rgb);
      rgb = rgb * exp2(0.5 * v * w);
    }
    // blacks: ramp weighted towards the bottom end.
    case 7u: {
      let w = 1.0 - tone_position(rgb);
      rgb = rgb * exp2(0.5 * v * w);
    }
    // saturation: linear blend against luma.
    case 8u: {
      rgb = mix(vec3f(luma(rgb)), rgb, 1.0 + v);
    }
    // vibrance: same blend, scaled down where the pixel is already saturated.
    case 9u: {
      let high = max(rgb.r, max(rgb.g, rgb.b));
      let low = min(rgb.r, min(rgb.g, rgb.b));
      let sat = clamp((high - low) / max(high, 1e-5), 0.0, 1.0);
      rgb = mix(vec3f(luma(rgb)), rgb, 1.0 + v * (1.0 - sat));
    }
    // tone_curve: the parametric regions and every point curve, baked into one table.
    case 10u: {
      rgb = apply_curve(rgb);
    }
    // color_mixer: eight hue bands, each with a hue shift, a saturation scale and a gain.
    case 11u: {
      let hsv = rgb_to_hsv(rgb);
      let hue_degrees = hsv.x * 360.0;
      var weight_sum = 0.0;
      var hue_shift = 0.0;
      var saturation = 0.0;
      var luminance = 0.0;
      for (var band = 0u; band < 8u; band = band + 1u) {
        let w = band_weight(hue_degrees, kBandHues[band]);
        if (w <= 0.0) { continue; }
        // Three floats per band, packed across v[0]..v[5].
        let base = band * 3u;
        let values = vec3f(op.v[base / 4u][base % 4u],
                           op.v[(base + 1u) / 4u][(base + 1u) % 4u],
                           op.v[(base + 2u) / 4u][(base + 2u) % 4u]);
        weight_sum = weight_sum + w;
        hue_shift = hue_shift + w * values.x;
        saturation = saturation + w * values.y;
        luminance = luminance + w * values.z;
      }
      if (weight_sum > 1e-4) {
        let norm = 1.0 / weight_sum;
        let shifted = vec3f(fract(hsv.x + hue_shift * norm * 30.0 / 360.0),
                            clamp(hsv.y * (1.0 + saturation * norm), 0.0, 1.0), hsv.z);
        rgb = hsv_to_rgb(shifted) * exp2(luminance * norm * 0.5);
      }
    }
    // color_grading: shadow/midtone/highlight/global tints with blending and balance.
    case 12u: {
      let position = tone_position(rgb);
      let balance = op.v[4].y * 0.25;
      let width = mix(0.15, 0.5, op.v[4].x);
      let shadow_weight = 1.0 - smoothstep(0.25 + balance - width, 0.25 + balance + width, position);
      let highlight_weight = smoothstep(0.75 + balance - width, 0.75 + balance + width, position);
      let midtone_weight = max(0.0, 1.0 - shadow_weight - highlight_weight);
      rgb = grade(rgb, op.v[0].x, op.v[0].y, op.v[0].z, shadow_weight);
      rgb = grade(rgb, op.v[1].x, op.v[1].y, op.v[1].z, midtone_weight);
      rgb = grade(rgb, op.v[2].x, op.v[2].y, op.v[2].z, highlight_weight);
      rgb = grade(rgb, op.v[3].x, op.v[3].y, op.v[3].z, 1.0);
    }
    // lens_correction, vignetting half: a radial gain that lifts or drops the corners.
    case 13u: {
      let r = vignette_radius(in.pos.xy, 0.0);
      rgb = rgb * exp2(v * 1.2 * r * r);
    }
    // vignette: the Effects one, with midpoint, feather, roundness and highlight rescue.
    case 14u: {
      let amount = op.v[0].x;
      let midpoint = op.v[0].y;
      let feather = op.v[0].z;
      let r = vignette_radius(in.pos.xy, op.v[0].w);
      let centre = mix(0.05, 1.2, midpoint);
      var t = smoothstep(centre * (1.0 - 0.5 * feather), centre * (1.0 + 0.8 * feather) + 0.05, r);
      // Highlights only defends the bright pixels, and only when the corners go dark.
      if (amount < 0.0) {
        t = t * (1.0 - op.v[1].x * smoothstep(0.4, 1.0, tone_position(rgb)));
      }
      rgb = rgb * exp2(amount * 1.5 * t);
    }
    // grain: two octaves of value noise on luminance, strongest in the midtones.
    case 15u: {
      let amount = op.v[0].x;
      let cell = mix(6.0, 0.8, op.v[0].y);
      let roughness = op.v[0].z;
      let p = in.pos.xy / cell;
      let n = mix(value_noise(p), mix(value_noise(p), value_noise(p * 2.7 + 11.3), 0.5), roughness);
      let position = tone_position(rgb);
      let midtones = 4.0 * position * (1.0 - position);
      rgb = rgb * exp2(amount * 0.7 * (n - 0.5) * midtones);
    }
    default: {}
  }
  return vec4f(mix(texel.rgb, rgb, mask_at(in.pos.xy)), 1.0);
}

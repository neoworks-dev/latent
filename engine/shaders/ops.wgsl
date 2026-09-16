// One fragment pass per op in the stack, ping-ponging two rgba16float proxies. `kind`
// selects the op; `a` carries its parameters, already normalised on the CPU.
// Kind numbers must match OpKind in src/pipeline/renderer.h.
//
// Tone ops multiply by a scalar gain derived from a luma weight, so hue is preserved and
// every op is neutral at its default and monotonic in its parameter. They approximate
// Lightroom's curves rather than reproducing them.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

struct OpParams {
  a: vec4f,
  kind: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> op: OpParams;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Rough perceptual position of a linear value, used only to weight the tone ops.
fn tone_position(c: vec3f) -> f32 {
  return clamp(pow(max(luma(c), 0.0), 1.0 / 2.2), 0.0, 1.0);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = textureLoad(src, vec2i(in.pos.xy), 0);
  var rgb = texel.rgb;
  let v = op.a.x;
  switch (op.kind) {
    // white_balance: relative channel multipliers computed from temperature/tint.
    case 1u: {
      rgb = rgb * op.a.rgb;
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
    default: {}
  }
  return vec4f(rgb, 1.0);
}

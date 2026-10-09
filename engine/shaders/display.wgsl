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

// `step` is 1 for a full frame and 2 for a draft (view.render `draft`): each destination pixel
// then averages the 2×2 block of view pixels it stands for, so a frame of half the bytes
// still shows every pixel's worth of the picture rather than every other one.
struct Frame {
  content_min: vec2f,
  content_max: vec2f,
  step: vec2f,
  // The view's own size: a draft of an odd-sized view has a last column or row whose 2×2
  // block runs one pixel off the source, and that tap reads the edge pixel again.
  size: vec2f,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> frame: Frame;

fn oetf(c: f32) -> f32 {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// One view pixel, display-encoded: the photo through the OETF, or the letterbox bar.
fn shade(tap: vec2f) -> vec3f {
  let p = min(tap, frame.size - vec2f(0.5));
  if (any(p < frame.content_min) || any(p >= frame.content_max)) {
    return vec3f(0.08, 0.08, 0.09);
  }
  let c = clamp(textureLoad(src, vec2i(p), 0).rgb, vec3f(0.0), vec3f(1.0));
  return vec3f(oetf(c.r), oetf(c.g), oetf(c.b));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let taps = vec2i(frame.step);
  let origin = floor(in.pos.xy) * frame.step;
  var sum = vec3f(0.0);
  for (var y = 0; y < taps.y; y = y + 1) {
    for (var x = 0; x < taps.x; x = x + 1) {
      sum = sum + shade(origin + vec2f(f32(x), f32(y)) + vec2f(0.5));
    }
  }
  return vec4f(sum / f32(taps.x * taps.y), 1.0);
}

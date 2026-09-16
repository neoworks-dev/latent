// Full-res linear -> view-sized linear proxy, box filtered. Runs once per view size,
// never per slider tick, so a wide box (up to 16x16 taps) is affordable and kills the
// aliasing a single bilinear tap would leave at 8:1 reduction ratios.
// Pixels outside the letterboxed image rect stay zero; display.wgsl paints the bars.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// vec2f aligns to 8; keep pairs together so C++ and WGSL agree on 32 bytes.
struct Fit {
  scale: vec2f,   // source texels per destination pixel
  offset: vec2f,  // source texel of destination pixel 0
  taps: vec2f,    // box size in source texels, >= 1
  size: vec2f,    // source texture size
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> fit: Fit;

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let base = floor(in.pos.xy * fit.scale + fit.offset);
  let taps = vec2i(max(fit.taps, vec2f(1.0)));
  var sum = vec3f(0.0);
  var count = 0.0;
  for (var y = 0; y < taps.y; y = y + 1) {
    for (var x = 0; x < taps.x; x = x + 1) {
      let coord = base + vec2f(f32(x), f32(y));
      if (any(coord < vec2f(0.0)) || any(coord >= fit.size)) { continue; }
      sum = sum + textureLoad(src, vec2i(coord), 0).rgb;
      count = count + 1.0;
    }
  }
  if (count == 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return vec4f(sum / count, 1.0);
}

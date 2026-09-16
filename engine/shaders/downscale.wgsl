// Full-res linear -> view-sized linear proxy, box filtered, and the only pass that moves
// pixels around: crop, straighten, rotate, flip, the Transform sliders and lens
// distortion are all folded into the destination -> source mapping here.
//
// It runs once per view size and once per change to any of those parameters, never per
// tone-slider tick, so a wide box (up to 16x16 taps) is affordable and kills the aliasing
// a single bilinear tap would leave at 8:1 reduction ratios.
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

// vec2f aligns to 8 and vec4f to 16; keep the pairs together so C++ and WGSL agree on
// 112 bytes. Matches FitUniform in src/pipeline/renderer.cpp.
struct Fit {
  scale: vec2f,   // source texels per destination pixel, for the box size
  taps: vec2f,    // box size in source texels, >= 1
  size: vec2f,    // source texture size
  origin: vec2f,  // image rect min inside the view, px
  extent: vec2f,  // image rect size inside the view, px
  flip: vec2f,    // -1 mirrors that axis of the source, 1 leaves it
  m0: vec4f,      // rows of the destination -> working-frame homography, xyz used
  m1: vec4f,
  m2: vec4f,
  params: vec4f,  // x: distortion k, y: working aspect, z: 90 degree quadrant
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> fit: Fit;

// Working frame (the image after rotate/flip, before crop) -> source, both 0..1.
fn to_source(working: vec2f) -> vec2f {
  var w = working;
  let quadrant = i32(fit.params.z + 0.5);
  if (quadrant == 1) { w = vec2f(w.y, 1.0 - w.x); }
  else if (quadrant == 2) { w = vec2f(1.0 - w.x, 1.0 - w.y); }
  else if (quadrant == 3) { w = vec2f(1.0 - w.y, w.x); }
  return select(w, 1.0 - w, fit.flip < vec2f(0.0));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  // Destination pixel -> 0..1 inside the image rect -> working frame, through the
  // homography that carries crop, straighten, perspective, scale and offset.
  let t = (in.pos.xy - fit.origin) / fit.extent;
  let h = vec3f(t, 1.0);
  let w = dot(fit.m2.xyz, h);
  if (abs(w) < 1e-6) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var working = vec2f(dot(fit.m0.xyz, h), dot(fit.m1.xyz, h)) / w;

  let k = fit.params.x;
  if (k != 0.0) {
    let aspect = vec2f(fit.params.y, 1.0);
    let norm = 1.0 / length(aspect);
    let centred = (working - 0.5) * 2.0 * aspect * norm;
    working = (centred * (1.0 + k * dot(centred, centred))) / (2.0 * aspect * norm) + 0.5;
  }
  if (any(working < vec2f(0.0)) || any(working > vec2f(1.0))) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // The box is centred on the mapped texel, not anchored at it, so the proxy does not
  // drift half a box towards the origin as the reduction ratio grows.
  let base = floor(to_source(working) * fit.size - (fit.scale - 1.0) * 0.5);
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

// Folds one mask component into the running combination, top-down (PROMPT.md 3.7).
// `accum` is everything above this component, `part` is the component mask.wgsl just
// rasterised; the result is the new accumulator. Mode numbers must match MaskMode's
// wire names in src/ops/mask.cpp:
//
//   0 replace    the first contributing component: there is nothing to fold it into yet
//   1 add        union, so two brushes side by side cover both areas and neither doubles
//   2 subtract   proportional, so a half-opacity eraser halves rather than clipping
//   3 intersect  product, the only reading of "both" that keeps partial coverage partial

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

struct CombineParams {
  mode: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var accum: texture_2d<f32>;
@group(0) @binding(1) var part: texture_2d<f32>;
@group(0) @binding(2) var<uniform> combine: CombineParams;

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let at = vec2i(in.pos.xy);
  let above = textureLoad(accum, at, 0).r;
  let here = textureLoad(part, at, 0).r;
  var out = here;
  switch (combine.mode) {
    case 1u: { out = max(above, here); }
    case 2u: { out = above * (1.0 - here); }
    case 3u: { out = above * here; }
    default: {}
  }
  return vec4f(clamp(out, 0.0, 1.0), 0.0, 0.0, 1.0);
}

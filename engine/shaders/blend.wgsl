// The pass that closes a group (PROMPT.md 3.7): everything its children did, mixed back
// into what the group was handed.
//
//   out = mix(below, branch, mask * opacity)
//
// `below` is the group's input — the frame as the passes under the group left it — and
// `branch` is that same frame with the group's adjustments run over all of it. Masking the
// blend rather than each child is the whole point of a group: a feathered edge is crossed
// once, so two sliders under one mask read as one local adjustment instead of two
// half-applied ones.
//
// A pixel the mask does not cover is returned verbatim, the same contract composite.wgsl
// holds: adding a layer cannot quietly resample the rest of the frame.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Keep in sync with OpUniform in src/pipeline/renderer.cpp: the group reads the same slot
// every other pass does, and uses only `opacity`.
struct OpParams {
  origin: vec2f,
  size: vec2f,
  kind: u32,
  opacity: f32,
  pad1: u32,
  pad2: u32,
  v: array<vec4f, 7>,
};

@group(0) @binding(0) var below: texture_2d<f32>;
@group(0) @binding(1) var<uniform> op: OpParams;
@group(0) @binding(2) var branch: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let at = vec2i(in.pos.xy);
  let source = textureLoad(below, at, 0);
  let dims = vec2i(textureDimensions(mask));
  let mask_at = clamp(at, vec2i(0, 0), dims - vec2i(1, 1));
  let coverage = textureLoad(mask, mask_at, 0).r * op.opacity;
  if (coverage <= 0.0) {
    return source;
  }
  let above = textureLoad(branch, at, 0);
  return vec4f(mix(source.rgb, above.rgb, coverage), source.a);
}

// Pass 0: camera rgba16uint from LibRaw -> linear rgba16float scaled to [0,1].
// LibRaw already applied black/white level and the camera matrix, so this is a divide.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

@group(0) @binding(0) var src: texture_2d<u32>;

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = textureLoad(src, vec2i(in.pos.xy), 0);
  return vec4f(vec3f(texel.rgb) / 65535.0, 1.0);
}

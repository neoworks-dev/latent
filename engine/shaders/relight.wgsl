// The `relight` op: a virtual light placed in the scene, shaded against the monocular
// depth map (engine/src/ai/depth.h) and marched toward for volumetric shafts.
//
// Two passes through this one module, selected by `params.pass_index`, because the second
// needs the first as a texture:
//
//   0  shafts     For every view pixel, march toward the light's screen position and ask
//                 at each step whether the *surface* there sits behind the light. Where it
//                 does, the air on that line of sight is lit; where a tree branch or a
//                 shoulder is in front of the light, it is not. Writes
//                 (shaft, visibility, 0, 1): the accumulated airlight, and whether the
//                 straight path from this pixel to the light is clear, which is the
//                 shadow term the second pass wants and would otherwise march for twice.
//   1  composite  Surface shading — inverse-square falloff in a pseudo-3D scene, a normal
//                 differentiated out of the depth map, half-Lambert — multiplied into the
//                 pixel, plus the shafts added on top. Surface light is a gain because the
//                 image is already albedo x light and we have no way to separate them;
//                 airlight is additive because scattering does not care what is behind it.
//
// Depth is *relative inverse* depth normalised per photo: 1 is the nearest thing in frame,
// 0 the farthest. Nothing here is metric, so `distance`, `radius` and the falloff are all
// in units of the image's own width, and the scene is assumed to be as deep as it is wide.
//
// Coordinates follow mask.wgsl exactly: the view pixel is carried back through the geometry
// stage into image space before the depth map is read, so a light stays where it was put
// when the photo is cropped, straightened or zoomed.

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  return out;
}

// Keep in sync with RelightUniform in src/pipeline/renderer.cpp. vec2f first so the u32
// pair cannot split an alignment, exactly like OpParams and MaskParams.
struct RelightParams {
  origin: vec2f,   // content rect inside the letterboxed view, in pixels
  size: vec2f,
  pass_index: u32, // 0 = shafts, 1 = composite
  opacity: f32,    // layer opacity 0..1
  pad1: u32,
  pad2: u32,
  m0: vec4f,       // rows of the view pixel -> working frame homography, xyz used
  m1: vec4f,
  m2: vec4f,
  geom: vec4f,     // x: lens distortion k, y: working aspect, z: quadrant, w: image aspect
  flip: vec4f,     // xy: -1 mirrors that axis of the working frame
  // xy: the light on screen, in view pixels — the CPU has image_to_view and the shader
  // would have to invert the homography to find it. z: its depth, 0 at the camera and 1 at
  // the back of the scene. w: its reach, in image widths.
  light: vec4f,
  tone: vec4f,     // rgb: the light's colour, linear and unit luminance. a: intensity
  // x: falloff, y: occlusion, z: softness of the shadow's depth test, w: the radius in view
  // pixels the shaft buffer is blurred over, which is the shadow's penumbra
  shape: vec4f,
  rays: vec4f,     // x: intensity, y: length, z: decay, w: sample count
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: RelightParams;
// The photo's depth map, r16uint, stored in image space like a mask raster and at the size
// the model produced it. Sixteen bits because a sky is a very shallow gradient over a very
// large area: at 8 bits the shadow test below reads its quantisation steps as terraces and
// draws a contour line along each one.
@group(0) @binding(2) var depth: texture_2d<u32>;
// Pass 0's output. During pass 0 itself this is a 1x1 placeholder and is never read.
@group(0) @binding(3) var shafts: texture_2d<f32>;
@group(0) @binding(4) var mask: texture_2d<f32>;

// View pixel -> image 0..1. The same chain as mask.wgsl's `to_image`, kept in step with it
// by hand; both read the geometry ops through ops/geometry.cpp.
fn to_image(pos: vec2f) -> vec2f {
  let h = vec3f(pos, 1.0);
  let w = dot(params.m2.xyz, h);
  if (abs(w) < 1e-6) { return vec2f(-1.0, -1.0); }
  var working = vec2f(dot(params.m0.xyz, h), dot(params.m1.xyz, h)) / w;

  let k = params.geom.x;
  if (k != 0.0) {
    let aspect = vec2f(params.geom.y, 1.0);
    let norm = 1.0 / length(aspect);
    let centred = (working - 0.5) * 2.0 * aspect * norm;
    working = (centred * (1.0 + k * dot(centred, centred))) / (2.0 * aspect * norm) + 0.5;
  }

  let quadrant = i32(params.geom.z + 0.5);
  if (quadrant == 1) { working = vec2f(working.y, 1.0 - working.x); }
  else if (quadrant == 2) { working = vec2f(1.0 - working.x, 1.0 - working.y); }
  else if (quadrant == 3) { working = vec2f(1.0 - working.y, working.x); }
  return select(working, 1.0 - working, params.flip.xy < vec2f(0.0));
}

fn depth_texel(coord: vec2i) -> f32 {
  let dims = vec2i(textureDimensions(depth));
  return f32(textureLoad(depth, clamp(coord, vec2i(0, 0), dims - vec2i(1, 1)), 0).r) / 65535.0;
}

// Bilinear: the map is stored at the model's own size and every view magnifies it.
fn nearness_at(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(depth));
  let p = clamp(uv, vec2f(0.0), vec2f(1.0)) * dims - vec2f(0.5);
  let base = floor(p);
  let f = p - base;
  let i = vec2i(base);
  let a = mix(depth_texel(i), depth_texel(i + vec2i(1, 0)), f.x);
  let b = mix(depth_texel(i + vec2i(0, 1)), depth_texel(i + vec2i(1, 1)), f.x);
  return mix(a, b, f.y);
}

// Distance from the camera, 0..1: the depth map answers nearness, everything below wants
// the other direction.
fn distance_at(uv: vec2f) -> f32 {
  return 1.0 - nearness_at(uv);
}

// Where a point of the image sits in the pseudo-3D scene the shading happens in: x scaled
// by the aspect so a light is round on the photo, z the depth, one image width deep.
fn scene_point(uv: vec2f, z: f32) -> vec3f {
  return vec3f(uv.x * params.geom.w, uv.y, z);
}

// How much of the light arrives `q` reaches away, and the one place the falloff is decided —
// the shafts march and the surface shading have to agree or the air glows where the wall
// behind it does not. Inverse-square, tightened by the Falloff slider, then taken to zero a
// little past the ring the UI draws: 1/(1 + q^2) is still a few percent two frames out, and
// a few percent over every pixel of a photograph is haze rather than a light in the scene.
fn reach_falloff(q: f32) -> f32 {
  let inverse_square = 1.0 / (1.0 + q * q * (1.0 + 3.0 * params.shape.x));
  return inverse_square * (1.0 - smoothstep(1.0, 1.8, q));
}

fn light_point() -> vec3f {
  // The light's screen position carries the geometry stage already; its image coordinates
  // come back out of the same depth sample the rest of the pass uses.
  return scene_point(to_image(params.light.xy), params.light.z);
}

fn mask_at(position: vec2f) -> f32 {
  let dims = vec2i(textureDimensions(mask));
  let at = clamp(vec2i(position), vec2i(0, 0), dims - vec2i(1, 1));
  return textureLoad(mask, at, 0).r * params.opacity;
}

// One hash per pixel, used to jitter where a march starts. Without it a 32-step march lays
// down 32 visible arcs around the light.
fn jitter(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

// Is the surface at `uv` behind `z`? Smoothed over a band rather than stepped, so a shaft
// edge and a shadow edge are as soft as the depth map is accurate. A sample that has left
// the photo blocks nothing: the depth map clamps to its border, and without this a branch
// touching the top edge would cast its shadow across everything above it.
fn behind(uv: vec2f, z: f32) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  let softness = max(params.shape.z, 1e-3);
  return smoothstep(z - softness, z + softness, distance_at(uv));
}

struct Marched {
  shaft: f32,
  visibility: f32,
  // Whether this pixel's surface is behind the light at all. Kept apart from `visibility`
  // because the Shadows slider is allowed to soften a branch's shadow and is not allowed to
  // light the back of something standing in front of the lamp.
  front: f32,
};

// The march both terms come out of: from this pixel toward the light, in view pixels.
fn march(pos: vec2f) -> Marched {
  var out: Marched;
  out.shaft = 0.0;
  out.visibility = 1.0;
  out.front = 1.0;

  let steps = i32(clamp(params.rays.w, 4.0, 64.0));
  let to_light = params.light.xy - pos;
  let span = max(length(to_light), 1e-3);
  // How far along the line the shafts are gathered. The shadow test always walks the whole
  // way: a blocker halfway to the light still blocks it.
  let reach = clamp(params.rays.y, 0.05, 1.0);
  let start = jitter(pos) / f32(steps);
  let here = distance_at(to_image(pos));
  // Nothing in front of the light can be lit by it, so a pixel behind the light's own
  // depth is in shadow before the march starts.
  let front = smoothstep(params.light.z - 0.02, params.light.z + 0.02, here);

  // View pixels -> scene units, the ones the light's reach is measured in: the content rect
  // is one unit tall.
  let to_units = 1.0 / max(params.size.y, 1.0);

  var lit = 0.0;
  var lit_weight = 1e-4;
  var blocked = 0.0;
  for (var i = 0; i < steps; i = i + 1) {
    let t = (f32(i) + 0.5) / f32(steps) + start;
    if (t >= 1.0) { continue; }
    let sample_pos = pos + to_light * t;
    let sample_uv = to_image(sample_pos);

    // Airlight: how much of the air on this line of sight the light actually reaches, which
    // is the fraction of the path whose surface sits *behind* the light — everything in
    // front of it casts the shaft. A weighted mean rather than a sum, weighted by how far
    // the scattered light then has to travel back to the camera, so what comes out is a
    // 0..1 shape. How bright that shape is belongs to the light's falloff and is applied
    // once, in the shading pass: integrating brightness along the ray as well gives every
    // pixel in the frame a little of it, which is a fog filter over the photo rather than a
    // beam through it.
    if (t <= reach) {
      let travelled = length(sample_pos - pos) * to_units;
      let weight = exp(-clamp(params.rays.z, 0.0, 1.0) * 4.0 * travelled);
      lit = lit + behind(sample_uv, params.light.z) * weight;
      lit_weight = lit_weight + weight;
    }

    // Shadow: the ray from this pixel to the light runs from `here` to the light's depth;
    // anything the depth map puts in front of that line is between the two. The bias is
    // what keeps a flat surface from shadowing itself at the start of the march, where the
    // ray has barely left it and the depth test would otherwise be a coin toss.
    let ray_z = mix(here, params.light.z, t) - max(params.shape.z, 1e-3);
    blocked = max(blocked, 1.0 - behind(sample_uv, ray_z));
  }

  out.shaft = lit / lit_weight;
  out.visibility = 1.0 - blocked;
  out.front = front;
  return out;
}

// Pass 0's output, averaged over a 3x3 at `spread` pixels' spacing. Read twice with two
// spreads, because its two halves want opposite things: the shafts are the picture and are
// only dithered by the march's jitter, so they take the smallest blur that hides it, while
// the shadow term is a yes/no depth test whose edge is exactly as hard as the depth map —
// a branch would cut the light with a razor — so it takes the penumbra the Shadow softness
// slider asks for.
fn blurred_shafts(pos: vec2f, spread: i32) -> vec4f {
  let dims = vec2i(textureDimensions(shafts));
  var sum = vec4f(0.0);
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let at = clamp(vec2i(pos) + vec2i(x, y) * spread, vec2i(0, 0), dims - vec2i(1, 1));
      sum = sum + textureLoad(shafts, at, 0);
    }
  }
  return sum / 9.0;
}

// The surface normal, differentiated out of the depth map. Two taps per axis at a few
// pixels' spacing rather than one: the map is a model's guess at the photo's resolution, and
// a one-pixel difference is mostly its own noise.
fn surface_normal(pos: vec2f, uv: vec2f) -> vec3f {
  let step_px = 2.0;
  let dx = distance_at(to_image(pos + vec2f(step_px, 0.0))) -
           distance_at(to_image(pos - vec2f(step_px, 0.0)));
  let dy = distance_at(to_image(pos + vec2f(0.0, step_px))) -
           distance_at(to_image(pos - vec2f(0.0, step_px)));
  // Per view pixel -> per scene unit: the content rect spans `geom.w` units across.
  let scale = params.size.x / max(params.geom.w, 1e-3) / (2.0 * step_px);
  // The surface is z = f(x, y) with z growing away from the camera, so the normal facing
  // the camera is (df/dx, df/dy, -1).
  return normalize(vec3f(dx * scale, dy * scale, -1.0));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let pos = in.pos.xy;
  if (params.pass_index == 0u) {
    let marched = march(pos);
    return vec4f(marched.shaft, marched.visibility, marched.front, 1.0);
  }

  let texel = textureLoad(src, vec2i(pos), 0);
  let uv = to_image(pos);
  // Off the photo: the letterbox is not part of the scene and a light must not glow on it.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return texel; }

  let here = distance_at(uv);
  let point = scene_point(uv, here);
  let light = light_point();
  let to_light = light - point;
  let reach = max(params.light.w, 1e-3);
  let q = length(to_light) / reach;
  let attenuation = reach_falloff(q);

  // Half-Lambert: a hard terminator would draw every kink the depth map has, and the map
  // is a guess about a photograph rather than a model of one.
  let normal = surface_normal(pos, uv);
  let lambert = pow(clamp(dot(normal, normalize(to_light)) * 0.5 + 0.5, 0.0, 1.0), 2.0);

  let shadowed = blurred_shafts(pos, i32(max(params.shape.w, 1.0)));
  // The shaft's own brightness: the light's falloff measured on screen rather than through
  // the scene, because the air in front of a near subject is still air beside the lamp.
  let on_screen = length(params.light.xy - pos) / max(params.size.y, 1.0) / reach;
  // The Shadows slider scales how much other geometry blocks the light; it never lets a
  // surface standing in front of the light be lit from behind, which is `.z`.
  let visibility = mix(1.0, shadowed.y, clamp(params.shape.y, 0.0, 1.0)) * shadowed.z;
  let intensity = params.tone.a;
  let surface = intensity * attenuation * lambert * visibility;
  // Airlight rides on the same colour but on nothing else the surface has: not its normal,
  // not its albedo, and not its shadow — the air in a shadow is what a shaft is made of.
  let airlight = params.rays.x * blurred_shafts(pos, 2).x * reach_falloff(on_screen);

  let lit = texel.rgb * (1.0 + surface * params.tone.rgb) + airlight * params.tone.rgb;
  return vec4f(mix(texel.rgb, lit, mask_at(pos)), 1.0);
}

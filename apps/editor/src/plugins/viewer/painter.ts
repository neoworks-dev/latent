// Draws `LFRM` frames on a canvas through WebGL2: one persistent texture per layer, one
// fullscreen triangle, `texSubImage2D` straight out of the socket's buffer. No ImageData, no
// Blob, no copy of the pixels anywhere on the way.
//
// Two layers (contracts FrameLayer). The detail layer is the frame of the current zoom and
// pan; the base layer is a fitted frame of the whole photo underneath it. A pan or a zoom out
// moves the detail frame off part of the canvas, and what it uncovers is the base layer —
// softer, but the right picture — rather than the letterbox, until the engine's next frame
// covers it again.
//
// The frame is rgba8 *sRGB* (protocol/frames.md, format 0), so the texture is plain RGBA8
// and the shader passes the bytes through untouched — an SRGB8_ALPHA8 texture would
// linearise on sample and wash the image out against an untagged drawing buffer.
import {
  type EngineFrame,
  type FrameDrawMarks,
  type FrameLayer,
  type FrameSink,
  type FrameSize,
  type FrameTransform,
  IDENTITY_FRAME_TRANSFORM,
  type ImageTransform,
  multiplyImageTransforms,
} from "@latent/contracts";

// gl_VertexID spans the clip cube with three vertices, so there is no buffer to bind.
// Frame rows run top-down and GL texture space runs bottom-up, hence the flipped v.
const VERTEX_SHADER = `#version 300 es
out vec2 texCoord;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  texCoord = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// `view` is the inverse of the client-side zoom and pan of the detail layer: (1/scale,
// x/width, y/height), so a destination texel asks which source texel it came from. `baseMap`
// does the same for the base layer as a full 3×3, canvas uv → base uv, because the base frame
// is fitted where the detail frame is zoomed. highp because a 32x zoom divides a texture
// coordinate by 32 and mediump runs out of mantissa well before that.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D detail;
uniform sampler2D base;
uniform vec3 view;
uniform mat3 baseMap;
uniform bvec2 layers;
in vec2 texCoord;
out vec4 color;
bool inside(vec2 point) {
  return all(greaterThanEqual(point, vec2(0.0))) && all(lessThanEqual(point, vec2(1.0)));
}
void main() {
  vec2 source = (texCoord - view.yz) * view.x;
  if (layers.x && inside(source)) {
    color = texture(detail, source);
    return;
  }
  vec3 mapped = baseMap * vec3(texCoord, 1.0);
  vec2 baseSource = mapped.xy / mapped.z;
  if (layers.y && mapped.z > 0.0 && inside(baseSource)) {
    color = texture(base, baseSource);
    return;
  }
  // The engine's own letterbox colour (shaders/display.wgsl): what neither layer covers
  // reads as the bars beside the photo instead of a smeared edge texel.
  color = vec4(0.08, 0.08, 0.09, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("webgl2: could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`webgl2: shader failed to compile: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("webgl2: could not create a program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The shaders belong to the program now; deleting the handles frees the sources.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`webgl2: program failed to link: ${log}`);
  }
  return program;
}

/**
 * One layer's texture: the size it was allocated at, and the size of the view its frame was
 * rendered for — larger than the texture for a draft, which is stretched over it.
 */
interface LayerTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  view: FrameSize;
}

export class FramePainter implements FrameSink {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private detail: LayerTexture | null = null;
  private base: LayerTexture | null = null;
  private viewLocation: WebGLUniformLocation | null = null;
  private baseMapLocation: WebGLUniformLocation | null = null;
  private layersLocation: WebGLUniformLocation | null = null;
  /** The client-side zoom or pan the detail layer is being shown under. */
  private transform: FrameTransform = IDENTITY_FRAME_TRANSFORM;
  /** Canvas pixel → base frame pixel (contracts baseLayerMap), or no base layer at all. */
  private baseMap: ImageTransform | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gl = this.createContext();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  /**
   * Uploads and draws one frame synchronously — no rAF, no reactive hop. Called straight
   * from the socket's message handler, so the pixels are on the GPU in the same task.
   */
  draw(frame: EngineFrame, layer: FrameLayer, view: FrameSize): FrameDrawMarks {
    const drawStarted = performance.now();
    const gl = this.gl;
    if (!gl || !this.program || gl.isContextLost()) {
      return { drawStarted, uploaded: drawStarted, drawn: drawStarted };
    }
    const { width, height } = frame.header;
    // The canvas is the detail layer's view; the base layer is mapped onto it whatever its
    // own size, so a base frame only sizes the canvas while there is no detail layer.
    if (layer === "detail" || !this.detail) this.resizeCanvas(gl, view.width, view.height);
    const target = this.ensureLayer(gl, layer, width, height);
    target.view = view;
    gl.activeTexture(layer === "detail" ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame.pixels,
    );
    const uploaded = performance.now();
    this.present(gl);
    return { drawStarted, uploaded, drawn: performance.now() };
  }

  /**
   * Shows what is already on the GPU somewhere else: the zoom or pan the user has asked for
   * since it was rendered. A few uniforms and one draw — no upload, so this costs nothing
   * next to the megabytes a fresh frame would — and the engine's own frame replaces it when
   * it lands, which is what makes the picture sharp again.
   */
  setTransform(transform: FrameTransform, baseMap: ImageTransform | null): void {
    this.transform = transform;
    this.baseMap = baseMap;
    const gl = this.gl;
    if (!gl || (!this.detail && !this.base) || gl.isContextLost()) return;
    this.present(gl);
  }

  dropDetail(): void {
    const gl = this.gl;
    if (gl && this.detail) gl.deleteTexture(this.detail.texture);
    this.detail = null;
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.release();
  }

  private createContext(): WebGL2RenderingContext | null {
    // No alpha, no depth/stencil, no history: the frame is the whole picture every time.
    // `desynchronized` is deliberately off — measured on this machine it widened p95
    // (present 8.4 → 11.5 ms) instead of shortening it.
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) return null;
    this.program = link(gl);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "detail"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "base"), 1);
    this.viewLocation = gl.getUniformLocation(this.program, "view");
    this.baseMapLocation = gl.getUniformLocation(this.program, "baseMap");
    this.layersLocation = gl.getUniformLocation(this.program, "layers");
    return gl;
  }

  /** Uploads the uniforms for both layers and draws the triangle. */
  private present(gl: WebGL2RenderingContext): void {
    const { scale, x, y } = this.transform;
    const canvasWidth = Math.max(1, this.canvas.width);
    const canvasHeight = Math.max(1, this.canvas.height);
    gl.uniform3f(this.viewLocation, scale > 0 ? 1 / scale : 1, x / canvasWidth, y / canvasHeight);
    const base = this.base;
    const baseMap = this.baseMap;
    const showBase = base !== null && baseMap !== null;
    gl.uniform2i(this.layersLocation, this.detail ? 1 : 0, showBase ? 1 : 0);
    if (showBase) {
      // The map is in view pixels; the shader works in uv on both ends, so the canvas size
      // goes in on the right and the base frame's view size comes off on the left.
      const { width: baseWidth, height: baseHeight } = base.view;
      const uv = multiplyImageTransforms(
        multiplyImageTransforms([1 / baseWidth, 0, 0, 0, 1 / baseHeight, 0, 0, 0, 1], baseMap),
        [canvasWidth, 0, 0, 0, canvasHeight, 0, 0, 0, 1],
      );
      // GLSL wants a mat3 column by column; the matrix is row-major.
      gl.uniformMatrix3fv(this.baseMapLocation, false, [
        uv[0],
        uv[3],
        uv[6],
        uv[1],
        uv[4],
        uv[7],
        uv[2],
        uv[5],
        uv[8],
      ]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The canvas and the GL viewport follow the frame size, never the frame rate. */
  private resizeCanvas(gl: WebGL2RenderingContext, width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
  }

  /** The layer's texture at this size, made again only when the size changes. */
  private ensureLayer(
    gl: WebGL2RenderingContext,
    layer: FrameLayer,
    width: number,
    height: number,
  ): LayerTexture {
    const current = layer === "detail" ? this.detail : this.base;
    if (current && current.width === width && current.height === height) return current;
    // A draft and a full frame of the same view alternate on every drag, so the texture is
    // reallocated at each switch; immutable storage cannot be resized in place.
    if (current) gl.deleteTexture(current.texture);
    const texture = gl.createTexture();
    if (!texture) throw new Error("webgl2: could not create a texture");
    gl.activeTexture(layer === "detail" ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Immutable storage: the driver can pick its layout once and every upload after this
    // is a straight blit.
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const made = { texture, width, height, view: { width, height } };
    if (layer === "detail") {
      this.detail = made;
    } else {
      this.base = made;
    }
    return made;
  }

  private release(): void {
    const gl = this.gl;
    this.gl = null;
    if (!gl) return;
    if (this.detail) gl.deleteTexture(this.detail.texture);
    if (this.base) gl.deleteTexture(this.base.texture);
    if (this.program) gl.deleteProgram(this.program);
    this.forget();
  }

  /** Drops every handle without touching GL, for a context that is already gone. */
  private forget(): void {
    this.program = null;
    this.detail = null;
    this.base = null;
    this.viewLocation = null;
    this.baseMapLocation = null;
    this.layersLocation = null;
  }

  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault the context never comes back and the viewer stays black.
    event.preventDefault();
    this.gl = null;
    this.forget();
  };

  private readonly onContextRestored = (): void => {
    this.gl = this.createContext();
  };
}

// Draws `LFRM` frames on a canvas through WebGL2: one persistent texture, one fullscreen
// triangle, `texSubImage2D` straight out of the socket's buffer. No ImageData, no Blob, no
// copy of the pixels anywhere on the way.
//
// The frame is rgba8 *sRGB* (protocol/frames.md, format 0), so the texture is plain RGBA8
// and the shader passes the bytes through untouched — an SRGB8_ALPHA8 texture would
// linearise on sample and wash the image out against an untagged drawing buffer.
import {
  type EngineFrame,
  type FrameDrawMarks,
  type FrameSink,
  type FrameTransform,
  IDENTITY_FRAME_TRANSFORM,
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

// `view` is the inverse of the client-side zoom and pan: (1/scale, x/width, y/height), so a
// destination texel asks which source texel it came from. highp because a 32x zoom divides
// a texture coordinate by 32 and mediump runs out of mantissa well before that.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform vec3 view;
in vec2 texCoord;
out vec4 color;
void main() {
  vec2 source = (texCoord - view.yz) * view.x;
  if (any(lessThan(source, vec2(0.0))) || any(greaterThan(source, vec2(1.0)))) {
    // The engine's own letterbox colour (shaders/display.wgsl): what a gesture uncovers
    // reads as the bars beside the photo instead of a smeared edge texel.
    color = vec4(0.08, 0.08, 0.09, 1.0);
    return;
  }
  color = texture(frame, source);
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

export class FramePainter implements FrameSink {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;
  private viewLocation: WebGLUniformLocation | null = null;
  /** The client-side zoom or pan the frame on the GPU is being shown under. */
  private transform: FrameTransform = IDENTITY_FRAME_TRANSFORM;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gl = this.createContext();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  /**
   * Uploads and draws one frame synchronously — no rAF, no reactive hop. Called straight
   * from the socket's message handler, so the pixels are on the GPU in the same task.
   */
  draw(frame: EngineFrame): FrameDrawMarks {
    const drawStarted = performance.now();
    const gl = this.gl;
    const program = this.program;
    if (!gl || !program || gl.isContextLost()) {
      return { drawStarted, uploaded: drawStarted, drawn: drawStarted };
    }
    const { width, height } = frame.header;
    this.resize(gl, width, height);
    this.uploadTransform(gl);
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { drawStarted, uploaded, drawn: performance.now() };
  }

  /**
   * Shows the frame already on the GPU somewhere else: the zoom or pan the user has asked
   * for since it was rendered. One uniform and one draw — no upload, so this costs nothing
   * next to the 4 MB a fresh frame would — and the engine's own frame replaces it when it
   * lands, which is what makes the picture sharp again.
   */
  setTransform(transform: FrameTransform): void {
    this.transform = transform;
    const gl = this.gl;
    if (!gl || !this.texture || gl.isContextLost()) return;
    this.uploadTransform(gl);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    gl.uniform1i(gl.getUniformLocation(this.program, "frame"), 0);
    this.viewLocation = gl.getUniformLocation(this.program, "view");
    gl.activeTexture(gl.TEXTURE0);
    return gl;
  }

  private uploadTransform(gl: WebGL2RenderingContext): void {
    const { scale, x, y } = this.transform;
    gl.uniform3f(
      this.viewLocation,
      scale > 0 ? 1 / scale : 1,
      x / Math.max(1, this.textureWidth),
      y / Math.max(1, this.textureHeight),
    );
  }

  /** Canvas, texture storage and viewport follow the frame size, never the frame rate. */
  private resize(gl: WebGL2RenderingContext, width: number, height: number): void {
    if (this.textureWidth === width && this.textureHeight === height && this.texture) return;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Immutable storage: the driver can pick its layout once and every upload after this
    // is a straight blit.
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.viewport(0, 0, width, height);
    this.textureWidth = width;
    this.textureHeight = height;
  }

  private release(): void {
    const gl = this.gl;
    this.gl = null;
    if (!gl) return;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.program) gl.deleteProgram(this.program);
    this.texture = null;
    this.program = null;
    this.viewLocation = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
  }

  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault the context never comes back and the viewer stays black.
    event.preventDefault();
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.viewLocation = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
  };

  private readonly onContextRestored = (): void => {
    this.gl = this.createContext();
  };
}

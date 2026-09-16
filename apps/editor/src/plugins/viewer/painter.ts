// Draws `LFRM` frames on a canvas through WebGL2: one persistent texture, one fullscreen
// triangle, `texSubImage2D` straight out of the socket's buffer. No ImageData, no Blob, no
// copy of the pixels anywhere on the way.
//
// The frame is rgba8 *sRGB* (protocol/frames.md, format 0), so the texture is plain RGBA8
// and the shader passes the bytes through untouched — an SRGB8_ALPHA8 texture would
// linearise on sample and wash the image out against an untagged drawing buffer.
import type { EngineFrame, FrameDrawMarks } from "@latent/contracts";

// gl_VertexID spans the clip cube with three vertices, so there is no buffer to bind.
// Frame rows run top-down and GL texture space runs bottom-up, hence the flipped v.
const VERTEX_SHADER = `#version 300 es
out vec2 texCoord;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  texCoord = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D frame;
in vec2 texCoord;
out vec4 color;
void main() { color = texture(frame, texCoord); }`;

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

export class FramePainter {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;

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
    gl.activeTexture(gl.TEXTURE0);
    return gl;
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
    this.textureWidth = 0;
    this.textureHeight = 0;
  }

  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault the context never comes back and the viewer stays black.
    event.preventDefault();
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
  };

  private readonly onContextRestored = (): void => {
    this.gl = this.createContext();
  };
}

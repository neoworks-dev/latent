// Mask rasterisation for the mock engine: parametric components in, one r8 coverage
// buffer out. Crude on purpose — this proves the round trip (components → LMSK frame →
// red tint in the UI), not the engine's compute passes.
//
// Everything here is pure. The engine's real rasters live on the GPU and are cached on
// disk; a mock that keeps the maths in one testable file is the closest honest stand-in.
import type { Mask, MaskComponent, MaskComponentKind, Op } from "@latent/protocol";
import type { ContentRect, Geometry } from "./mock-crop";
import { FRAME_FORMAT_R8, FRAME_HEADER_BYTES } from "@latent/protocol";

/** The base image under the mask, for the kinds that sample it (luminance, color). */
export type ImageSampler = (u: number, v: number) => [number, number, number];

/** Kinds that only a model can rasterise; they go through mask.detect as a job. */
export const aiKinds: readonly MaskComponentKind[] = [
  "subject",
  "sky",
  "background",
  "objects",
  "people",
  "text",
];

export function isAiKind(kind: MaskComponentKind): boolean {
  return aiKinds.includes(kind);
}

/**
 * One `mask.stroke` call, appended to a brush component's `params.strokeData`. The stroke
 * list lives inside the op — that is what makes a history snapshot capture it, so one undo
 * takes one whole stroke — and `params.strokes` is the path the engine mirrors it to.
 */
export interface BrushSegment {
  /** `[x, y]` normalised, with an optional pressure 0..1 as a third element. */
  points: number[][];
  size: number;
  flow: number;
  erase: boolean;
}

/** A detected region, the placeholder an AI kind gets instead of a model's raster. */
export interface PlaceholderRegion {
  shape: "ellipse" | "rect";
  /** [x0, y0, x1, y1], normalised over the uncropped image. */
  box: [number, number, number, number];
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function pointOf(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  return [numberOf(value[0], fallback[0]), numberOf(value[1], fallback[1])];
}

function params(component: MaskComponent): Record<string, unknown> {
  return component.params ?? {};
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Hermite ramp from 0 at `edge0` to 1 at `edge1`; flat outside, like WGSL's smoothstep. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge1 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Feather as a fraction of the shape, never exactly zero so an edge always has one step. */
function featherOf(component: MaskComponent, fallback: number): number {
  const feather = numberOf(component.feather, fallback);
  return Math.max(0.001, feather / 100);
}

export function segmentsOf(component: MaskComponent): BrushSegment[] {
  const raw = params(component).strokeData;
  if (!Array.isArray(raw)) return [];
  return raw as BrushSegment[];
}

/** Keys only the engine writes; a client hands them back exactly as it got them. */
export const engineOwnedParams = ["strokeData", "strokes", "raster", "error"] as const;

export function regionOf(component: MaskComponent): PlaceholderRegion | null {
  const raw = params(component).raster;
  if (!raw || typeof raw !== "object") return null;
  const region = raw as Partial<PlaceholderRegion>;
  if (!Array.isArray(region.box) || region.box.length !== 4) return null;
  return { shape: region.shape === "rect" ? "rect" : "ellipse", box: region.box };
}

/**
 * The region an AI kind "detects". A model would look at the pixels; the mock answers from
 * the kind and the hint, so a UI can be driven through pending → ready without one.
 */
export function placeholderRegion(
  kind: MaskComponentKind,
  hint: Record<string, unknown>,
): PlaceholderRegion {
  const box = hint.box;
  if (Array.isArray(box) && box.length === 4) {
    const corners = box.map((value) => numberOf(value, 0));
    return {
      shape: "rect",
      box: [corners[0] ?? 0, corners[1] ?? 0, corners[2] ?? 1, corners[3] ?? 1],
    };
  }
  if (kind === "sky") return { shape: "rect", box: [0, 0, 1, 0.38] };
  if (kind === "background") return { shape: "rect", box: [0, 0.38, 1, 1] };
  if (kind === "people") return { shape: "ellipse", box: [0.3, 0.2, 0.7, 0.95] };
  if (kind === "text") return { shape: "ellipse", box: [0.25, 0.3, 0.6, 0.8] };
  return { shape: "ellipse", box: [0.28, 0.25, 0.72, 0.85] };
}

function rasteriseRegion(
  region: PlaceholderRegion,
  feather: number,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  const [x0, y0, x1, y1] = region.box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.max(1e-6, (x1 - x0) / 2);
  const ry = Math.max(1e-6, (y1 - y0) / 2);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const dx = (u - cx) / rx;
      const dy = (v - cy) / ry;
      // Both shapes reduce to a distance that is 1 on the boundary, so one falloff serves.
      const distance =
        region.shape === "rect" ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      out[y * width + x] = 1 - smoothstep(1 - feather, 1, distance);
    }
  }
  return out;
}

function rasteriseLinear(component: MaskComponent, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const start = pointOf(params(component).start, [0.5, 0.1]);
  const end = pointOf(params(component).end, [0.5, 0.9]);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return out;
  const feather = featherOf(component, 50);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const t = ((u - start[0]) * dx + (v - start[1]) * dy) / lengthSquared;
      // Feather widens the ramp around the midpoint; a hard gradient is still a ramp.
      out[y * width + x] = smoothstep(0.5 - feather, 0.5 + feather, t);
    }
  }
  return out;
}

function rasteriseRadial(component: MaskComponent, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const center = pointOf(params(component).center, [0.5, 0.5]);
  const radius = pointOf(params(component).radius, [0.25, 0.25]);
  const angle = numberOf(params(component).angle, 0);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const rx = Math.max(1e-6, radius[0]);
  const ry = Math.max(1e-6, radius[1]);
  const feather = featherOf(component, 50);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const px = u - center[0];
      const py = v - center[1];
      const rotatedX = (px * cos - py * sin) / rx;
      const rotatedY = (px * sin + py * cos) / ry;
      const distance = Math.hypot(rotatedX, rotatedY);
      out[y * width + x] = 1 - smoothstep(1 - feather, 1, distance);
    }
  }
  return out;
}

function luminance(color: [number, number, number]): number {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function rasteriseLuminance(
  component: MaskComponent,
  width: number,
  height: number,
  sampler: ImageSampler,
): Float32Array {
  const out = new Float32Array(width * height);
  const range = params(component).range;
  const bounds = Array.isArray(range) ? range : [0.4, 1];
  const low = numberOf(bounds[0], 0.4);
  const high = numberOf(bounds[1], 1);
  const smoothness = Math.max(0.001, numberOf(params(component).smoothness, 0.1));
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const value = luminance(sampler(u, v));
      const rising = smoothstep(low - smoothness, low + smoothness, value);
      const falling = 1 - smoothstep(high - smoothness, high + smoothness, value);
      out[y * width + x] = rising * falling;
    }
  }
  return out;
}

function rasteriseColor(
  component: MaskComponent,
  width: number,
  height: number,
  sampler: ImageSampler,
): Float32Array {
  const out = new Float32Array(width * height);
  const raw = params(component).samples;
  if (!Array.isArray(raw) || raw.length === 0) return out;
  const colors: [number, number, number][] = raw.map((entry: unknown) => {
    if (!Array.isArray(entry)) return [0, 0, 0];
    return [numberOf(entry[0], 0), numberOf(entry[1], 0), numberOf(entry[2], 0)];
  });
  const range = Math.max(0.01, numberOf(params(component).range, 0.25));
  const smoothness = Math.max(0.001, numberOf(params(component).smoothness, 0.1));
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const pixel = sampler(u, v);
      let nearest = Number.POSITIVE_INFINITY;
      for (const color of colors) {
        const distance = Math.hypot(pixel[0] - color[0], pixel[1] - color[1], pixel[2] - color[2]);
        if (distance < nearest) nearest = distance;
      }
      out[y * width + x] = 1 - smoothstep(range - smoothness, range + smoothness, nearest);
    }
  }
  return out;
}

/**
 * Stamps every segment's polyline as a soft disc. Flow is how much one pass lays down, so
 * painting over the same spot twice is darker, and an erase segment takes coverage away —
 * the same rule the engine's brush follows.
 */
function rasteriseBrush(component: MaskComponent, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const longEdge = Math.max(width, height);
  const defaultSize = numberOf(params(component).size, 0.08);
  const defaultFlow = numberOf(params(component).flow, 100);
  const feather = featherOf(component, 50);
  for (const segment of segmentsOf(component)) {
    const radius = (numberOf(segment.size, defaultSize) * longEdge) / 2;
    const flow = numberOf(segment.flow, defaultFlow) / 100;
    if (radius <= 0 || flow <= 0) continue;
    stampSegment(out, width, height, segment, radius, flow, feather);
  }
  for (let index = 0; index < out.length; index++) out[index] = clamp01(out[index] ?? 0);
  return out;
}

function stampSegment(
  out: Float32Array,
  width: number,
  height: number,
  segment: BrushSegment,
  radius: number,
  flow: number,
  feather: number,
): void {
  if (!Array.isArray(segment.points)) return;
  // One pass per segment, not per point: overlapping dabs inside a segment must not stack
  // into a hard line, so the segment's own maximum is what gets laid down.
  const laid = new Float32Array(out.length);
  for (const point of segment.points) {
    const cx = numberOf(point[0], 0) * width;
    const cy = numberOf(point[1], 0) * height;
    const pressure = numberOf(point[2], 1);
    const inner = radius * (1 - feather);
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const value = (1 - smoothstep(inner, radius, distance)) * pressure;
        const index = y * width + x;
        if (value > (laid[index] ?? 0)) laid[index] = value;
      }
    }
  }
  for (let index = 0; index < out.length; index++) {
    const value = (laid[index] ?? 0) * flow;
    if (value <= 0) continue;
    const current = out[index] ?? 0;
    out[index] = segment.erase ? Math.max(0, current - value) : Math.min(1, current + value);
  }
}

/** One component's own raster, before its mode is applied. Zeros when it has nothing yet. */
export function rasteriseComponent(
  component: MaskComponent,
  width: number,
  height: number,
  sampler: ImageSampler,
): Float32Array {
  const raster = rasteriseKind(component, width, height, sampler);
  const opacity = numberOf(component.opacity, 100) / 100;
  const invert = component.invert === true;
  if (!invert && opacity === 1) return raster;
  for (let index = 0; index < raster.length; index++) {
    const value = raster[index] ?? 0;
    raster[index] = (invert ? 1 - value : value) * opacity;
  }
  return raster;
}

function rasteriseKind(
  component: MaskComponent,
  width: number,
  height: number,
  sampler: ImageSampler,
): Float32Array {
  if (component.kind === "linear") return rasteriseLinear(component, width, height);
  if (component.kind === "radial") return rasteriseRadial(component, width, height);
  if (component.kind === "luminance") return rasteriseLuminance(component, width, height, sampler);
  if (component.kind === "color") return rasteriseColor(component, width, height, sampler);
  if (component.kind === "brush") return rasteriseBrush(component, width, height);
  const region = regionOf(component);
  // An AI component that never ran, or whose job failed, contributes nothing.
  if (!region) return new Float32Array(width * height);
  return rasteriseRegion(region, featherOf(component, 0), width, height);
}

/** A component in `pending` or `failed` state contributes nothing (MaskPreviewResult). */
export function contributes(component: MaskComponent): boolean {
  return component.state !== "pending" && component.state !== "failed";
}

/**
 * The components combined top-down into one r8 buffer. The first contributing component is
 * the base whatever its mode says — there is nothing to subtract from or intersect with
 * before it.
 */
export function combineMask(
  mask: Mask,
  width: number,
  height: number,
  sampler: ImageSampler,
  map?: MockGeometryMap,
): Uint8Array {
  const combined = new Float32Array(width * height);
  let seeded = false;
  for (const component of mask.components) {
    if (!contributes(component)) continue;
    const raster = rasteriseComponent(component, width, height, sampler);
    if (!seeded) {
      combined.set(raster);
      seeded = true;
      continue;
    }
    applyMode(combined, raster, component.mode);
  }
  // Everything above rasterised in *image* space, which is where a mask's coordinates live
  // (protocol Mask.space). The frame the overlay lies over is the cropped, straightened,
  // zoomed picture, so the last step is one nearest-neighbour resample through the same
  // matrix the engine hands the UI as `imageTransform`.
  return toBytes(map ? resampleThroughGeometry(combined, width, height, map) : combined);
}

function resampleThroughGeometry(
  source: Float32Array,
  width: number,
  height: number,
  map: MockGeometryMap,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = apply(map.viewToImage, x + 0.5, y + 0.5);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const sx = Math.min(width - 1, Math.floor(u * width));
      const sy = Math.min(height - 1, Math.floor(v * height));
      out[y * width + x] = source[sy * width + sx] ?? 0;
    }
  }
  return out;
}

function applyMode(combined: Float32Array, raster: Float32Array, mode: string): void {
  for (let index = 0; index < combined.length; index++) {
    const base = combined[index] ?? 0;
    const value = raster[index] ?? 0;
    if (mode === "subtract") combined[index] = Math.max(0, base - value);
    else if (mode === "intersect") combined[index] = Math.min(base, value);
    else combined[index] = Math.max(base, value);
  }
}

export function toBytes(raster: Float32Array): Uint8Array {
  const bytes = new Uint8Array(raster.length);
  for (let index = 0; index < raster.length; index++) {
    bytes[index] = Math.round(clamp01(raster[index] ?? 0) * 255);
  }
  return bytes;
}

/** Fraction of pixels above 50 %, the number `mask.preview` answers with. */
export function coverageOf(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let inside = 0;
  for (const value of bytes) {
    if (value > 127) inside += 1;
  }
  return inside / bytes.length;
}

/** An `LMSK` frame: the 32-byte header of frames.md, then w·h coverage bytes. */
export function maskFrame(
  width: number,
  height: number,
  seq: number,
  viewId: number,
  bytes: Uint8Array,
): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + bytes.length);
  const header = new DataView(buffer);
  header.setUint8(0, 0x4c); // L
  header.setUint8(1, 0x4d); // M
  header.setUint8(2, 0x53); // S
  header.setUint8(3, 0x4b); // K
  header.setUint32(4, width, true);
  header.setUint32(8, height, true);
  header.setUint32(12, seq, true);
  header.setUint32(16, viewId, true);
  header.setUint32(20, FRAME_FORMAT_R8, true);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(bytes);
  return buffer;
}

/**
 * A `stack.set` from the UI carries the ops as the UI last saw them, so it must not be
 * allowed to overwrite what only the engine knows: a component's rasterisation `state`, the
 * job behind it, and the strokes it has been painted with. Those are copied forward from
 * the stack the engine is holding, matched by component id.
 */
export function mergeEngineOwned(previous: Op[], next: Op[]): Op[] {
  const known = new Map<string, MaskComponent>();
  for (const op of withChildren(previous)) {
    for (const component of op.mask?.components ?? []) known.set(component.id, component);
  }
  const carry = (op: Op): Op => {
    if (!op.mask) return op;
    const components = op.mask.components.map((component) =>
      seedState(carryEngineOwned(known.get(component.id), component)),
    );
    return { ...op, mask: { components } };
  };
  return next.map((op) => {
    const carried = carry(op);
    // A layer's children have no mask of their own, but they still have to survive the
    // round trip (protocol Op.ops).
    if (!carried.ops) return carried;
    return { ...carried, ops: carried.ops.map(carry) };
  });
}

/** A stack read flat: every op, a layer's children included. */
function withChildren(stack: Op[]): Op[] {
  return stack.flatMap((op) => [op, ...(op.ops ?? [])]);
}

function carryEngineOwned(
  engineOwned: MaskComponent | undefined,
  component: MaskComponent,
): MaskComponent {
  if (!engineOwned) return component;
  const merged: MaskComponent = { ...component, params: { ...component.params } };
  if (engineOwned.state !== undefined) merged.state = engineOwned.state;
  if (engineOwned.jobId !== undefined) merged.jobId = engineOwned.jobId;
  for (const key of engineOwnedParams) {
    const value = engineOwned.params?.[key];
    if (value !== undefined) merged.params = { ...merged.params, [key]: value };
  }
  return merged;
}

/**
 * An AI component is `pending` from the moment it exists, before any `mask.detect`: it has
 * no raster and nothing but a job can give it one. Everything else rasterises from its own
 * parameters and is ready as soon as it is written.
 */
export function seedState(component: MaskComponent): MaskComponent {
  if (component.state !== undefined) return component;
  return { ...component, state: isAiKind(component.kind) ? "pending" : "ready" };
}

/** Every component of every op given a state, for a stack that arrived from a client. */
export function seedComponentStates(stack: Op[]): Op[] {
  const seed = (op: Op): Op => {
    if (!op.mask) return op;
    return { ...op, mask: { components: op.mask.components.map(seedState) } };
  };
  return stack.map((op) => {
    const seeded = seed(op);
    if (!seeded.ops) return seeded;
    return { ...seeded, ops: seeded.ops.map(seed) };
  });
}

// ---- geometry ------------------------------------------------------------------------
// Where a mask's image-space coordinates land on the frame the mock paints. The crop,
// straighten, rotate and flip half is `tools/mock-crop.ts` — it owns the pixels and the
// fitted content rect; this adds the viewport's zoom and pan on top, and turns the pair
// into the `imageTransform` matrix the engine answers with (protocol ViewRenderResult).

/** Row-major 3×3 applied to (x, y, 1) with a homogeneous divide. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out[row * 3 + column] =
        (a[row * 3] ?? 0) * (b[column] ?? 0) +
        (a[row * 3 + 1] ?? 0) * (b[3 + column] ?? 0) +
        (a[row * 3 + 2] ?? 0) * (b[6 + column] ?? 0);
    }
  }
  return out as Mat3;
}

export function invert(m: Mat3): Mat3 {
  const c0 = m[4] * m[8] - m[5] * m[7];
  const c1 = m[5] * m[6] - m[3] * m[8];
  const c2 = m[3] * m[7] - m[4] * m[6];
  const determinant = m[0] * c0 + m[1] * c1 + m[2] * c2;
  if (Math.abs(determinant) < 1e-12) return IDENTITY;
  const k = 1 / determinant;
  return [
    c0 * k,
    (m[2] * m[7] - m[1] * m[8]) * k,
    (m[1] * m[5] - m[2] * m[4]) * k,
    c1 * k,
    (m[0] * m[8] - m[2] * m[6]) * k,
    (m[2] * m[3] - m[0] * m[5]) * k,
    c2 * k,
    (m[1] * m[6] - m[0] * m[7]) * k,
    (m[0] * m[4] - m[1] * m[3]) * k,
  ];
}

export function apply(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-12) return [0, 0];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** `view.render`'s viewport: 1 is fit, and the centre is an image-normalised point. */
export interface MockViewport {
  scale: number;
  centerX: number;
  centerY: number;
  fit: boolean;
}

export const FIT: MockViewport = { scale: 1, centerX: 0.5, centerY: 0.5, fit: true };

/** `view.render`'s insets: what the client floats over the frame, in frame pixels. */
export interface MockInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_INSETS: MockInsets = { left: 0, top: 0, right: 0, bottom: 0 };

export interface MockGeometryMap {
  /** `[x, y, width, height]` of the image inside the frame, zoom included. */
  content: ContentRect;
  /** frame pixel → image 0..1. */
  viewToImage: Mat3;
  /** image 0..1 → frame pixel: `imageTransform` on the wire. */
  imageToView: Mat3;
}

/**
 * Content rect 0..1 → image 0..1, the same composition `mock-crop.ts` walks per pixel and
 * `engine/src/ops/geometry.cpp` builds as a matrix: crop, centre on the crop's middle with
 * the frame's aspect, straighten, put it back, then the quarter turns and the mirrors.
 */
function contentToImage(geometry: Geometry, frameWidth: number, frameHeight: number): Mat3 {
  const turned = geometry.quadrant % 2 !== 0;
  const workAspect = turned ? frameHeight / frameWidth : frameWidth / frameHeight;
  const cropWidth = geometry.right - geometry.left;
  const cropHeight = geometry.bottom - geometry.top;
  const centreX = (geometry.left + geometry.right) / 2;
  const centreY = (geometry.top + geometry.bottom) / 2;
  const radians = (geometry.angle * Math.PI) / 180;

  const crop: Mat3 = [cropWidth, 0, geometry.left, 0, cropHeight, geometry.top, 0, 0, 1];
  const toCentre: Mat3 = [workAspect, 0, -workAspect * centreX, 0, 1, -centreY, 0, 0, 1];
  const unrotate: Mat3 = [
    Math.cos(radians),
    Math.sin(radians),
    0,
    -Math.sin(radians),
    Math.cos(radians),
    0,
    0,
    0,
    1,
  ];
  const fromCentre: Mat3 = [1 / workAspect, 0, centreX, 0, 1, centreY, 0, 0, 1];
  let turn: Mat3 = IDENTITY;
  if (geometry.quadrant === 1) turn = [0, 1, 0, -1, 0, 1, 0, 0, 1];
  if (geometry.quadrant === 2) turn = [-1, 0, 1, 0, -1, 1, 0, 0, 1];
  if (geometry.quadrant === 3) turn = [0, -1, 1, 1, 0, 0, 0, 0, 1];
  const mirror: Mat3 = [
    geometry.flipHorizontal ? -1 : 1,
    0,
    geometry.flipHorizontal ? 1 : 0,
    0,
    geometry.flipVertical ? -1 : 1,
    geometry.flipVertical ? 1 : 0,
    0,
    0,
    1,
  ];
  return multiply(
    multiply(mirror, turn),
    multiply(fromCentre, multiply(unrotate, multiply(toCentre, crop))),
  );
}

function place(
  view: number,
  extent: number,
  centre: number,
  fit: boolean,
  insetStart = 0,
  insetEnd = 0,
): number {
  // Fitted, the rect is centred in the view minus the client's panels; zoomed, it is
  // placed over the whole view and may run behind them.
  if (fit) {
    const inner = Math.max(1, view - insetStart - insetEnd);
    return Math.round(insetStart + (inner - extent) / 2);
  }
  if (extent <= view) return Math.round((view - extent) / 2);
  return Math.round(Math.min(0, Math.max(view - extent, view / 2 - centre * extent)));
}

/**
 * The fitted rect `mock-crop.ts` produced, grown by the viewport's zoom and slid to its
 * centre — clamped, as the engine clamps, so a zoomed frame is never part letterbox.
 */
export function geometryMap(
  geometry: Geometry,
  fitted: ContentRect,
  frameWidth: number,
  frameHeight: number,
  viewport: MockViewport = FIT,
  insets: MockInsets = NO_INSETS,
): MockGeometryMap {
  const toImage = contentToImage(geometry, frameWidth, frameHeight);
  const scale = Math.min(32, Math.max(1, viewport.scale));
  // `fitted` fills the frame; the insets shrink it into the hole between the client's
  // panels, and the zoom multiplies whatever is left. The first zoom notch therefore grows
  // the picture that is on screen instead of jumping to the un-inset fit.
  const innerWidth = Math.max(1, frameWidth - insets.left - insets.right);
  const innerHeight = Math.max(1, frameHeight - insets.top - insets.bottom);
  const inner = Math.min(
    1,
    innerWidth / Math.max(1, fitted[2]),
    innerHeight / Math.max(1, fitted[3]),
  );
  const width = Math.max(1, Math.round(fitted[2] * inner * scale));
  const height = Math.max(1, Math.round(fitted[3] * inner * scale));
  const centre = viewport.fit
    ? [0.5, 0.5]
    : apply(invert(toImage), viewport.centerX, viewport.centerY);
  const x = place(frameWidth, width, centre[0] ?? 0.5, viewport.fit, insets.left, insets.right);
  const y = place(frameHeight, height, centre[1] ?? 0.5, viewport.fit, insets.top, insets.bottom);
  const viewToContent: Mat3 = [1 / width, 0, -x / width, 0, 1 / height, -y / height, 0, 0, 1];
  const viewToImage = multiply(toImage, viewToContent);
  return { content: [x, y, width, height], viewToImage, imageToView: invert(viewToImage) };
}

/**
 * The zoom, applied to the pixels: the fitted picture rescaled from `fitted` into the
 * map's own rect, nearest-neighbour, black outside. A fitted viewport is a no-op.
 */
export function applyViewport(
  frame: ArrayBuffer,
  headerBytes: number,
  width: number,
  height: number,
  fitted: ContentRect,
  map: MockGeometryMap,
): void {
  const [fitX, fitY, fitWidth, fitHeight] = fitted;
  const [zoomX, zoomY, zoomWidth, zoomHeight] = map.content;
  if (fitX === zoomX && fitY === zoomY && fitWidth === zoomWidth && fitHeight === zoomHeight) {
    return;
  }
  const pixels = new Uint8Array(frame, headerBytes);
  const source = pixels.slice();
  pixels.fill(0);
  for (let y = 0; y < height; y++) {
    const v = (y - zoomY) / zoomHeight;
    if (v < 0 || v >= 1) continue;
    const sourceY = Math.floor(fitY + v * fitHeight);
    for (let x = 0; x < width; x++) {
      const u = (x - zoomX) / zoomWidth;
      if (u < 0 || u >= 1) continue;
      const from = (sourceY * width + Math.floor(fitX + u * fitWidth)) * 4;
      const to = (y * width + x) * 4;
      pixels[to] = source[from] ?? 0;
      pixels[to + 1] = source[from + 1] ?? 0;
      pixels[to + 2] = source[from + 2] ?? 0;
      pixels[to + 3] = 255;
    }
  }
}

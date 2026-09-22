// Aircraft trails: the pure half. What the op and its mask look like, what the sliders are,
// and how a batch reads. No runes, no DOM, no engine calls — `PlanesState` is the reactive
// holder over these, which is what the tests exercise.
//
// The op is a generative `remove` carrying one `trails` mask component (protocol
// MaskComponentKind). That is the whole trick behind "apply to the rest of the sequence":
// the component holds a seed stroke and three numbers, never pixels, so copying it to the
// next photo and running `mask.detect` there finds *that* frame's trails rather than pasting
// this frame's mask onto it.
import type { Mask, MaskComponent, Op } from "@latent/protocol";

export const PLANES_MODE = "planes";
/** The op that repaints what the mask covers. */
export const PLANES_OP = "remove";
export const TRAILS_KIND = "trails";

/** A point in image space: 0..1 over the uncropped photo. */
export type SeedPoint = [number, number];
/**
 * The stroke drawn along one trail. A path and not a box: a trail is a line, a box around a
 * diagonal one is mostly sky, and drawing along the thing you mean is the gesture.
 */
export type SeedPath = SeedPoint[];

export interface TrailsParams {
  sensitivity: number;
  minLength: number;
  grow: number;
}

/** The engine's own defaults (protocol MaskComponent.params, kind `trails`). */
export const defaultTrailsParams: TrailsParams = {
  sensitivity: 50,
  minLength: 10,
  grow: 25,
};

/** The three sliders' ranges, in the engine's own bounds (protocol MaskComponent.params). */
export const sensitivityRange = { min: 0, max: 100, step: 1 };
export const minLengthRange = { min: 1, max: 100, step: 1 };
export const growRange = { min: 0, max: 100, step: 1 };

export function trailsComponent(seed: SeedPath, params: TrailsParams): MaskComponent {
  return {
    id: "trails1",
    kind: TRAILS_KIND,
    mode: "add",
    invert: false,
    feather: 0,
    opacity: 100,
    params: { seed, ...params },
  };
}

export function trailsMask(seed: SeedPath, params: TrailsParams): Mask {
  return { components: [trailsComponent(seed, params)] };
}

/**
 * What repaints the trail once it is found. `sky` is the engine's local fill — it
 * interpolates the surrounding sky across the mask and puts the frame's grain back, which
 * is the whole job over night sky and needs nothing running. `comfy` is the SDXL graph, for
 * a trail that crosses something with structure in it.
 */
export type RepaintBackend = "sky" | "comfy";

export const repaintBackends: { value: RepaintBackend; label: string }[] = [
  { value: "sky", label: "Sky fill" },
  { value: "comfy", label: "ComfyUI" },
];

export const defaultRepaintBackend: RepaintBackend = "sky";

export function isRepaintBackend(value: unknown): value is RepaintBackend {
  return value === "sky" || value === "comfy";
}

export function backendOf(op: Op | undefined): RepaintBackend {
  const stored = op?.params?.backend;
  if (isRepaintBackend(stored)) return stored;
  return defaultRepaintBackend;
}

export function trailsComponentOf(op: Op | undefined): MaskComponent | undefined {
  return op?.mask?.components.find((component) => component.kind === TRAILS_KIND);
}

/** The op this column edits: the first `remove` whose mask is a trails component. */
export function planesOp(stack: Op[]): Op | undefined {
  return stack.find((op) => op.op === PLANES_OP && trailsComponentOf(op) !== undefined);
}

export function seedOf(op: Op | undefined): SeedPath | null {
  const seed = trailsComponentOf(op)?.params?.seed;
  if (!Array.isArray(seed) || seed.length < 2) return null;
  const path: SeedPath = [];
  for (const point of seed) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    if (typeof point[0] !== "number" || typeof point[1] !== "number") return null;
    path.push([point[0], point[1]]);
  }
  return path;
}

/** The component's numbers, with the engine's defaults standing in for anything absent. */
export function paramsOf(op: Op | undefined): TrailsParams {
  const params = trailsComponentOf(op)?.params ?? {};
  const read = (name: keyof TrailsParams): number => {
    const value = params[name];
    return typeof value === "number" ? value : defaultTrailsParams[name];
  };
  return { sensitivity: read("sensitivity"), minLength: read("minLength"), grow: read("grow") };
}

/** A pointer fires far faster than a hand moves; two points this close are one point. */
const SEED_THINNING = 0.004;
/** The engine's cap on a seed stroke (protocol MaskComponent.params, kind `trails`). */
const MAX_SEED_POINTS = 256;

function clamped(point: SeedPoint): SeedPoint {
  const inside = (value: number): number => Number(Math.min(1, Math.max(0, value)).toFixed(4));
  return [inside(point[0]), inside(point[1])];
}

export function seedLength(seed: SeedPath): number {
  let total = 0;
  let previous: SeedPoint | undefined;
  for (const point of seed) {
    if (previous) total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return total;
}

/**
 * The raw pointer path as the engine wants it: inside the frame, thinned, and capped. The
 * last point is always kept — it is where the hand stopped, which is the end of the trail.
 */
export function seedFromStroke(points: SeedPath): SeedPath {
  const path: SeedPath = [];
  for (const point of points) {
    const next = clamped(point);
    const last = path[path.length - 1];
    if (last && Math.hypot(next[0] - last[0], next[1] - last[1]) < SEED_THINNING) continue;
    path.push(next);
  }
  const last = points[points.length - 1];
  if (last) {
    const tail = clamped(last);
    const end = path[path.length - 1];
    if (!end || end[0] !== tail[0] || end[1] !== tail[1]) path.push(tail);
  }
  if (path.length <= MAX_SEED_POINTS) return path;
  // Keep every nth point plus the end: a stroke the engine will not take is worse than a
  // slightly coarser one.
  const step = Math.ceil(path.length / MAX_SEED_POINTS);
  const thinned = path.filter((_, index) => index % step === 0);
  const end = path[path.length - 1];
  if (end && thinned[thinned.length - 1] !== end) thinned.push(end);
  return thinned;
}

/** A stroke shorter than this is a tap, and the detector would only say so. */
export const MIN_SEED_LENGTH = 0.02;

export function seedIsUsable(seed: SeedPath): boolean {
  return seed.length >= 2 && seedLength(seed) >= MIN_SEED_LENGTH;
}

/** What the column says about the detection, in the component's own words. */
export function detectLabel(op: Op | undefined, failure: string): string {
  const component = trailsComponentOf(op);
  if (!component) return "Draw along one aircraft trail.";
  if (component.state === "pending") return "Detecting…";
  if (component.state === "failed") return failure || "Detection failed.";
  if (component.state === "stale") return "Settings changed — detect again.";
  if (component.state === "ready") return "Trails detected.";
  return "Not detected yet.";
}

export interface BatchProgress {
  done: number;
  total: number;
  /** The file being worked on right now. */
  current: string;
  failed: number;
}

export function batchLabel(batch: BatchProgress | null): string {
  if (!batch) return "";
  if (batch.done < batch.total) return `${batch.done} of ${batch.total} — ${batch.current}`;
  const done = `${batch.done} of ${batch.total} photos done`;
  if (batch.failed === 0) return done;
  return `${done}, ${batch.failed} failed`;
}

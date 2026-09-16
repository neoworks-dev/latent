// Tone-curve maths, ported from the engine's `engine/src/ops/curve.cpp` so the editor
// draws exactly the table the renderer uploads: Fritsch-Carlson monotone cubic for the
// point curves, Lightroom's four smoothstep regions for the parametric one, both pinned
// monotonic afterwards. Pure — no DOM, no engine calls, no runes — so it is testable on
// its own (tests/curve.test.ts) the way the C++ side is (engine/tests/curve_test.cpp).
//
// Both axes are the display-referred 0..1 domain the editor draws in, not the linear
// working space; engine/shaders/ops.wgsl encodes and decodes around the lookup.

/**
 * One control point as the engine stores it: an object with numeric `x`/`y` in 0..1.
 * Not an `[x, y]` pair — `curve_points_from_json` skips anything that is not an object.
 */
export interface CurvePoint {
  x: number;
  y: number;
}

/** Entries the engine uploads, and so the resolution the editor strokes at. */
export const CURVE_LUT_SIZE = 256;

/** The 0–255 levels the readout prints and the arrow keys step in. */
export const CURVE_LEVELS = CURVE_LUT_SIZE - 1;

/** The point curves `tone_curve` carries, in the engine's order. */
export type CurveChannel = "rgb" | "red" | "green" | "blue";

/** Lightroom's parametric curve: four region amounts and the three splits between them. */
export interface ParametricCurve {
  highlights: number;
  lights: number;
  darks: number;
  shadows: number;
  shadowSplit: number;
  midtoneSplit: number;
  highlightSplit: number;
}

/** The three split params, which are also the handles drawn under the graph. */
export type SplitName = "shadowSplit" | "midtoneSplit" | "highlightSplit";

/** Anything the pointer reports is pulled back into the graph's own 0..1 box. */
export function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clampUnit((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * A curve that ever descends would invert tones; the region sliders can add up to that,
 * so the table is walked once and every entry pinned to at least its predecessor.
 */
function monotonize(lut: number[]): number[] {
  for (let index = 1; index < lut.length; index++) {
    lut[index] = Math.max(lut[index], lut[index - 1]);
  }
  return lut;
}

function readPoint(entry: unknown): CurvePoint | null {
  if (typeof entry !== "object" || entry === null) return null;
  const candidate = entry as { x?: unknown; y?: unknown };
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return null;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return { x: clampUnit(candidate.x), y: clampUnit(candidate.y) };
}

/**
 * Control points out of an op param: clamped to 0..1, sorted by x, points sharing an x
 * dropped, anything that is not a numeric `{ x, y }` ignored — the engine's rules, so the
 * editor never shows a point the renderer threw away.
 */
export function curvePoints(value: unknown): CurvePoint[] {
  if (!Array.isArray(value)) return [];
  const parsed: CurvePoint[] = [];
  for (const entry of value) {
    const point = readPoint(entry);
    if (point) parsed.push(point);
  }
  parsed.sort((a, b) => a.x - b.x);
  const points: CurvePoint[] = [];
  for (const point of parsed) {
    const previous = points[points.length - 1];
    if (previous && previous.x === point.x) continue;
    points.push(point);
  }
  return points;
}

/** The two points a Lightroom curve always has, which the engine spells as no points. */
export function isIdentityPoints(points: CurvePoint[]): boolean {
  if (points.length === 0) return true;
  if (points.length !== 2) return false;
  const [first, last] = points;
  return first.x === 0 && first.y === 0 && last.x === 1 && last.y === 1;
}

/** What goes on the wire: the identity curve is the empty array, never two bare endpoints. */
export function curveJson(points: CurvePoint[]): CurvePoint[] {
  if (isIdentityPoints(points)) return [];
  return points.map((point) => ({ x: point.x, y: point.y }));
}

export function identityLut(): number[] {
  const lut: number[] = [];
  for (let index = 0; index < CURVE_LUT_SIZE; index++) lut.push(index / CURVE_LEVELS);
  return lut;
}

/**
 * Fritsch-Carlson monotone cubic through `points`: no overshoot between control points,
 * which is what keeps a curve from inverting. Fewer than two points = identity.
 */
export function pointCurveLut(points: CurvePoint[]): number[] {
  if (points.length < 2) return identityLut();

  const count = points.length;
  const slope: number[] = [];
  for (let index = 0; index + 1 < count; index++) {
    const dx = points[index + 1].x - points[index].x;
    slope.push(dx > 0 ? (points[index + 1].y - points[index].y) / dx : 0);
  }
  const tangent: number[] = new Array<number>(count).fill(0);
  tangent[0] = slope[0];
  tangent[count - 1] = slope[count - 2];
  for (let index = 1; index + 1 < count; index++) {
    // Fritsch-Carlson: a flat or reversing neighbour pins the tangent to zero, which is
    // what stops the spline from bulging past the control points.
    if (slope[index - 1] * slope[index] <= 0) continue;
    const limit = 3 * Math.min(Math.abs(slope[index - 1]), Math.abs(slope[index]));
    tangent[index] = clamp((slope[index - 1] + slope[index]) / 2, -limit, limit);
  }

  const first = points[0];
  const last = points[count - 1];
  const lut: number[] = [];
  let segment = 0;
  for (let index = 0; index < CURVE_LUT_SIZE; index++) {
    const x = index / CURVE_LEVELS;
    if (x <= first.x) {
      lut.push(first.y);
      continue;
    }
    if (x >= last.x) {
      lut.push(last.y);
      continue;
    }
    while (segment + 2 < count && x > points[segment + 1].x) segment++;
    const dx = points[segment + 1].x - points[segment].x;
    const t = dx > 0 ? (x - points[segment].x) / dx : 0;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y =
      h00 * points[segment].y +
      h10 * dx * tangent[segment] +
      h01 * points[segment + 1].y +
      h11 * dx * tangent[segment + 1];
    lut.push(clampUnit(y));
  }
  return monotonize(lut);
}

/** A region slider at ±100 moves its part of the curve by a quarter of the range. */
const REGION_LIFT = 0.25;

export function parametricCurveLut(regions: ParametricCurve): number[] {
  const shadowSplit = clampUnit(regions.shadowSplit / 100);
  const midtoneSplit = Math.max(clampUnit(regions.midtoneSplit / 100), shadowSplit);
  const highlightSplit = Math.max(clampUnit(regions.highlightSplit / 100), midtoneSplit);

  const lut: number[] = [];
  for (let index = 0; index < CURVE_LUT_SIZE; index++) {
    const x = index / CURVE_LEVELS;
    const shadows = 1 - smoothstep(0, midtoneSplit, x);
    const darks = smoothstep(0, shadowSplit, x) * (1 - smoothstep(shadowSplit, highlightSplit, x));
    const lights =
      smoothstep(shadowSplit, highlightSplit, x) * (1 - smoothstep(highlightSplit, 1, x));
    const highlights = smoothstep(midtoneSplit, 1, x);
    const lift =
      (REGION_LIFT *
        (regions.shadows * shadows +
          regions.darks * darks +
          regions.lights * lights +
          regions.highlights * highlights)) /
      100;
    lut.push(clampUnit(x + lift));
  }
  return monotonize(lut);
}

/** `second` applied to the output of `first`, interpolating between entries. */
export function composeLut(first: number[], second: number[]): number[] {
  const lut: number[] = [];
  for (let index = 0; index < CURVE_LUT_SIZE; index++) {
    const position = clampUnit(first[index]) * CURVE_LEVELS;
    const low = Math.floor(position);
    const high = Math.min(low + 1, CURVE_LEVELS);
    const fraction = position - low;
    lut.push(second[low] * (1 - fraction) + second[high] * fraction);
  }
  return lut;
}

export function isIdentityLut(lut: number[]): boolean {
  const identity = identityLut();
  return lut.every((entry, index) => entry === identity[index]);
}

function numberParam(params: Record<string, unknown>, name: string, fallback: number): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

/** The parametric half of a `tone_curve` op's params, with the engine's defaults. */
export function parametricOf(params: Record<string, unknown>): ParametricCurve {
  return {
    highlights: numberParam(params, "highlights", 0),
    lights: numberParam(params, "lights", 0),
    darks: numberParam(params, "darks", 0),
    shadows: numberParam(params, "shadows", 0),
    shadowSplit: numberParam(params, "shadowSplit", 25),
    midtoneSplit: numberParam(params, "midtoneSplit", 50),
    highlightSplit: numberParam(params, "highlightSplit", 75),
  };
}

/**
 * What every channel passes through before its own curve: the parametric regions, then
 * the RGB point curve. Same order as `curve_table` in engine/src/pipeline/renderer.cpp.
 */
export function sharedLut(params: Record<string, unknown>): number[] {
  return composeLut(
    parametricCurveLut(parametricOf(params)),
    pointCurveLut(curvePoints(params.rgb)),
  );
}

/**
 * The table one channel is actually rendered through — the shared curve plus that
 * channel's own points. This is what the editor ghosts behind the curve being edited.
 */
export function effectiveLut(params: Record<string, unknown>, channel: string): number[] {
  const shared = sharedLut(params);
  if (channel === "rgb") return shared;
  return composeLut(shared, pointCurveLut(curvePoints(params[channel])));
}

/** The minimum gap between two points: one level, below which the engine drops one. */
const MIN_GAP = 1 / CURVE_LEVELS;

/**
 * Lightroom's curve always carries its two endpoints; the engine's empty array means the
 * same thing. Materialising them is what makes the first click produce a visible curve.
 */
export function withAnchors(points: CurvePoint[]): CurvePoint[] {
  if (points.length > 0) return points;
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

export interface CurveEdit {
  points: CurvePoint[];
  /** Where the touched point ended up, so the caller can keep it selected while dragging. */
  index: number;
}

/** Adds a point, keeping the list sorted by x. A click on top of a point moves nothing. */
export function insertPoint(points: CurvePoint[], point: CurvePoint): CurveEdit {
  const anchored = withAnchors(points);
  const added = { x: clampUnit(point.x), y: clampUnit(point.y) };
  const index = anchored.findIndex((entry) => entry.x > added.x);
  const at = index < 0 ? anchored.length : index;
  const next = [...anchored.slice(0, at), added, ...anchored.slice(at)];
  return { points: next, index: at };
}

/**
 * Moves one point. An interior point's x stays strictly between its neighbours — crossing
 * would reorder the list under the pointer — and the two endpoints keep the x they have,
 * so dragging them is the black and white level.
 */
export function movePoint(points: CurvePoint[], index: number, x: number, y: number): CurvePoint[] {
  const point = points[index];
  if (!point) return points;
  const next = [...points];
  next[index] = { x: clampedX(points, index, x), y: clampUnit(y) };
  return next;
}

function clampedX(points: CurvePoint[], index: number, x: number): number {
  const point = points[index];
  if (index === 0 || index === points.length - 1) return point.x;
  return clamp(x, points[index - 1].x + MIN_GAP, points[index + 1].x - MIN_GAP);
}

/** Removes an interior point. The two endpoints are Lightroom's black and white levels. */
export function removePoint(points: CurvePoint[], index: number): CurvePoint[] {
  if (index <= 0 || index >= points.length - 1) return points;
  return points.filter((_, entry) => entry !== index);
}

/** The same points in the same places — a press that released without moving anything. */
export function samePoints(first: CurvePoint[], second: CurvePoint[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((point, index) => point.x === second[index].x && point.y === second[index].y);
}

/** Arrow keys: one level, ten with Shift, in the same clamped space as a drag. */
export function nudgePoint(
  points: CurvePoint[],
  index: number,
  deltaX: number,
  deltaY: number,
): CurvePoint[] {
  const point = points[index];
  if (!point) return points;
  return movePoint(points, index, point.x + deltaX, point.y + deltaY);
}

/**
 * Arrow keys over the graph: one level, ten with Shift, in the same 0..1 space a drag
 * works in. Anything else is not the editor's key.
 */
export function curveArrowDelta(key: string, shiftKey: boolean): CurvePoint | null {
  const step = (shiftKey ? 10 : 1) / CURVE_LEVELS;
  if (key === "ArrowLeft") return { x: -step, y: 0 };
  if (key === "ArrowRight") return { x: step, y: 0 };
  if (key === "ArrowDown") return { x: 0, y: -step };
  if (key === "ArrowUp") return { x: 0, y: step };
  return null;
}

/** The point under the pointer: the nearest one inside `tolerance`, or null for empty space. */
export function pointNear(
  points: CurvePoint[],
  x: number,
  y: number,
  tolerance: number,
): number | null {
  let best = -1;
  let bestDistance = tolerance;
  for (let index = 0; index < points.length; index++) {
    const distance = Math.hypot(points[index].x - x, points[index].y - y);
    if (distance > bestDistance) continue;
    best = index;
    bestDistance = distance;
  }
  return best < 0 ? null : best;
}

/** The 0–255 level a 0..1 coordinate reads as. */
export function curveLevel(value: number): number {
  return Math.round(clampUnit(value) * CURVE_LEVELS);
}

/** Lightroom's corner readout while a point is dragged: input level → output level. */
export function curveReadout(point: CurvePoint): string {
  return `${curveLevel(point.x)} → ${curveLevel(point.y)}`;
}

/** Split points never cross; the engine pins each to the one below it when it renders. */
export function clampSplit(name: SplitName, value: number, regions: ParametricCurve): number {
  if (name === "shadowSplit") return clamp(value, 0, regions.midtoneSplit);
  if (name === "midtoneSplit") return clamp(value, regions.shadowSplit, regions.highlightSplit);
  return clamp(value, regions.midtoneSplit, 100);
}

/**
 * The `d` of the stroked curve, in a `size`×`size` SVG box with y already flipped: one
 * segment per lookup entry, so what is drawn is the table and not a re-interpolation of it.
 */
export function lutPath(lut: number[], size: number): string {
  const steps: string[] = [];
  for (let index = 0; index < lut.length; index++) {
    const x = (index / CURVE_LEVELS) * size;
    const y = (1 - lut[index]) * size;
    steps.push(`${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return steps.join(" ");
}

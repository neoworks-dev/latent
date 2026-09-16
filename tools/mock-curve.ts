// The mock engine's tone curve: the same lookup tables `engine/src/ops/curve.cpp` builds
// and `engine/src/pipeline/renderer.cpp` composes, in TS, so a curve dragged against the
// mock moves pixels the way it moves them against latentd.
//
// This is a second implementation on purpose, the way `mock-masks.ts` re-implements the
// rasteriser: the engine owns its copy in C++, the panel plugin owns one for drawing
// (`plugins/panels/src/curve.ts`), and the three are pinned to each other by the golden
// samples in `tools/tests/mock-curve.test.ts` and `plugins/panels/tests/curve.test.ts`.

/** A control point as the engine stores it: numeric `x`/`y` in 0..1, never an `[x, y]` pair. */
export interface CurvePoint {
  x: number;
  y: number;
}

export const CURVE_LUT_SIZE = 256;
const LEVELS = CURVE_LUT_SIZE - 1;

/** The red, green and blue tables one `tone_curve` op resolves to. */
export interface CurveTable {
  red: number[];
  green: number[];
  blue: number[];
  /** False when all three are the identity, i.e. the pass can be skipped. */
  active: boolean;
}

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clampUnit((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function entry(lut: number[], index: number): number {
  return lut[index] ?? 0;
}

/** A descending curve would invert tones: every entry is pinned to its predecessor. */
function monotonize(lut: number[]): number[] {
  for (let index = 1; index < lut.length; index++) {
    lut[index] = Math.max(entry(lut, index), entry(lut, index - 1));
  }
  return lut;
}

export function identityLut(): number[] {
  const lut: number[] = [];
  for (let index = 0; index < CURVE_LUT_SIZE; index++) lut.push(index / LEVELS);
  return lut;
}

/** Points out of an op param, on the engine's terms: clamped, sorted, deduplicated by x. */
export function curvePoints(value: unknown): CurvePoint[] {
  if (!Array.isArray(value)) return [];
  const parsed: CurvePoint[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const point = candidate as { x?: unknown; y?: unknown };
    if (typeof point.x !== "number" || typeof point.y !== "number") continue;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    parsed.push({ x: clampUnit(point.x), y: clampUnit(point.y) });
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

/** Fritsch-Carlson monotone cubic; fewer than two points is the identity. */
export function pointCurveLut(points: CurvePoint[]): number[] {
  const count = points.length;
  const first = points[0];
  const last = points[count - 1];
  if (count < 2 || !first || !last) return identityLut();

  const slope: number[] = [];
  for (let index = 0; index + 1 < count; index++) {
    const low = points[index];
    const high = points[index + 1];
    if (!low || !high) continue;
    const dx = high.x - low.x;
    slope.push(dx > 0 ? (high.y - low.y) / dx : 0);
  }
  const tangent = new Array<number>(count).fill(0);
  tangent[0] = entry(slope, 0);
  tangent[count - 1] = entry(slope, count - 2);
  for (let index = 1; index + 1 < count; index++) {
    const before = entry(slope, index - 1);
    const after = entry(slope, index);
    if (before * after <= 0) continue;
    const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
    tangent[index] = Math.min(Math.max((before + after) / 2, -limit), limit);
  }

  const lut: number[] = [];
  let segment = 0;
  for (let index = 0; index < CURVE_LUT_SIZE; index++) {
    const x = index / LEVELS;
    if (x <= first.x) {
      lut.push(first.y);
      continue;
    }
    if (x >= last.x) {
      lut.push(last.y);
      continue;
    }
    while (segment + 2 < count && x > (points[segment + 1]?.x ?? 1)) segment++;
    const low = points[segment];
    const high = points[segment + 1];
    if (!low || !high) {
      lut.push(x);
      continue;
    }
    const dx = high.x - low.x;
    const t = dx > 0 ? (x - low.x) / dx : 0;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * low.y +
      (t3 - 2 * t2 + t) * dx * entry(tangent, segment) +
      (-2 * t3 + 3 * t2) * high.y +
      (t3 - t2) * dx * entry(tangent, segment + 1);
    lut.push(clampUnit(y));
  }
  return monotonize(lut);
}

function numberParam(params: Record<string, unknown>, name: string, fallback: number): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

/** A region slider at ±100 moves its part of the curve by a quarter of the range. */
const REGION_LIFT = 0.25;

/** Lightroom's four smoothstep regions, split where the three split params say. */
export function parametricCurveLut(params: Record<string, unknown>): number[] {
  const shadowSplit = clampUnit(numberParam(params, "shadowSplit", 25) / 100);
  const midtoneSplit = Math.max(
    clampUnit(numberParam(params, "midtoneSplit", 50) / 100),
    shadowSplit,
  );
  const highlightSplit = Math.max(
    clampUnit(numberParam(params, "highlightSplit", 75) / 100),
    midtoneSplit,
  );
  const amounts = {
    shadows: numberParam(params, "shadows", 0),
    darks: numberParam(params, "darks", 0),
    lights: numberParam(params, "lights", 0),
    highlights: numberParam(params, "highlights", 0),
  };

  const lut: number[] = [];
  for (let index = 0; index < CURVE_LUT_SIZE; index++) {
    const x = index / LEVELS;
    const shadows = 1 - smoothstep(0, midtoneSplit, x);
    const darks = smoothstep(0, shadowSplit, x) * (1 - smoothstep(shadowSplit, highlightSplit, x));
    const lights =
      smoothstep(shadowSplit, highlightSplit, x) * (1 - smoothstep(highlightSplit, 1, x));
    const highlights = smoothstep(midtoneSplit, 1, x);
    const lift =
      (REGION_LIFT *
        (amounts.shadows * shadows +
          amounts.darks * darks +
          amounts.lights * lights +
          amounts.highlights * highlights)) /
      100;
    lut.push(clampUnit(x + lift));
  }
  return monotonize(lut);
}

/** `second` applied to the output of `first`, interpolating between entries. */
export function composeLut(first: number[], second: number[]): number[] {
  const lut: number[] = [];
  for (let index = 0; index < CURVE_LUT_SIZE; index++) {
    const position = clampUnit(entry(first, index)) * LEVELS;
    const low = Math.floor(position);
    const high = Math.min(low + 1, LEVELS);
    const fraction = position - low;
    lut.push(entry(second, low) * (1 - fraction) + entry(second, high) * fraction);
  }
  return lut;
}

function isIdentityLut(lut: number[]): boolean {
  return lut.every((value, index) => value === index / LEVELS);
}

/**
 * The three channel tables of one `tone_curve` op, composed the way `curve_table` in
 * engine/src/pipeline/renderer.cpp composes them: the parametric regions, then the RGB
 * point curve, then the channel's own.
 */
export function curveTable(params: Record<string, unknown>): CurveTable {
  const shared = composeLut(parametricCurveLut(params), pointCurveLut(curvePoints(params.rgb)));
  const red = composeLut(shared, pointCurveLut(curvePoints(params.red)));
  const green = composeLut(shared, pointCurveLut(curvePoints(params.green)));
  const blue = composeLut(shared, pointCurveLut(curvePoints(params.blue)));
  return {
    red,
    green,
    blue,
    active: !(isIdentityLut(red) && isIdentityLut(green) && isIdentityLut(blue)),
  };
}

/**
 * One channel through its table, with the shader's linear interpolation between the two
 * entries a value falls between (engine/shaders/ops.wgsl, `apply_curve`). The mock renders
 * display-referred values already, so there is no gamma hop around the lookup here.
 */
export function applyLut(lut: number[], value: number): number {
  const position = clampUnit(value) * LEVELS;
  const low = Math.floor(position);
  const high = Math.min(low + 1, LEVELS);
  const fraction = position - low;
  return entry(lut, low) * (1 - fraction) + entry(lut, high) * fraction;
}

import { describe, expect, test } from "bun:test";
import {
  CURVE_LEVELS,
  CURVE_LUT_SIZE,
  clampSplit,
  clampUnit,
  composeLut,
  curveArrowDelta,
  curveJson,
  curveLevel,
  curvePoints,
  curveReadout,
  effectiveLut,
  identityLut,
  insertPoint,
  isIdentityLut,
  isIdentityPoints,
  lutPath,
  movePoint,
  nudgePoint,
  parametricCurveLut,
  parametricOf,
  pointCurveLut,
  pointNear,
  removePoint,
  sharedLut,
  withAnchors,
  type CurvePoint,
  type ParametricCurve,
} from "../src/curve";

/**
 * The engine's neutral parametric curve: every region at zero, splits at Lightroom's
 * defaults (engine/src/ops/registry.cpp).
 */
const neutral: ParametricCurve = parametricOf({});

/** Reads the table the way the shader does: `x` in 0..1 to the entry it lands on. */
function at(lut: number[], x: number): number {
  return lut[Math.round(x * CURVE_LEVELS)];
}

function isMonotonic(lut: number[]): boolean {
  return lut.every((entry, index) => index === 0 || entry >= lut[index - 1]);
}

describe("curvePoints", () => {
  test("takes numeric {x, y} objects, clamped, sorted, deduplicated by x", () => {
    const points = curvePoints([
      { x: 0.8, y: 1.4 },
      { x: 0.2, y: -0.1 },
      { x: 0.2, y: 0.9 },
      [1, 2],
      { x: "0.5", y: 0.5 },
      null,
    ]);
    expect(points).toEqual([
      { x: 0.2, y: 0 },
      { x: 0.8, y: 1 },
    ]);
  });

  test("anything that is not an array is no curve", () => {
    expect(curvePoints(undefined)).toEqual([]);
    expect(curvePoints({ x: 0.5, y: 0.5 })).toEqual([]);
    expect(curvePoints(7)).toEqual([]);
  });

  test("a NaN coordinate is dropped rather than poisoning the table", () => {
    expect(curvePoints([{ x: Number.NaN, y: 0.5 }])).toEqual([]);
  });
});

describe("identity", () => {
  test("the identity table maps every entry to itself", () => {
    const lut = identityLut();
    expect(lut).toHaveLength(CURVE_LUT_SIZE);
    expect(lut[0]).toBe(0);
    expect(lut[CURVE_LEVELS]).toBe(1);
    expect(isIdentityLut(lut)).toBe(true);
  });

  test("fewer than two points is identity, as the engine has it", () => {
    expect(isIdentityLut(pointCurveLut([]))).toBe(true);
    expect(isIdentityLut(pointCurveLut([{ x: 0.5, y: 0.9 }]))).toBe(true);
  });

  test("the two bare endpoints are the identity curve and travel as an empty array", () => {
    const anchors = withAnchors([]);
    expect(isIdentityPoints(anchors)).toBe(true);
    expect(curveJson(anchors)).toEqual([]);
    // The spline through them is the diagonal, to the last bit the cubic can carry.
    const lut = pointCurveLut(anchors);
    lut.forEach((entry, index) => expect(entry).toBeCloseTo(index / CURVE_LEVELS, 9));
  });

  test("a real curve keeps its points on the wire", () => {
    const points: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.4 },
      { x: 1, y: 1 },
    ];
    expect(curveJson(points)).toEqual(points);
    expect(isIdentityPoints(points)).toBe(false);
  });
});

describe("pointCurveLut", () => {
  test("interpolates through its control points", () => {
    const lut = pointCurveLut([
      { x: 0, y: 0 },
      { x: 0.25, y: 0.4 },
      { x: 1, y: 1 },
    ]);
    expect(at(lut, 0)).toBeCloseTo(0, 6);
    expect(at(lut, 0.25)).toBeCloseTo(0.4, 2);
    expect(at(lut, 1)).toBeCloseTo(1, 6);
    // A lifted quarter-tone lifts everything below the next control point with it.
    expect(at(lut, 0.5)).toBeGreaterThan(0.5);
  });

  test("never overshoots between control points, which is the point of Fritsch-Carlson", () => {
    const lut = pointCurveLut([
      { x: 0, y: 0 },
      { x: 0.4, y: 0.42 },
      { x: 0.45, y: 0.42 },
      { x: 1, y: 1 },
    ]);
    for (let index = 103; index <= 115; index++) expect(lut[index]).toBeLessThanOrEqual(0.4201);
    expect(isMonotonic(lut)).toBe(true);
  });

  test("holds the end values flat outside the outermost points", () => {
    const lut = pointCurveLut([
      { x: 0.2, y: 0.3 },
      { x: 0.8, y: 0.7 },
    ]);
    expect(at(lut, 0)).toBeCloseTo(0.3, 6);
    expect(at(lut, 0.1)).toBeCloseTo(0.3, 6);
    expect(at(lut, 0.9)).toBeCloseTo(0.7, 6);
    expect(at(lut, 1)).toBeCloseTo(0.7, 6);
  });

  test("a descending curve is pinned flat rather than inverting tones", () => {
    const lut = pointCurveLut([
      { x: 0, y: 0.6 },
      { x: 1, y: 0.2 },
    ]);
    expect(isMonotonic(lut)).toBe(true);
  });
});

describe("parametricCurveLut", () => {
  test("neutral regions are the identity", () => {
    expect(isIdentityLut(parametricCurveLut(neutral))).toBe(true);
  });

  test("lifting shadows raises the low end and leaves white alone", () => {
    const lut = parametricCurveLut({ ...neutral, shadows: 100 });
    expect(at(lut, 0.1)).toBeGreaterThan(0.1);
    expect(at(lut, 1)).toBeCloseTo(1, 6);
    expect(isMonotonic(lut)).toBe(true);
  });

  test("dropping highlights darkens the top and leaves black alone", () => {
    const lut = parametricCurveLut({ ...neutral, highlights: -100 });
    expect(at(lut, 0.9)).toBeLessThan(0.9);
    expect(at(lut, 0)).toBeCloseTo(0, 6);
  });

  test("a split above the one over it is pinned, never crossed", () => {
    const crossed = parametricCurveLut({
      ...neutral,
      darks: 60,
      shadowSplit: 80,
      midtoneSplit: 20,
      highlightSplit: 10,
    });
    expect(isMonotonic(crossed)).toBe(true);
  });

  test("the splits move where the regions meet", () => {
    const low = parametricCurveLut({ ...neutral, darks: 80, shadowSplit: 10 });
    const high = parametricCurveLut({ ...neutral, darks: 80, shadowSplit: 60 });
    expect(at(low, 0.3)).not.toBeCloseTo(at(high, 0.3), 3);
  });
});

describe("composeLut", () => {
  test("composing with the identity changes nothing", () => {
    const curve = pointCurveLut([
      { x: 0, y: 0 },
      { x: 0.3, y: 0.5 },
      { x: 1, y: 1 },
    ]);
    const composed = composeLut(curve, identityLut());
    composed.forEach((entry, index) => expect(entry).toBeCloseTo(curve[index], 5));
  });

  test("the second table is applied to the first's output", () => {
    const lift = pointCurveLut([
      { x: 0, y: 0.25 },
      { x: 1, y: 1 },
    ]);
    const composed = composeLut(identityLut(), lift);
    expect(at(composed, 0)).toBeCloseTo(0.25, 5);
  });
});

describe("effectiveLut", () => {
  test("the RGB channel is the parametric curve composed with the RGB points", () => {
    const params = {
      shadows: 50,
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.6 },
        { x: 1, y: 1 },
      ],
    };
    expect(effectiveLut(params, "rgb")).toEqual(sharedLut(params));
    expect(at(effectiveLut(params, "rgb"), 0.5)).toBeGreaterThan(0.6);
  });

  test("a channel curve rides on top of the shared one", () => {
    const params = {
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.6 },
        { x: 1, y: 1 },
      ],
      red: [
        { x: 0, y: 0.1 },
        { x: 1, y: 1 },
      ],
    };
    expect(at(effectiveLut(params, "red"), 0)).toBeCloseTo(0.1, 4);
    expect(at(effectiveLut(params, "green"), 0)).toBeCloseTo(0, 4);
  });

  test("an op with no curve params renders as the identity", () => {
    expect(isIdentityLut(effectiveLut({}, "rgb"))).toBe(true);
    expect(isIdentityLut(effectiveLut({}, "blue"))).toBe(true);
  });
});

describe("editing", () => {
  const curve: CurvePoint[] = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];

  test("a click on an empty curve materialises the endpoints around the new point", () => {
    const edit = insertPoint([], { x: 0.25, y: 0.4 });
    expect(edit.points).toEqual([
      { x: 0, y: 0 },
      { x: 0.25, y: 0.4 },
      { x: 1, y: 1 },
    ]);
    expect(edit.index).toBe(1);
  });

  test("a new point lands in x order", () => {
    const edit = insertPoint(curve, { x: 0.75, y: 0.8 });
    expect(edit.index).toBe(2);
    expect(edit.points.map((point) => point.x)).toEqual([0, 0.5, 0.75, 1]);
  });

  test("an interior point cannot cross its neighbours", () => {
    const moved = movePoint(curve, 1, 2, 0.9);
    expect(moved[1].x).toBeCloseTo(1 - 1 / CURVE_LEVELS, 6);
    const back = movePoint(curve, 1, -2, 0.9);
    expect(back[1].x).toBeCloseTo(1 / CURVE_LEVELS, 6);
  });

  test("a moved point keeps y inside the box", () => {
    expect(movePoint(curve, 1, 0.5, 9)[1].y).toBe(1);
    expect(movePoint(curve, 1, 0.5, -9)[1].y).toBe(0);
  });

  test("the endpoints keep their x: dragging them is the black and white level", () => {
    const black = movePoint(curve, 0, 0.4, 0.2);
    expect(black[0]).toEqual({ x: 0, y: 0.2 });
    const white = movePoint(curve, 2, 0.4, 0.8);
    expect(white[2]).toEqual({ x: 1, y: 0.8 });
  });

  test("only interior points can be removed", () => {
    expect(removePoint(curve, 1)).toHaveLength(2);
    expect(removePoint(curve, 0)).toEqual(curve);
    expect(removePoint(curve, 2)).toEqual(curve);
  });

  test("removing the only interior point leaves the identity", () => {
    expect(curveJson(removePoint(curve, 1))).toEqual([]);
  });

  test("arrows nudge by a level, Shift by ten", () => {
    const one = nudgePoint(curve, 1, 0, 1 / CURVE_LEVELS);
    expect(one[1].y).toBeCloseTo(0.5 + 1 / 255, 6);
    const ten = nudgePoint(curve, 1, 0, 10 / CURVE_LEVELS);
    expect(ten[1].y).toBeCloseTo(0.5 + 10 / 255, 6);
  });

  test("a nudge on nothing changes nothing", () => {
    expect(nudgePoint(curve, 9, 0, 0.1)).toEqual(curve);
    expect(movePoint(curve, 9, 0.5, 0.1)).toEqual(curve);
  });

  test("the arrow keys walk a level, ten with Shift, and nothing else is ours", () => {
    expect(curveArrowDelta("ArrowUp", false)).toEqual({ x: 0, y: 1 / CURVE_LEVELS });
    expect(curveArrowDelta("ArrowDown", false)).toEqual({ x: 0, y: -1 / CURVE_LEVELS });
    expect(curveArrowDelta("ArrowLeft", true)).toEqual({ x: -10 / CURVE_LEVELS, y: 0 });
    expect(curveArrowDelta("ArrowRight", true)).toEqual({ x: 10 / CURVE_LEVELS, y: 0 });
    expect(curveArrowDelta("Enter", false)).toBeNull();
  });

  test("the pointer picks the nearest point inside its tolerance", () => {
    expect(pointNear(curve, 0.52, 0.51, 0.05)).toBe(1);
    expect(pointNear(curve, 0.52, 0.2, 0.05)).toBeNull();
    expect(pointNear(curve, 0.01, 0.01, 0.05)).toBe(0);
  });
});

describe("readout", () => {
  test("prints the 0–255 levels a point maps between", () => {
    expect(curveReadout({ x: 0.25, y: 0.4 })).toBe("64 → 102");
    expect(curveLevel(1)).toBe(255);
    expect(curveLevel(0)).toBe(0);
  });

  test("a pointer outside the graph still reads as a point inside it", () => {
    expect(clampUnit(-0.3)).toBe(0);
    expect(clampUnit(1.4)).toBe(1);
    expect(clampUnit(0.4)).toBe(0.4);
  });
});

describe("splits", () => {
  test("a split is pinned between the ones beside it", () => {
    expect(clampSplit("shadowSplit", 90, neutral)).toBe(50);
    expect(clampSplit("midtoneSplit", 5, neutral)).toBe(25);
    expect(clampSplit("midtoneSplit", 90, neutral)).toBe(75);
    expect(clampSplit("highlightSplit", 10, neutral)).toBe(50);
    expect(clampSplit("highlightSplit", 200, neutral)).toBe(100);
  });
});

/**
 * The mock engine carries its own copy of this maths (`tools/mock-curve.ts`), because the
 * real engine carries one in C++ and the mock stands in for it. These numbers are the
 * contract between the two: `tools/tests/mock-curve.test.ts` asserts the same table for
 * the same params, so neither copy can drift without a red test.
 */
describe("golden samples shared with the mock engine", () => {
  const samples = [
    {
      name: "an RGB lift",
      params: {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.4 },
          { x: 1, y: 1 },
        ],
      },
      red: [
        [0.25, 0.4011754460116312],
        [0.5, 0.646011026762792],
        [0.75, 0.8215686267808844],
      ],
    },
    {
      name: "a red toe over lifted shadows",
      params: {
        shadows: 40,
        highlightSplit: 60,
        red: [
          { x: 0, y: 0.12 },
          { x: 0.6, y: 0.55 },
          { x: 1, y: 1 },
        ],
      },
      red: [
        [0, 0.18883036438976464],
        [0.5, 0.4657290908446196],
        [0.75, 0.7056689609074439],
      ],
    },
    {
      name: "an S-curve",
      params: {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.18 },
          { x: 0.75, y: 0.82 },
          { x: 1, y: 1 },
        ],
      },
      red: [
        [0.25, 0.18098200480961318],
        [0.5, 0.5027842968390739],
        [0.75, 0.8190179951903866],
      ],
    },
  ];

  for (const sample of samples) {
    test(sample.name, () => {
      const lut = effectiveLut(sample.params, "red");
      for (const [x, expected] of sample.red) {
        expect(at(lut, x)).toBeCloseTo(expected, 9);
      }
    });
  }

  test("the parametric table on its own matches too", () => {
    const lut = parametricCurveLut({ ...neutral, shadows: 100, highlights: -100 });
    expect(at(lut, 0.25)).toBeCloseTo(0.375245101808505, 9);
    expect(at(lut, 0.75)).toBeCloseTo(0.624754898191495, 9);
  });
});

describe("lutPath", () => {
  test("strokes one segment per entry with y flipped", () => {
    const path = lutPath(identityLut(), 256);
    expect(path.startsWith("M0.00 256.00 L")).toBe(true);
    expect(path.endsWith("L256.00 0.00")).toBe(true);
    expect(path.split(" L")).toHaveLength(CURVE_LUT_SIZE);
  });
});

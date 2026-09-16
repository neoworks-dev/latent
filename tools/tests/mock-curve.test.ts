import { describe, expect, test } from "bun:test";
import {
  applyLut,
  composeLut,
  CURVE_LUT_SIZE,
  curvePoints,
  curveTable,
  identityLut,
  parametricCurveLut,
  pointCurveLut,
} from "../mock-curve";

/**
 * The mock re-implements the engine's maths rather than importing the panel plugin's copy,
 * the way `mock-masks.ts` re-implements the rasteriser. These numbers are the contract
 * between the two implementations: `plugins/panels/tests/curve.test.ts` asserts the same
 * table for the same params, so neither copy can drift without a red test.
 */
const golden = [
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

/** Reads the table the way the shader does: `x` in 0..1 to the entry it lands on. */
function at(lut: number[], x: number): number {
  return lut[Math.round(x * (CURVE_LUT_SIZE - 1))] ?? 0;
}

describe("mock curve tables", () => {
  test("no curve params is the identity, and the pass is skipped", () => {
    const table = curveTable({});
    expect(table.active).toBe(false);
    expect(table.red).toEqual(identityLut());
  });

  test("an RGB curve moves every channel, a red curve only the red one", () => {
    const rgb = curveTable({
      rgb: [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.4 },
        { x: 1, y: 1 },
      ],
    });
    expect(rgb.active).toBe(true);
    expect(at(rgb.red, 0.25)).toBeCloseTo(0.4, 2);
    expect(at(rgb.green, 0.25)).toBeCloseTo(0.4, 2);

    const red = curveTable({
      red: [
        { x: 0, y: 0.2 },
        { x: 1, y: 1 },
      ],
    });
    expect(at(red.red, 0)).toBeCloseTo(0.2, 4);
    expect(at(red.blue, 0)).toBeCloseTo(0, 4);
  });

  test("the parametric regions ride under the point curves", () => {
    const table = curveTable({ shadows: 100 });
    expect(table.active).toBe(true);
    expect(at(table.green, 0.1)).toBeGreaterThan(0.1);
  });

  test("points that are not numeric {x, y} objects are ignored, as the engine ignores them", () => {
    expect(curvePoints([[0.2, 0.3]])).toEqual([]);
    expect(curvePoints("nope")).toEqual([]);
    expect(curvePoints([{ x: 0.2, y: 0.3 }])).toEqual([{ x: 0.2, y: 0.3 }]);
  });

  test("composing with the identity leaves a table alone", () => {
    const curve = pointCurveLut([
      { x: 0, y: 0 },
      { x: 0.3, y: 0.55 },
      { x: 1, y: 1 },
    ]);
    composeLut(curve, identityLut()).forEach((value, index) => {
      expect(value).toBeCloseTo(curve[index] ?? 0, 5);
    });
  });

  test("the lookup interpolates between entries rather than snapping to one", () => {
    const lut = pointCurveLut([
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
    ]);
    expect(applyLut(lut, 0.5)).toBeCloseTo(0.25, 3);
    expect(applyLut(lut, 1.7)).toBeCloseTo(0.5, 5);
    expect(applyLut(lut, -1)).toBeCloseTo(0, 5);
  });
});

describe("golden samples shared with the panel plugin", () => {
  for (const sample of golden) {
    test(sample.name, () => {
      const table = curveTable(sample.params);
      for (const [x, expected] of sample.red) {
        expect(at(table.red, x ?? 0)).toBeCloseTo(expected ?? 0, 9);
      }
    });
  }

  test("the parametric table on its own matches too", () => {
    const lut = parametricCurveLut({ shadows: 100, highlights: -100 });
    expect(at(lut, 0.25)).toBeCloseTo(0.375245101808505, 9);
    expect(at(lut, 0.75)).toBeCloseTo(0.624754898191495, 9);
  });
});

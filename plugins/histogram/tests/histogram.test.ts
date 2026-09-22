import { describe, expect, test } from "bun:test";
import type { Histogram } from "@latent/protocol";
import { BOX, channelPath, clippingLabel, clippingOf } from "../src/histogram";

function histogram(overrides: Partial<Histogram> = {}): Histogram {
  const flat = (): number[] => new Array<number>(256).fill(0);
  return {
    bins: 256,
    r: flat(),
    g: flat(),
    b: flat(),
    clippedShadowsPct: 0,
    clippedHighlightsPct: 0,
    ...overrides,
  };
}

/** The y of the first point of a path — bin 0, after the `M0 100 L` prefix. */
function firstBinHeight(path: string): number {
  const points = path.slice(path.indexOf("L") + 1).split(" L");
  return Number(points[0]?.split(" ")[1]);
}

describe("the graph", () => {
  test("is empty when nothing has been counted", () => {
    expect(channelPath(histogram(), "r")).toBe("");
  });

  test("closes along the bottom of the box and spans its full width", () => {
    const bins = new Array<number>(256).fill(10);
    const path = channelPath(histogram({ r: bins }), "r");
    expect(path.startsWith(`M0 ${BOX.height} L`)).toBe(true);
    expect(path.endsWith(`L${BOX.width} ${BOX.height} Z`)).toBe(true);
  });

  test("scales every channel against the tallest bin of all three", () => {
    const red = new Array<number>(256).fill(0);
    const green = new Array<number>(256).fill(0);
    red[10] = 50;
    green[10] = 100;
    const counted = histogram({ r: red, g: green });
    const redAt10 = Number(channelPath(counted, "r").split(" L")[11]?.split(" ")[1]);
    const greenAt10 = Number(channelPath(counted, "g").split(" L")[11]?.split(" ")[1]);
    // Square-rooted heights: half the count is 1/√2 of the full bar's height, and y grows
    // downwards, so the shorter bar sits lower.
    expect(greenAt10).toBe(0);
    expect(redAt10).toBeCloseTo(BOX.height - BOX.height * Math.SQRT1_2, 1);
  });

  test("a clipped end bin runs off the top instead of flattening the rest", () => {
    const bins = new Array<number>(256).fill(0);
    bins[0] = 1_000_000;
    bins[100] = 100;
    const path = channelPath(histogram({ r: bins }), "r");
    // Bin 0 is out of the scale, so the real peak still reaches the top of the box.
    expect(firstBinHeight(path)).toBe(0);
    expect(Number(path.split(" L")[101]?.split(" ")[1])).toBe(0);
  });
});

describe("clipping", () => {
  test("lights a corner at a quarter of a percent of the frame, not below", () => {
    const quiet = clippingOf(histogram({ clippedShadowsPct: 0.1, clippedHighlightsPct: 0.24 }));
    expect(quiet.shadows).toBe(false);
    expect(quiet.highlights).toBe(false);

    const loud = clippingOf(histogram({ clippedShadowsPct: 0.25, clippedHighlightsPct: 12 }));
    expect(loud.shadows).toBe(true);
    expect(loud.highlights).toBe(true);
    expect(loud.highlightsPct).toBe(12);
  });

  test("reads a small share at two decimals and a large one at one", () => {
    expect(clippingLabel(0)).toBe("0 %");
    expect(clippingLabel(0.4321)).toBe("0.43 %");
    expect(clippingLabel(12.34)).toBe("12.3 %");
  });
});

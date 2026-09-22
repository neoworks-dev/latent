import { describe, expect, test } from "bun:test";
import type { Op } from "@latent/protocol";
import {
  backendOf,
  batchLabel,
  defaultTrailsParams,
  isRepaintBackend,
  detectLabel,
  paramsOf,
  planesOp,
  seedFromStroke,
  seedIsUsable,
  seedLength,
  seedOf,
  trailsComponentOf,
  trailsMask,
  type SeedPath,
} from "../src/planes";

const seed: SeedPath = [
  [0.1, 0.2],
  [0.25, 0.26],
  [0.4, 0.3],
];

function planesEntry(overrides: Partial<Op> = {}): Op {
  return {
    id: "remove1",
    op: "remove",
    enabled: true,
    params: {},
    mask: trailsMask(seed, defaultTrailsParams),
    ...overrides,
  };
}

describe("the op the column edits", () => {
  test("it is the remove op carrying a trails component, not any remove op", () => {
    const bare: Op = { id: "remove2", op: "remove", enabled: true, params: {} };
    const exposure: Op = { id: "exposure1", op: "exposure", enabled: true, params: {} };
    expect(planesOp([exposure, bare])).toBeUndefined();
    expect(planesOp([exposure, bare, planesEntry()])?.id).toBe("remove1");
  });

  test("the seed and the numbers come off the component", () => {
    const op = planesEntry();
    expect(seedOf(op)).toEqual(seed);
    expect(paramsOf(op)).toEqual(defaultTrailsParams);
    expect(trailsComponentOf(op)?.kind).toBe("trails");
  });

  test("a component without a seed reads as no seed, and the defaults stand in", () => {
    const op = planesEntry({ mask: { components: [] } });
    expect(seedOf(op)).toBeNull();
    // One point is a tap the engine cannot read a direction out of.
    expect(seedOf(planesEntry({ mask: trailsMask([[0.2, 0.2]], defaultTrailsParams) }))).toBeNull();
    expect(paramsOf(op)).toEqual(defaultTrailsParams);
    expect(seedOf(undefined)).toBeNull();
  });

  test("the local sky fill is what repaints, unless the op names ComfyUI", () => {
    expect(backendOf(planesEntry())).toBe("sky");
    expect(backendOf(planesEntry({ params: { backend: "comfy" } }))).toBe("comfy");
    // A backend the engine does not have is not one this column offers.
    expect(backendOf(planesEntry({ params: { backend: "flux" } }))).toBe("sky");
    expect(backendOf(undefined)).toBe("sky");
    expect(isRepaintBackend("stub")).toBe(false);
  });

  test("the mask carries the stroke and the numbers, never pixels — which is what makes it portable", () => {
    const mask = trailsMask(seed, { sensitivity: 70, minLength: 25, grow: 5 });
    const [component] = mask.components;
    expect(component?.params).toEqual({ seed, sensitivity: 70, minLength: 25, grow: 5 });
    expect(JSON.stringify(mask)).not.toContain("raster");
  });
});

describe("the seed stroke", () => {
  test("the raw pointer path is clamped and thinned, and keeps where the hand stopped", () => {
    const drawn = seedFromStroke([
      [-0.2, 0.5],
      [0.3, 0.52],
      // Three samples inside one thinning radius: the hand did not move, the mouse did.
      [0.3005, 0.5202],
      [0.3008, 0.5203],
      [0.42, 0.56],
    ]);
    expect(drawn[0]).toEqual([0, 0.5]);
    expect(drawn).toHaveLength(3);
    expect(drawn[drawn.length - 1]).toEqual([0.42, 0.56]);
  });

  test("a stroke longer than the engine takes is thinned, not rejected", () => {
    const long: SeedPath = Array.from({ length: 900 }, (_, index) => [index / 1000, 0.5]);
    const drawn = seedFromStroke(long);
    expect(drawn.length).toBeLessThanOrEqual(256);
    expect(drawn[drawn.length - 1]).toEqual([0.899, 0.5]);
  });

  test("a tap is not a stroke", () => {
    expect(seedIsUsable(seedFromStroke([[0.5, 0.5]]))).toBe(false);
    expect(
      seedIsUsable(
        seedFromStroke([
          [0.5, 0.5],
          [0.505, 0.505],
        ]),
      ),
    ).toBe(false);
    expect(
      seedIsUsable(
        seedFromStroke([
          [0.5, 0.5],
          [0.6, 0.56],
        ]),
      ),
    ).toBe(true);
    expect(seedLength(seed)).toBeCloseTo(0.3168, 3);
  });
});

describe("what the column says", () => {
  test("the status follows the component's own state", () => {
    expect(detectLabel(undefined, "")).toContain("Draw along");
    const pending = planesEntry();
    pending.mask?.components.forEach((component) => (component.state = "pending"));
    expect(detectLabel(pending, "")).toBe("Detecting…");

    const failed = planesEntry();
    failed.mask?.components.forEach((component) => (component.state = "failed"));
    expect(detectLabel(failed, "that stroke is on a round object, not a trail")).toContain("round");

    const stale = planesEntry();
    stale.mask?.components.forEach((component) => (component.state = "stale"));
    expect(detectLabel(stale, "")).toContain("detect again");
  });

  test("the batch line counts photos and owns up to failures", () => {
    expect(batchLabel(null)).toBe("");
    expect(batchLabel({ done: 2, total: 9, current: "DSC01.RW2", failed: 0 })).toBe(
      "2 of 9 — DSC01.RW2",
    );
    expect(batchLabel({ done: 9, total: 9, current: "", failed: 2 })).toBe(
      "9 of 9 photos done, 2 failed",
    );
  });
});

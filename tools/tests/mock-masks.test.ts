import { describe, expect, test } from "bun:test";
import type { Mask, MaskComponent, Op } from "@latent/protocol";
import { FRAME_FORMAT_R8, FRAME_HEADER_BYTES, parseFrameHeader } from "@latent/protocol";
import {
  combineMask,
  coverageOf,
  isAiKind,
  maskFrame,
  mergeEngineOwned,
  placeholderRegion,
  rasteriseComponent,
  seedComponentStates,
  smoothstep,
  toBytes,
} from "../mock-masks";

/** Flat mid grey, so a luminance or colour mask has something predictable to sample. */
const grey = (): [number, number, number] => [0.5, 0.5, 0.5];

function component(overrides: Partial<MaskComponent> & Pick<MaskComponent, "kind">): MaskComponent {
  return { id: "m1", mode: "add", ...overrides };
}

function coverage(mask: Mask, width = 64, height = 64): number {
  return coverageOf(combineMask(mask, width, height, grey));
}

describe("mask rasterisation", () => {
  test("smoothstep is flat outside its edges and symmetric in between", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    // A zero-width ramp is a step, never a division by zero.
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1);
  });

  test("a radial covers about the area of its ellipse", () => {
    const radial = component({
      kind: "radial",
      feather: 0,
      params: { center: [0.5, 0.5], radius: [0.25, 0.25], angle: 0 },
    });
    // π·0.25² ≈ 0.196 of the frame; the soft edge costs a little of it.
    expect(coverage({ components: [radial] })).toBeGreaterThan(0.15);
    expect(coverage({ components: [radial] })).toBeLessThan(0.22);
  });

  test("invert flips a component, opacity scales it below the 50 % coverage line", () => {
    const radial = component({
      kind: "radial",
      feather: 0,
      params: { center: [0.5, 0.5], radius: [0.25, 0.25] },
    });
    const inside = coverage({ components: [radial] });
    const outside = coverage({ components: [{ ...radial, invert: true }] });
    expect(inside + outside).toBeCloseTo(1, 1);
    // 40 % of a full pixel is below the "above 50 %" rule, so coverage reads as empty.
    expect(coverage({ components: [{ ...radial, opacity: 40 }] })).toBe(0);
  });

  test("a linear gradient ramps from one side to the other", () => {
    const linear = component({
      kind: "linear",
      feather: 50,
      params: { start: [0, 0], end: [1, 0] },
    });
    const raster = rasteriseComponent(linear, 16, 4, grey);
    expect(raster[0]).toBeLessThan(0.1);
    expect(raster[15]).toBeGreaterThan(0.9);
    // Halfway along the axis is halfway up the ramp.
    expect(raster[8]).toBeGreaterThan(0.4);
    expect(raster[8]).toBeLessThan(0.7);
  });

  test("a luminance range selects the brightness it was given, and nothing else", () => {
    const bright = component({ kind: "luminance", params: { range: [0.4, 1], smoothness: 0.05 } });
    const dark = component({ kind: "luminance", params: { range: [0, 0.2], smoothness: 0.05 } });
    expect(coverage({ components: [bright] })).toBe(1);
    expect(coverage({ components: [dark] })).toBe(0);
  });

  test("brush segments accumulate by flow, and an erase segment takes them back", () => {
    const brush = component({
      kind: "brush",
      feather: 20,
      params: {
        size: 0.4,
        flow: 100,
        strokeData: [{ points: [[0.5, 0.5]], size: 0.4, flow: 100, erase: false }],
      },
    });
    const painted = coverage({ components: [brush] });
    expect(painted).toBeGreaterThan(0);

    const erased = {
      ...brush,
      params: {
        ...brush.params,
        strokeData: [
          { points: [[0.5, 0.5]], size: 0.4, flow: 100, erase: false },
          { points: [[0.5, 0.5]], size: 0.4, flow: 100, erase: true },
        ],
      },
    };
    expect(coverage({ components: [erased] })).toBe(0);
  });

  test("modes combine top-down: the first component is the base whatever it says", () => {
    const left = component({
      id: "a",
      kind: "linear",
      mode: "subtract",
      feather: 1,
      params: { start: [0.49, 0], end: [0.51, 0] },
    });
    const wide = component({
      id: "b",
      kind: "radial",
      mode: "add",
      feather: 0,
      params: { center: [0.5, 0.5], radius: [0.4, 0.4] },
    });
    // `subtract` first still seeds the mask: half the frame.
    expect(coverage({ components: [left] })).toBeCloseTo(0.5, 1);
    const added = coverage({ components: [left, wide] });
    const intersected = coverage({ components: [left, { ...wide, mode: "intersect" }] });
    const subtracted = coverage({ components: [left, { ...wide, mode: "subtract" }] });
    expect(added).toBeGreaterThan(intersected);
    expect(intersected).toBeGreaterThan(subtracted);
  });

  test("a pending or failed component contributes nothing to the combined mask", () => {
    const detected = component({
      kind: "subject",
      state: "pending",
      params: { raster: placeholderRegion("subject", {}) },
    });
    expect(coverage({ components: [detected] })).toBe(0);
    expect(coverage({ components: [{ ...detected, state: "ready" }] })).toBeGreaterThan(0);
    expect(coverage({ components: [{ ...detected, state: "failed" }] })).toBe(0);
  });

  test("an AI component without a raster is empty, not an error", () => {
    expect(coverage({ components: [component({ kind: "sky", state: "ready" })] })).toBe(0);
    expect(isAiKind("sky")).toBe(true);
    expect(isAiKind("brush")).toBe(false);
  });

  test("a detect hint's box wins over the kind's default region", () => {
    expect(placeholderRegion("objects", { box: [0.1, 0.2, 0.3, 0.4] })).toEqual({
      shape: "rect",
      box: [0.1, 0.2, 0.3, 0.4],
    });
    expect(placeholderRegion("sky", {}).box[3]).toBeLessThan(0.5);
  });

  test("an LMSK frame is the 32-byte header and one byte per pixel", () => {
    const bytes = toBytes(new Float32Array([0, 0.5, 1, 1]));
    const frame = maskFrame(2, 2, 7, 3, bytes);
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES + 4);
    expect(parseFrameHeader(frame)).toEqual({
      magic: "LMSK",
      width: 2,
      height: 2,
      seq: 7,
      target: 3,
      format: FRAME_FORMAT_R8,
    });
    expect([...new Uint8Array(frame, FRAME_HEADER_BYTES)]).toEqual([0, 128, 255, 255]);
  });
});

describe("engine-owned component fields", () => {
  const stack = (component_: MaskComponent): Op[] => [
    {
      id: "op1",
      op: "exposure",
      params: { value: 1 },
      enabled: true,
      mask: { components: [component_] },
    },
  ];

  test("a stale writer cannot drop the strokes, the raster or the state the engine owns", () => {
    const engine = stack(
      component({
        kind: "brush",
        state: "ready",
        params: {
          strokeData: [{ points: [[0.5, 0.5]], size: 0.1, flow: 100, erase: false }],
          strokes: "brush/b1.bin",
          error: "an earlier failure",
        },
      }),
    );
    const fromUi = stack(component({ kind: "brush", feather: 30, params: { size: 0.2 } }));
    const merged = mergeEngineOwned(engine, fromUi);
    const component_ = merged[0]?.mask?.components[0];
    expect(component_?.feather).toBe(30);
    expect(component_?.params?.size).toBe(0.2);
    expect(component_?.state).toBe("ready");
    expect(component_?.params?.strokeData).toHaveLength(1);
    expect(component_?.params?.strokes).toBe("brush/b1.bin");
    expect(component_?.params?.error).toBe("an earlier failure");
  });

  test("a component the engine has never seen is given the state its kind implies", () => {
    const radial = stack(component({ id: "new", kind: "radial" }));
    expect(mergeEngineOwned([], radial)[0]?.mask?.components[0]?.state).toBe("ready");
    // An AI component is pending from the moment it exists — nothing but a job can
    // rasterise it, and it contributes nothing until one has.
    const subject = stack(component({ id: "s1", kind: "subject" }));
    expect(seedComponentStates(subject)[0]?.mask?.components[0]?.state).toBe("pending");
    expect(coverage({ components: seedComponentStates(subject)[0]?.mask?.components ?? [] })).toBe(
      0,
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { Op } from "@latent/protocol";
import {
  depthToRgba,
  distanceFromDrag,
  distanceFromWheel,
  handleAt,
  kelvinSwatch,
  lightPosition,
  lightsIn,
  type Point,
  radiusFromDrag,
  reachOf,
  type RelightKeyEvent,
  relightShortcut,
  ringPoints,
} from "../src/relight";

/** The sample raw's shape: 3 : 2 landscape. */
const ASPECT = 1.5;

function light(params: Record<string, unknown>, id = "l1"): Op {
  return { id, op: "relight", params, enabled: true } as Op;
}

describe("the lights of a stack", () => {
  test("are found at the top level and inside layers", () => {
    const stack = [
      light({}, "top"),
      { id: "exp", op: "exposure", params: { value: 1 }, enabled: true },
      { id: "layer", op: "group", params: {}, enabled: true, ops: [light({}, "inside")] },
    ] as Op[];
    expect(lightsIn(stack).map((entry) => entry.id)).toEqual(["top", "inside"]);
  });

  test("a stack without one answers empty", () => {
    expect(lightsIn([{ id: "exp", op: "exposure", params: {}, enabled: true } as Op])).toEqual([]);
  });

  test("a light with no params sits in the middle of the frame", () => {
    expect(lightPosition(undefined)).toEqual([0.5, 0.5]);
    expect(lightPosition(light({ x: 0.2, y: 0.8 }))).toEqual([0.2, 0.8]);
  });
});

describe("reach", () => {
  // The engine maps the 0..100 slider onto 0.15..1.75 image heights
  // (pipeline/renderer.cpp); the overlay has to draw the ring the shader actually uses.
  test("mirrors the engine's own mapping", () => {
    expect(reachOf(light({ radius: 0 }))).toBeCloseTo(0.15, 5);
    expect(reachOf(light({ radius: 100 }))).toBeCloseTo(1.75, 5);
    expect(reachOf(undefined)).toBeCloseTo(0.79, 5);
  });

  test("a drag on the ring is the inverse of it", () => {
    const centre: Point = [0.5, 0.5];
    for (const radius of [0, 25, 60, 100]) {
      const reach = reachOf(light({ radius }));
      expect(radiusFromDrag([0.5, 0.5 + reach], centre, ASPECT)).toBe(radius);
    }
  });

  test("and is measured in image heights, so a wide photo does not stretch it", () => {
    const centre: Point = [0.5, 0.5];
    // The same scene distance, once along x and once along y: x is normalised over the
    // width, so it takes `aspect` times less of it to cover the same ground.
    const along_y = radiusFromDrag([0.5, 0.9], centre, ASPECT);
    const along_x = radiusFromDrag([0.5 + 0.4 / ASPECT, 0.5], centre, ASPECT);
    expect(along_x).toBe(along_y);
  });

  test("a drag inside the smallest reach clamps at zero", () => {
    expect(radiusFromDrag([0.5, 0.52], [0.5, 0.5], ASPECT)).toBe(0);
  });
});

describe("the ring", () => {
  test("is a circle in the scene, so it is an ellipse on a wide photo", () => {
    const points = ringPoints([0.5, 0.5], 0.4, ASPECT, 4);
    // Right, top, left, bottom in image-normalised coordinates.
    expect(points[0]?.[0]).toBeCloseTo(0.5 + 0.4 / ASPECT, 5);
    expect(points[1]?.[1]).toBeCloseTo(0.9, 5);
  });

  test("closes: the segments go all the way round", () => {
    expect(ringPoints([0.5, 0.5], 0.3, 1, 64)).toHaveLength(64);
  });
});

describe("the grips", () => {
  // Canvas pixels: the tolerance is a screen distance however far the view is zoomed.
  const centre: Point = [400, 300];

  test("the light is taken near its own handle", () => {
    expect(handleAt([404, 302], centre, 120)).toBe("light");
    expect(handleAt([440, 300], centre, 120)).toBe(null);
  });

  test("the ring is taken near the ring and nowhere else", () => {
    expect(handleAt([520, 300], centre, 120)).toBe("reach");
    expect(handleAt([560, 300], centre, 120)).toBe(null);
  });

  test("a press on neither takes nothing, so the viewer keeps the event", () => {
    expect(handleAt([200, 100], centre, 120)).toBe(null);
  });
});

describe("the colour swatch", () => {
  function channels(color: string): { red: number; blue: number } {
    const values = color.match(/\d+/g)?.map((value) => Number(value)) ?? [];
    return { red: values[0] ?? 0, blue: values[2] ?? 0 };
  }

  test("is warm below 5500 K and cool above it", () => {
    const warm = channels(kelvinSwatch(2700));
    const cool = channels(kelvinSwatch(10000));
    expect(warm.red).toBeGreaterThan(warm.blue);
    expect(cool.blue).toBeGreaterThanOrEqual(cool.red);
  });

  test("an absurd temperature still answers a colour", () => {
    expect(kelvinSwatch(0)).toMatch(/^rgb\(/);
    expect(kelvinSwatch(999999)).toMatch(/^rgb\(/);
  });
});

describe("the depth map as pixels", () => {
  test("is opaque grey: near is white, far is black", () => {
    const rgba = depthToRgba(new Uint8Array([0, 255]));
    expect([...rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe("the light's depth", () => {
  test("dragging up pushes it away, dragging down brings it forward", () => {
    // 0.1 of the frame's height is 20 of the slider's 100.
    expect(distanceFromDrag(50, 0.5, 0.4)).toBe(70);
    expect(distanceFromDrag(50, 0.5, 0.6)).toBe(30);
    expect(distanceFromDrag(50, 0.5, 0.5)).toBe(50);
  });

  test("and it stays on the slider's own scale", () => {
    expect(distanceFromDrag(90, 0.5, 0.0)).toBe(100);
    expect(distanceFromDrag(10, 0.5, 1.0)).toBe(0);
  });

  test("the wheel nudges it either way, one notch at a time", () => {
    expect(distanceFromWheel(50, 120)).toBe(48);
    expect(distanceFromWheel(50, -120)).toBe(52);
    // A trackpad's tiny deltas are still one notch, never a fraction of the parameter.
    expect(distanceFromWheel(50, -3)).toBe(52);
    expect(distanceFromWheel(0, 10)).toBe(0);
    expect(distanceFromWheel(100, -10)).toBe(100);
  });
});

describe("the shortcut", () => {
  function key(
    value: string,
    target: { tagName: string; isContentEditable: boolean } | null,
  ): RelightKeyEvent {
    return { key: value, ctrlKey: false, metaKey: false, altKey: false, target };
  }

  test("L toggles the tool and Esc leaves it", () => {
    expect(relightShortcut(key("l", null))).toBe("toggleTool");
    expect(relightShortcut(key("L", null))).toBe("toggleTool");
    expect(relightShortcut(key("Escape", null))).toBe("leaveTool");
    expect(relightShortcut(key("k", null))).toBe(null);
  });

  test("a keystroke aimed at a text field is that field's", () => {
    const field = { tagName: "INPUT", isContentEditable: false };
    expect(relightShortcut(key("l", field))).toBe(null);
    expect(relightShortcut(key("l", { tagName: "DIV", isContentEditable: true }))).toBe(null);
  });

  test("and a modifier means it is somebody else's shortcut", () => {
    expect(relightShortcut({ ...key("l", null), ctrlKey: true })).toBe(null);
  });
});

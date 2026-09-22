import { describe, expect, test } from "bun:test";
import type { Mask, MaskComponent, Op } from "@latent/protocol";
import {
  addComponent,
  componentId,
  coverageLabel,
  defaultComponent,
  isAiKind,
  kindSpec,
  layerLabel,
  layerOf,
  layersOf,
  maskShortcut,
  maskSignature,
  type MaskAction,
  nextTint,
  patchComponent,
  patchComponentParams,
  removeComponent,
  tintPixels,
  tintStyle,
} from "../src/masks";
import {
  boxFromDrag,
  boxPoints,
  brushSizeAfterStep,
  brushSizeAfterWheel,
  ellipsePoints,
  linearFromDrag,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  radialFromDrag,
  StrokeBuffer,
  strokeSpacing,
} from "../src/tools";

function op(id: string, mask?: Mask): Op {
  const entry: Op = { id, op: "exposure", params: {}, enabled: true };
  if (mask) entry.mask = mask;
  return entry;
}

/** A layer as the engine sends one: a group, its mask, and the adjustments under it. */
function layer(id: string, components: MaskComponent[], ops: Op[] = []): Op {
  return {
    id,
    op: "group",
    params: {},
    enabled: true,
    ops,
    mask: { components },
  };
}

const key = (overrides: Partial<Parameters<typeof maskShortcut>[0]>): MaskAction | null =>
  maskShortcut({
    key: "o",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    ...overrides,
  });

describe("component list edits", () => {
  test("ids are unique inside one mask, whatever was deleted before", () => {
    const mask: Mask = { components: [defaultComponent("brush", "brush1")] };
    expect(componentId(mask, "brush")).toBe("brush2");
    expect(componentId(undefined, "radial")).toBe("radial1");
  });

  test("a new component starts on something the overlay can already draw", () => {
    const radial = defaultComponent("radial", "radial1");
    expect(radial.params?.center).toEqual([0.5, 0.5]);
    expect(radial.mode).toBe("add");
    expect(radial.opacity).toBe(100);
    // An AI kind has no geometry of its own: the job brings it.
    expect(defaultComponent("subject", "subject1").params).toBeUndefined();
  });

  test("add, patch and remove leave the rest of the list alone", () => {
    const first = defaultComponent("radial", "radial1");
    const second = defaultComponent("brush", "brush1");
    const mask = addComponent(addComponent(undefined, first), second);
    expect(mask.components.map((entry) => entry.id)).toEqual(["radial1", "brush1"]);

    const patched = patchComponent(mask, "brush1", { mode: "subtract", invert: true });
    expect(patched.components[1]).toMatchObject({ mode: "subtract", invert: true });
    expect(patched.components[0]).toEqual(first);

    const params = patchComponentParams(patched, "radial1", { angle: 0.5 });
    // Merged into params, not swapped for them.
    expect(params.components[0]?.params).toEqual({
      center: [0.5, 0.5],
      radius: [0.25, 0.25],
      angle: 0.5,
    });

    expect(removeComponent(mask, "brush1")?.components).toHaveLength(1);
    // The last component going takes the mask with it: an empty mask is not a layer.
    expect(removeComponent({ components: [first] }, "radial1")).toBeUndefined();
  });

  test("the panel points at the selected layer, and at the one holding a selected adjustment", () => {
    const stack = [
      layer("g1", [defaultComponent("radial", "radial1")], [op("child1")]),
      op("op2"),
      layer("g2", [defaultComponent("brush", "brush1")]),
    ];
    expect(layersOf(stack).map((entry) => entry.id)).toEqual(["g1", "g2"]);
    // Nothing selected is the photo itself: the Edit column's sliders follow this, so a
    // mask nobody picked must not catch them.
    expect(layerOf(stack, null)).toBeUndefined();
    expect(layerOf(stack, "g1")?.id).toBe("g1");
    // A child is edited in the layer that holds it, not on its own.
    expect(layerOf(stack, "child1")?.id).toBe("g1");
    // An op outside every layer is not a mask selection either.
    expect(layerOf(stack, "op2")).toBeUndefined();
    expect(layerOf([op("op1")], null)).toBeUndefined();
  });

  test("a layer is labelled by its number and the kinds in it", () => {
    expect(layerLabel(layer("g1", [defaultComponent("radial", "radial1")]), 0)).toBe(
      "Mask 1 · radial",
    );
    expect(
      layerLabel(
        layer("g2", [defaultComponent("sky", "sky1"), defaultComponent("brush", "brush1")]),
        1,
      ),
    ).toBe("Mask 2 · sky, brush");
    // A layer whose mask is still empty is a mask the user is in the middle of making.
    expect(layerLabel(layer("g3", []), 2)).toBe("Mask 3");
  });

  test("the preview signature changes with the mask and with the selection, not with a param", () => {
    const masked = op("op1", { components: [defaultComponent("radial", "radial1")] });
    const base = maskSignature(masked, null);
    expect(maskSignature(masked, null)).toBe(base);
    expect(maskSignature(masked, "radial1")).not.toBe(base);
    const moved: Op = { ...masked, params: { value: 2 } };
    expect(maskSignature(moved, null)).toBe(base);
    const feathered = op("op1", {
      components: [{ ...defaultComponent("radial", "radial1"), feather: 10 }],
    });
    expect(maskSignature(feathered, null)).not.toBe(base);
  });

  test("the AI kinds are the ones mask.detect takes", () => {
    expect(isAiKind("subject")).toBe(true);
    expect(isAiKind("text")).toBe(true);
    expect(isAiKind("radial")).toBe(false);
    expect(kindSpec("brush").tool).toBe("brush");
    expect(kindSpec("luminance").tool).toBe("none");
  });
});

describe("overlay tint", () => {
  test("Shift+O walks the four styles and comes back", () => {
    expect(nextTint("red")).toBe("green");
    expect(nextTint(nextTint(nextTint(nextTint("red"))))).toBe("red");
  });

  test("the tint paints its colour with the coverage as alpha", () => {
    const pixels = tintPixels(new Uint8Array([0, 255]), "red");
    const { color, alpha } = tintStyle("red");
    expect([...pixels.slice(0, 4)]).toEqual([...color, 0]);
    expect([...pixels.slice(4, 7)]).toEqual([...color]);
    expect(pixels[7]).toBe(Math.round(255 * alpha));
  });

  test("black on white is the only style with a wash under it", () => {
    expect(tintStyle("blackOnWhite").wash).not.toBeNull();
    expect(tintStyle("white").wash).toBeNull();
  });

  test("coverage reads as a percentage, and says so when there is nothing", () => {
    expect(coverageLabel(0)).toBe("empty");
    expect(coverageLabel(0.004)).toBe("<1%");
    expect(coverageLabel(0.183)).toBe("18%");
  });
});

describe("tools", () => {
  test("a radial drag is a centre and a radius, never a negative one", () => {
    expect(radialFromDrag([0.5, 0.5], [0.7, 0.4])).toEqual({
      center: [0.5, 0.5],
      radius: [0.2, 0.1],
      angle: 0,
    });
    // A click without a drag still has an ellipse to show for it.
    const tiny = radialFromDrag([0.5, 0.5], [0.5, 0.5]).radius as number[];
    expect(tiny[0]).toBeGreaterThan(0);
  });

  test("a linear drag keeps its direction and stays inside the image", () => {
    expect(linearFromDrag([0.2, 0.9], [0.2, 0.1])).toEqual({ start: [0.2, 0.9], end: [0.2, 0.1] });
    expect(linearFromDrag([-0.4, 1.4], [0.5, 0.5]).start).toEqual([0, 1]);
  });

  test("a box drag comes out corner-ordered", () => {
    expect(boxFromDrag([0.8, 0.9], [0.2, 0.3])).toEqual([0.2, 0.3, 0.8, 0.9]);
  });

  test("the wheel scales the brush and the brackets step it, both within bounds", () => {
    expect(brushSizeAfterWheel(0.1, -100)).toBeGreaterThan(0.1);
    expect(brushSizeAfterWheel(0.1, 100)).toBeLessThan(0.1);
    expect(brushSizeAfterWheel(0.1, 0)).toBe(0.1);
    expect(brushSizeAfterStep(MIN_BRUSH_SIZE, -1)).toBe(MIN_BRUSH_SIZE);
    expect(brushSizeAfterStep(MAX_BRUSH_SIZE, 1)).toBe(MAX_BRUSH_SIZE);
  });

  test("the stroke buffer thins by distance and hands out one segment at a time", () => {
    const buffer = new StrokeBuffer();
    const spacing = strokeSpacing(0.08);
    expect(buffer.push([0.1, 0.1], spacing)).toBe(true);
    // Within a quarter of the brush's width of the last point: the same dab.
    expect(buffer.push([0.1 + spacing / 2, 0.1], spacing)).toBe(false);
    expect(buffer.push([0.5, 0.5], spacing)).toBe(true);
    expect(buffer.pending).toBe(2);
    expect(buffer.take()).toEqual([
      [0.1, 0.1],
      [0.5, 0.5],
    ]);
    expect(buffer.pending).toBe(0);
    // The anchor survives the take, so the committing call has a point to send.
    expect(buffer.anchor).toEqual([0.5, 0.5]);
    buffer.reset();
    expect(buffer.anchor).toBeNull();
  });

  test("an ellipse is image-space points, so the map can bend them", () => {
    const points = ellipsePoints([0.5, 0.5], [0.25, 0.5]);
    // Right, bottom, left, top of the ellipse: the extremes are the parameters themselves.
    expect(points[0]).toEqual([0.75, 0.5]);
    expect(points[16]).toEqual([0.5, 1]);
    const centre = points.reduce((sum, [x, y]) => [sum[0] + x, sum[1] + y], [0, 0]);
    expect(centre[0] / points.length).toBeCloseTo(0.5, 6);
    expect(centre[1] / points.length).toBeCloseTo(0.5, 6);
  });

  test("a box is its four corners, clockwise from the top left", () => {
    expect(boxPoints([0.1, 0.2, 0.6, 0.8])).toEqual([
      [0.1, 0.2],
      [0.6, 0.2],
      [0.6, 0.8],
      [0.1, 0.8],
    ]);
  });
});

describe("shortcuts", () => {
  test("O toggles, Shift+O cycles, brackets size the brush", () => {
    expect(key({})).toBe("toggleOverlay");
    expect(key({ shiftKey: true })).toBe("cycleTint");
    expect(key({ key: "[" })).toBe("brushSmaller");
    expect(key({ key: "]" })).toBe("brushLarger");
    expect(key({ key: "k" })).toBeNull();
  });

  test("a keystroke aimed at a text field belongs to the field", () => {
    expect(key({ target: { tagName: "INPUT", isContentEditable: false } })).toBeNull();
    expect(key({ target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(key({ ctrlKey: true })).toBeNull();
  });
});

describe("component state", () => {
  test("a component the engine is still working on says so", () => {
    const pending: MaskComponent = { id: "s1", kind: "subject", mode: "add", state: "pending" };
    expect(pending.state).toBe("pending");
    expect(
      patchComponent({ components: [pending] }, "s1", { state: "ready" }).components[0]?.state,
    ).toBe("ready");
  });
});

import { describe, expect, test } from "bun:test";
import type { Op, OpDefinition, OpParamSpec } from "@latent/protocol";
import {
  compareOrder,
  controlKind,
  controlValue,
  curveParams,
  curveStroke,
  decimalsFor,
  defaultParams,
  detented,
  editableText,
  fillBounds,
  formatValue,
  generatedParams,
  groupBySection,
  groupEdited,
  historyShortcut,
  isBipolar,
  keyboardDelta,
  layerBadge,
  layerEntryId,
  maskTargetLabel,
  mixerChannels,
  mixerParams,
  opEdited,
  paramValue,
  parseValue,
  pendingNote,
  percentOf,
  quantize,
  readoutUnit,
  rowLabel,
  scrubbedValue,
  sectionLabel,
  sliderRange,
  trackTint,
} from "../src/panels";

const panelOfSection: Record<NonNullable<OpDefinition["section"]>, OpDefinition["panel"]> = {
  Light: "light",
  Color: "color",
  Effects: "effects",
  Detail: "detail",
  Optics: "optics",
  Geometry: "geometry",
  Generative: "generative",
};

/** An op as the current engine describes it: a `section` and a place inside it. */
function op(
  name: string,
  section: NonNullable<OpDefinition["section"]>,
  order: number,
  params: OpParamSpec[],
): OpDefinition {
  return { name, panel: panelOfSection[section], section, order, label: name, params };
}

/** An op from an engine that predates `section` and `order`: `panel` is all there is. */
function legacyOp(name: string, panel: OpDefinition["panel"], params: OpParamSpec[]): OpDefinition {
  return { name, panel, label: name, params };
}

const exposure = op("exposure", "Light", 1, [
  {
    name: "value",
    type: "number",
    min: -5,
    max: 5,
    step: 0.01,
    unit: "EV",
    default: 0,
    display: { kind: "slider" },
  },
]);
const whiteBalance = op("white_balance", "Color", 1, [
  {
    name: "temperature",
    type: "integer",
    min: -100,
    max: 100,
    default: 0,
    display: { kind: "kelvin", tint: "temperature" },
  },
  {
    name: "tint",
    label: "Tint",
    type: "integer",
    min: -100,
    max: 100,
    default: 0,
    display: { kind: "slider", tint: "tint" },
  },
]);
const grain = op("grain", "Effects", 1, [
  { name: "enabled", type: "boolean", default: false, display: { kind: "toggle" } },
]);
const sharpening = op("sharpening", "Detail", 1, [
  { name: "amount", type: "integer", min: 0, max: 150, default: 40, display: { kind: "slider" } },
]);

function stackEntry(name: string, params: Record<string, unknown>): Op {
  return { id: `op-${name}`, op: name, params, enabled: true };
}

describe("groupBySection", () => {
  const amount: OpParamSpec[] = [{ name: "value", type: "number", default: 0 }];

  test("orders sections the way Lightroom does, not the way the engine listed them", () => {
    const groups = groupBySection([grain, whiteBalance, exposure]);
    expect(groups.map((group) => group.key)).toEqual(["light", "color", "effects"]);
    expect(groups.map((group) => group.label)).toEqual(["Light", "Color", "Effects"]);
  });

  test("`order` lays the sliders out, whatever order the engine described them in", () => {
    const vibrance = op("vibrance", "Color", 2, amount);
    const saturation = op("saturation", "Color", 3, amount);
    const groups = groupBySection([saturation, vibrance, whiteBalance]);
    expect(groups[0]?.ops.map((entry) => entry.name)).toEqual([
      "white_balance",
      "vibrance",
      "saturation",
    ]);
  });

  test("an op with no `order` sorts after the ops that have one", () => {
    const custom = { ...op("clarity", "Light", 1, amount), order: undefined };
    const contrast = op("contrast", "Light", 2, amount);
    const groups = groupBySection([custom, contrast, exposure]);
    expect(groups[0]?.ops.map((entry) => entry.name)).toEqual(["exposure", "contrast", "clarity"]);
    expect(compareOrder(exposure, contrast)).toBeLessThan(0);
    expect(compareOrder(custom, custom)).toBe(0);
  });

  test("sections the engine invents sort after the known ones", () => {
    const custom: OpDefinition = {
      name: "halftone",
      panel: "generative",
      section: undefined,
      label: "halftone",
      params: amount,
    };
    expect(groupBySection([custom, exposure]).map((group) => group.key)).toEqual([
      "light",
      "generative",
    ]);
  });
});

describe("an engine that predates `section`", () => {
  const amount: OpParamSpec[] = [{ name: "value", type: "number", default: 0 }];

  test("falls back to the panel name, titled, in Lightroom's order", () => {
    const legacyExposure = legacyOp("exposure", "light", amount);
    const legacyVibrance = legacyOp("vibrance", "color", amount);
    expect(sectionLabel(legacyExposure)).toBe("Light");
    const groups = groupBySection([legacyVibrance, legacyExposure]);
    expect(groups.map((group) => group.label)).toEqual(["Light", "Color"]);
  });

  test("keeps the engine's op order inside a panel, rather than sorting by name", () => {
    const groups = groupBySection([
      legacyOp("exposure", "light", amount),
      legacyOp("contrast", "light", amount),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ops.map((entry) => entry.name)).toEqual(["exposure", "contrast"]);
  });
});

describe("param to control mapping", () => {
  test("`display.kind` picks the control: sliders, Kelvin sliders, toggles", () => {
    expect(
      controlKind({ name: "a", type: "number", default: 0, display: { kind: "slider" } }),
    ).toBe("slider");
    expect(
      controlKind({ name: "a", type: "number", default: 0, display: { kind: "kelvin" } }),
    ).toBe("slider");
    expect(
      controlKind({ name: "a", type: "boolean", default: false, display: { kind: "toggle" } }),
    ).toBe("checkbox");
  });

  test("a curve gets a placeholder, never a slider over values a slider cannot hold", () => {
    const curve: OpParamSpec = {
      name: "a",
      type: "curve",
      default: null,
      display: { kind: "curve" },
    };
    expect(controlKind(curve)).toBe("pending");
    expect(pendingNote).toBe("Drawn by the curve editor");
  });

  test("without `display` the param's type still picks a control", () => {
    expect(controlKind({ name: "a", type: "number", default: 0 })).toBe("slider");
    expect(controlKind({ name: "a", type: "integer", default: 0 })).toBe("slider");
    expect(controlKind({ name: "a", type: "boolean", default: false })).toBe("checkbox");
    expect(controlKind({ name: "a", type: "enum", values: ["x", "y"], default: "x" })).toBe(
      "select",
    );
    expect(controlKind({ name: "a", type: "curve", default: null })).toBe("pending");
  });

  test("a valueless enum gets no generated control", () => {
    expect(controlKind({ name: "a", type: "enum", default: "x" })).toBe("unsupported");
  });

  test("a missing range falls back to Lightroom's ±100, integers step by one", () => {
    expect(sliderRange({ name: "a", type: "integer", default: 0 })).toEqual({
      min: -100,
      max: 100,
      step: 1,
    });
    expect(sliderRange(exposure.params[0])).toEqual({ min: -5, max: 5, step: 0.01 });
  });

  test("a one-parameter op is labelled by the op, a multi-parameter op by the parameter", () => {
    expect(rowLabel(exposure, exposure.params[0])).toBe("exposure");
    expect(rowLabel(whiteBalance, whiteBalance.params[0])).toBe("Temperature");
    expect(rowLabel(whiteBalance, whiteBalance.params[1])).toBe("Tint");
  });
});

describe("readout", () => {
  test("the step decides the precision", () => {
    expect(decimalsFor(1)).toBe(0);
    expect(decimalsFor(0.5)).toBe(1);
    expect(decimalsFor(0.01)).toBe(2);
    expect(decimalsFor(0.001)).toBe(3);
  });

  test("a bipolar slider signs every non-zero value and carries the unit", () => {
    expect(formatValue(1.234, exposure.params[0])).toBe("+1.23 EV");
    expect(formatValue(0, exposure.params[0])).toBe("0.00 EV");
    expect(formatValue(-42.4, whiteBalance.params[1])).toBe("−42");
    expect(formatValue(19, whiteBalance.params[1])).toBe("+19");
  });

  test("a Kelvin slider prints K and never a plus, because it is an absolute temperature", () => {
    expect(readoutUnit(whiteBalance.params[0])).toBe("K");
    expect(readoutUnit(whiteBalance.params[1])).toBe("");
    expect(readoutUnit(exposure.params[0])).toBe("EV");
    expect(formatValue(5500, whiteBalance.params[0])).toBe("5500 K");
    expect(formatValue(0, whiteBalance.params[0])).toBe("0 K");
    expect(formatValue(-42, whiteBalance.params[0])).toBe("−42 K");
  });

  test("a one-sided slider stays unsigned, and a rounded zero never prints as −0", () => {
    expect(formatValue(40, sharpening.params[0])).toBe("40");
    expect(formatValue(-0.001, exposure.params[0])).toBe("0.00 EV");
  });

  test("clicking the field offers plain re-typeable text, not the signed readout", () => {
    expect(editableText(-1.5, exposure.params[0])).toBe("-1.50");
    expect(editableText(19, whiteBalance.params[0])).toBe("19");
  });

  test("typed text is parsed back through the unit, the typographic minus and the step", () => {
    const range = sliderRange(exposure.params[0]);
    expect(parseValue("1.239 EV", range)).toBe(1.24);
    expect(parseValue("−2", range)).toBe(-2);
    expect(parseValue("  +3.5  ", range)).toBe(3.5);
    expect(parseValue("99", range)).toBe(5);
    expect(parseValue("", range)).toBe(null);
    expect(parseValue("abc", range)).toBe(null);
  });
});

describe("slider arithmetic", () => {
  const evRange = sliderRange(exposure.params[0]);
  const amountRange = sliderRange(sharpening.params[0]);

  test("dragging snaps to the step and clamps to the range", () => {
    expect(quantize(1.23456, evRange)).toBe(1.23);
    expect(quantize(9, evRange)).toBe(5);
    expect(quantize(-9, evRange)).toBe(-5);
  });

  test("only a range that straddles zero is bipolar", () => {
    expect(isBipolar(evRange)).toBe(true);
    expect(isBipolar(amountRange)).toBe(false);
  });

  test("a bipolar drag near the middle snaps to zero, a one-sided one never does", () => {
    expect(detented(0.1, evRange)).toBe(0);
    expect(detented(0.2, evRange)).toBe(0.2);
    expect(detented(-0.1, evRange)).toBe(0);
    expect(detented(1, amountRange)).toBe(1);
  });

  test("the fill runs from the centre on bipolar sliders and from the left otherwise", () => {
    expect(percentOf(0, evRange)).toBe(50);
    expect(fillBounds(2.5, evRange)).toEqual({ left: 50, width: 25 });
    expect(fillBounds(-2.5, evRange)).toEqual({ left: 25, width: 25 });
    expect(fillBounds(75, amountRange)).toEqual({ left: 0, width: 50 });
  });

  test("scrubbing sweeps the range in 800 px, ten times that with Shift", () => {
    const plain = { shiftKey: false, ctrlKey: false, altKey: false };
    // −5…5 is ten units, so 80 px is one of them whatever the step says.
    expect(scrubbedValue(0, 80, evRange, plain)).toBe(1);
    expect(scrubbedValue(0, 8, evRange, { ...plain, shiftKey: true })).toBe(1);
    expect(scrubbedValue(0, 80, evRange, { ...plain, ctrlKey: true })).toBe(0.25);
    // The same 80 px on a 0…150 slider: its own range over the same travel, snapped to
    // the integer step.
    expect(scrubbedValue(0, 80, amountRange, plain)).toBe(15);
    expect(scrubbedValue(1, -400, evRange, plain)).toBe(-4);
  });

  test("arrow keys step, Shift steps ten, other keys are not the slider's", () => {
    expect(keyboardDelta("ArrowRight", false, evRange)).toBe(0.01);
    expect(keyboardDelta("ArrowUp", true, evRange)).toBe(0.1);
    expect(keyboardDelta("ArrowLeft", false, evRange)).toBe(-0.01);
    expect(keyboardDelta("ArrowDown", true, evRange)).toBe(-0.1);
    expect(keyboardDelta("Enter", false, evRange)).toBe(null);
  });

  test("the track's gradient comes from `display.tint`, not from the parameter's name", () => {
    const temperature = trackTint(whiteBalance.params[0]) ?? "";
    expect(temperature).toContain("--ctx-blue");
    expect(temperature).toContain("--ctx-amber");
    const tint = trackTint(whiteBalance.params[1]) ?? "";
    expect(tint).toContain("--ctx-green");
    expect(tint).toContain("--ctx-pink");
    // A parameter called "temperature" with no `display` is a plain track now.
    expect(trackTint({ name: "temperature", type: "number", default: 0 })).toBe(null);
    expect(trackTint(exposure.params[0])).toBe(null);
  });

  test("hue runs the spectrum and saturation starts from grey", () => {
    const hue =
      trackTint({
        name: "hue",
        type: "number",
        default: 0,
        display: { kind: "slider", tint: "hue" },
      }) ?? "";
    expect(hue).toContain("--ctx-red");
    expect(hue).toContain("--ctx-violet");
    const saturation =
      trackTint({
        name: "saturation",
        type: "number",
        default: 0,
        display: { kind: "slider", tint: "saturation" },
      }) ?? "";
    expect(saturation.startsWith("linear-gradient(to right, var(--color-line-strong)")).toBe(true);
    expect(saturation).toContain("--ctx-green");
  });
});

describe("edited detection", () => {
  test("a parameter reads the stack when the op is in it, the default otherwise", () => {
    const stack = [stackEntry("exposure", { value: 1.5 })];
    expect(paramValue(stack, exposure, exposure.params[0])).toBe(1.5);
    expect(paramValue([], exposure, exposure.params[0])).toBe(0);
    expect(paramValue([stackEntry("exposure", {})], exposure, exposure.params[0])).toBe(0);
  });

  test("an op at its defaults is not edited, whichever parameter moved", () => {
    expect(opEdited([stackEntry("exposure", { value: 0 })], exposure)).toBe(false);
    expect(opEdited([stackEntry("exposure", { value: 0.4 })], exposure)).toBe(true);
    expect(opEdited([stackEntry("white_balance", { tint: -3 })], whiteBalance)).toBe(true);
  });

  test("a float the engine rounded inside half a step still counts as the default", () => {
    expect(opEdited([stackEntry("exposure", { value: 0.004 })], exposure)).toBe(false);
    expect(opEdited([stackEntry("exposure", { value: 0.006 })], exposure)).toBe(true);
  });

  test("the section dot lights when any op in the group moved", () => {
    const [light, color] = groupBySection([exposure, whiteBalance]);
    const stack = [stackEntry("white_balance", { temperature: 20 })];
    expect(groupEdited(stack, light)).toBe(false);
    expect(groupEdited(stack, color)).toBe(true);
  });

  test("a selected mask is what edited means: the layer's copy, not the photo's", () => {
    const layer: Op = {
      id: "g1",
      op: "group",
      params: {},
      enabled: true,
      ops: [{ id: "child", op: "exposure", params: { value: 0.8 }, enabled: true }],
    };
    const stack = [stackEntry("exposure", { value: 1.5 }), layer];
    expect(layerEntryId(stack, "g1", "exposure")).toBe("child");
    // The layer does not hold white_balance, so that slider has nothing of its own yet.
    expect(layerEntryId(stack, "g1", "white_balance")).toBe(null);
    expect(layerEntryId(stack, null, "exposure")).toBe(null);
    expect(paramValue(stack, exposure, exposure.params[0], "child")).toBe(0.8);
    expect(opEdited(stack, whiteBalance, "g1")).toBe(false);
    expect(opEdited(stack, exposure, "g1")).toBe(true);
    // The photo's own exposure is 1.5, but an empty layer is still an unedited one.
    expect(opEdited([stackEntry("exposure", { value: 1.5 })], exposure, "g1")).toBe(false);
    expect(maskTargetLabel(stack, "g1")).toBe("Mask 1");
    expect(maskTargetLabel(stack, "missing")).toBe(null);
    // What the column shows: the layer's copy, the default where it has none — never the
    // photo's value, which is not where the next drag would land.
    expect(controlValue(stack, exposure, exposure.params[0], "child", "g1")).toBe(0.8);
    expect(controlValue(stack, exposure, exposure.params[0], null, "g1")).toBe(0);
    expect(controlValue(stack, exposure, exposure.params[0], null, null)).toBe(1.5);
  });

  test("a section reset writes every parameter of an op in one call", () => {
    expect(defaultParams(whiteBalance)).toEqual({ temperature: 0, tint: 0 });
    expect(defaultParams(sharpening)).toEqual({ amount: 40 });
  });
});

describe("the layer badge", () => {
  /** A mask as the engine sends one: a group, its components, its adjustments. */
  function layer(id: string, children: Op[], opacity?: number): Op {
    const entry: Op = {
      id,
      op: "group",
      params: {},
      enabled: true,
      mask: { components: [{ id: "sky1", kind: "sky", mode: "add" }] },
      ops: children,
    };
    if (opacity !== undefined) entry.opacity = opacity;
    return entry;
  }

  test("an adjustment that is also inside a mask says so, and opens that mask", () => {
    const stack = [
      stackEntry("exposure", { value: 1 }),
      layer("g1", [stackEntry("exposure", { value: -1 })], 60),
    ];
    // The Edit column's slider is the global one; the badge points at the layer that holds
    // the other copy of it.
    expect(layerBadge(stack, exposure)).toEqual({
      opId: "g1",
      layers: 1,
      components: 1,
      opacity: 60,
    });
    // A global adjustment nothing masks has no badge.
    expect(layerBadge([stackEntry("exposure", { value: 1 })], exposure)).toBeNull();
    expect(layerBadge([], exposure)).toBeNull();
  });

  test("two masks holding the same adjustment count, and the first one opens", () => {
    const stack = [
      layer("g1", [stackEntry("exposure", { value: 1 })]),
      layer("g2", [stackEntry("exposure", { value: 2 })]),
    ];
    expect(layerBadge(stack, exposure)).toMatchObject({ opId: "g1", layers: 2 });
  });

  test("an op that is a layer only by its opacity still shows one", () => {
    const faint: Op = { ...stackEntry("exposure", { value: 1 }), opacity: 50 };
    expect(layerBadge([faint], exposure)).toEqual({
      opId: "op-exposure",
      layers: 0,
      components: 0,
      opacity: 50,
    });
  });
});

describe("curve params", () => {
  const rgb: OpParamSpec = { name: "rgb", type: "curve", default: [], display: { kind: "curve" } };
  const red: OpParamSpec = { name: "red", type: "curve", default: [], display: { kind: "curve" } };
  const amount = (name: string, value = 0): OpParamSpec => ({
    name,
    label: name,
    type: "number",
    min: name.endsWith("Split") ? 0 : -100,
    max: 100,
    step: 1,
    default: value,
    display: { kind: "slider" },
  });
  const toneCurve = op("tone_curve", "Light", 7, [
    amount("highlights"),
    amount("shadows"),
    amount("shadowSplit", 25),
    amount("midtoneSplit", 50),
    amount("highlightSplit", 75),
    rgb,
    red,
  ]);

  test("an op with point curves hands every parameter to the editor", () => {
    const curve = curveParams(toneCurve);
    expect(curve?.points.map((spec) => spec.name)).toEqual(["rgb", "red"]);
    expect(curve?.regions.map((spec) => spec.name)).toEqual(["highlights", "shadows"]);
    expect(curve?.splits.map((split) => split.name)).toEqual([
      "shadowSplit",
      "midtoneSplit",
      "highlightSplit",
    ]);
    expect(generatedParams(toneCurve)).toEqual([]);
  });

  test("an op without one is generated the way it always was", () => {
    expect(curveParams(exposure)).toBeNull();
    expect(generatedParams(exposure)).toEqual(exposure.params);
  });

  test("the splits come back in Lightroom's order however the engine listed them", () => {
    const shuffled = op("tone_curve", "Light", 7, [
      amount("highlightSplit", 75),
      amount("shadowSplit", 25),
      amount("midtoneSplit", 50),
      rgb,
    ]);
    expect(curveParams(shuffled)?.splits.map((split) => split.name)).toEqual([
      "shadowSplit",
      "midtoneSplit",
      "highlightSplit",
    ]);
  });

  test("a curve at its identity is not an edit, even though it is a fresh array", () => {
    expect(opEdited([stackEntry("tone_curve", { rgb: [] })], toneCurve)).toBe(false);
    const anchors = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(opEdited([stackEntry("tone_curve", { rgb: anchors })], toneCurve)).toBe(false);
    const lifted = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.7 },
      { x: 1, y: 1 },
    ];
    expect(opEdited([stackEntry("tone_curve", { rgb: lifted })], toneCurve)).toBe(true);
  });

  test("every tab is stroked in a context token, never a hex", () => {
    for (const tab of ["parametric", "rgb", "red", "green", "blue", "luma"]) {
      expect(curveStroke(tab)).toMatch(/^var\(--/);
    }
  });
});

describe("colour mixer params", () => {
  const band = (name: string, channel: string, tint?: OpParamSpec["display"]): OpParamSpec => ({
    name: `${name}${channel}`,
    label: `${name} ${channel.toLowerCase()}`,
    type: "number",
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    display: tint ?? { kind: "hsl" },
  });
  const mixer = op("color_mixer", "Color", 4, [
    band("red", "Hue", { kind: "hsl", tint: "hue" }),
    band("red", "Saturation", { kind: "hsl", tint: "saturation" }),
    band("red", "Luminance"),
    band("orange", "Hue", { kind: "hsl", tint: "hue" }),
    band("orange", "Saturation", { kind: "hsl", tint: "saturation" }),
    band("orange", "Luminance"),
  ]);

  test("the flat parameters group into bands, in the engine's order", () => {
    const params = mixerParams(mixer);
    expect(params?.bands.map((entry) => entry.name)).toEqual(["red", "orange"]);
    expect(params?.bands[0]?.label).toBe("Red");
    expect(params?.bands[0]?.sliders.map((slider) => slider.channel)).toEqual(
      mixerChannels.slice(),
    );
    expect(generatedParams(mixer)).toEqual([]);
  });

  test("a mixer slider is an ordinary slider, never a placeholder", () => {
    expect(controlKind(mixer.params[0])).toBe("slider");
    expect(controlKind(mixer.params[2])).toBe("slider");
  });

  test("the hue and saturation tracks keep the tint the engine asked for", () => {
    expect(trackTint(mixer.params[0])).toContain("--ctx-red");
    expect(trackTint(mixer.params[1])).toContain("--color-line-strong");
    expect(trackTint(mixer.params[2])).toBeNull();
  });

  test("an op with no mixer band is generated the way it always was", () => {
    expect(mixerParams(exposure)).toBeNull();
    expect(generatedParams(exposure)).toEqual(exposure.params);
  });

  test("an `hsl` parameter whose name carries no channel is not the mixer's", () => {
    const odd = op("color_mixer", "Color", 4, [
      { name: "Hue", type: "number", default: 0, display: { kind: "hsl" } },
    ]);
    expect(mixerParams(odd)).toBeNull();
  });
});

describe("history shortcuts", () => {
  test("Ctrl+Z undoes, Ctrl+Shift+Z redoes, plain keys are left alone", () => {
    expect(historyShortcut({ key: "z", ctrlKey: true, shiftKey: false })).toBe("undo");
    expect(historyShortcut({ key: "Z", ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(historyShortcut({ key: "z", ctrlKey: false, shiftKey: false })).toBe(null);
    expect(historyShortcut({ key: "y", ctrlKey: true, shiftKey: false })).toBe(null);
  });
});

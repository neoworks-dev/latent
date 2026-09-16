import { describe, expect, test } from "bun:test";
import type { OpDefinition, OpParamSpec } from "@latent/protocol";
import {
  controlKind,
  formatValue,
  groupByPanel,
  historyShortcut,
  quantize,
  rowLabel,
  sliderRange,
} from "../src/panels";

function op(name: string, panel: OpDefinition["panel"], params: OpParamSpec[]): OpDefinition {
  return { name, panel, label: name, params };
}

const exposure = op("exposure", "light", [
  { name: "value", type: "number", min: -5, max: 5, step: 0.01, unit: "EV", default: 0 },
]);
const whiteBalance = op("white_balance", "color", [
  { name: "temperature", type: "integer", min: -100, max: 100, default: 0 },
  { name: "tint", label: "Tint", type: "integer", min: -100, max: 100, default: 0 },
]);
const grain = op("grain", "effects", [{ name: "enabled", type: "boolean", default: false }]);

describe("groupByPanel", () => {
  test("orders panels the way Lightroom does, not the way the engine listed them", () => {
    const groups = groupByPanel([grain, whiteBalance, exposure]);
    expect(groups.map((group) => group.panel)).toEqual(["light", "color", "effects"]);
    expect(groups.map((group) => group.label)).toEqual(["Light", "Color", "Effects"]);
  });

  test("keeps the engine's op order inside a panel and skips panels with no ops", () => {
    const contrast = op("contrast", "light", [{ name: "value", type: "number", default: 0 }]);
    const groups = groupByPanel([exposure, contrast]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ops.map((entry) => entry.name)).toEqual(["exposure", "contrast"]);
  });

  test("panels the engine invents sort after the known ones", () => {
    const custom = op("halftone", "generative", [{ name: "value", type: "number", default: 0 }]);
    expect(groupByPanel([custom, exposure]).map((group) => group.panel)).toEqual([
      "light",
      "generative",
    ]);
  });
});

describe("param to control mapping", () => {
  test("numbers and integers are sliders, booleans checkboxes, enums selects", () => {
    expect(controlKind({ name: "a", type: "number", default: 0 })).toBe("slider");
    expect(controlKind({ name: "a", type: "integer", default: 0 })).toBe("slider");
    expect(controlKind({ name: "a", type: "boolean", default: false })).toBe("checkbox");
    expect(controlKind({ name: "a", type: "enum", values: ["x", "y"], default: "x" })).toBe(
      "select",
    );
  });

  test("curves and valueless enums get no generated control", () => {
    expect(controlKind({ name: "a", type: "curve", default: null })).toBe("unsupported");
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

  test("the readout carries the unit and the step's precision", () => {
    expect(formatValue(1.234, exposure.params[0])).toBe("1.23 EV");
    expect(formatValue(-42.4, whiteBalance.params[0])).toBe("-42");
  });

  test("dragging snaps to the step and clamps to the range", () => {
    const range = sliderRange(exposure.params[0]);
    expect(quantize(1.23456, range)).toBe(1.23);
    expect(quantize(9, range)).toBe(5);
    expect(quantize(-9, range)).toBe(-5);
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

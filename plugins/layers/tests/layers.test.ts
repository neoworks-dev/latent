import { describe, expect, test } from "bun:test";
import type { Op, OpDefinition } from "@latent/protocol";
import {
  dropIndex,
  duplicateOp,
  layerRows,
  maskSummary,
  opacityOf,
  paramSummary,
  removeOp,
  reorderByDisplay,
  soloed,
  stackIndexOf,
} from "../src/layers";

function op(id: string, name = "exposure", params: Record<string, unknown> = {}): Op {
  return { id, op: name, params, enabled: true };
}

const stack = [op("op1"), op("op2", "contrast"), op("op3", "clarity")];

const exposure: OpDefinition = {
  name: "exposure",
  panel: "light",
  label: "Exposure",
  params: [{ name: "value", label: "Exposure", type: "number", default: 0, unit: "EV" }],
};

describe("the stack as a layer list", () => {
  test("the list is the stack upside down: the last op applied is the top row", () => {
    expect(layerRows(stack).map((row) => row.op.id)).toEqual(["op3", "op2", "op1"]);
    expect(layerRows(stack).map((row) => row.index)).toEqual([2, 1, 0]);
    expect(stackIndexOf(3, 0)).toBe(2);
    expect(layerRows([])).toEqual([]);
  });

  test("dragging a row moves the op inside the stack, not inside the view", () => {
    // Top row (op3) dropped on the bottom row: it becomes the first op applied.
    expect(reorderByDisplay(stack, 0, 2).map((entry) => entry.id)).toEqual(["op3", "op1", "op2"]);
    // Bottom row up one: op1 moves above op2 in the stack.
    expect(reorderByDisplay(stack, 2, 1).map((entry) => entry.id)).toEqual(["op2", "op1", "op3"]);
    expect(reorderByDisplay(stack, 1, 1)).toBe(stack);
  });

  test("the drop target is the row whose middle the pointer has passed", () => {
    const bounds = [
      { top: 0, bottom: 20 },
      { top: 20, bottom: 40 },
      { top: 40, bottom: 60 },
    ];
    expect(dropIndex(bounds, 5)).toBe(0);
    expect(dropIndex(bounds, 25)).toBe(1);
    expect(dropIndex(bounds, 39)).toBe(2);
    // Below the list: the last row.
    expect(dropIndex(bounds, 500)).toBe(2);
  });

  test("a duplicate sits above its original and takes an id of its own", () => {
    const masked: Op = {
      ...op("op1"),
      opacity: 40,
      mask: { components: [{ id: "m1", kind: "radial", mode: "add" }] },
    };
    const duplicated = duplicateOp([masked, op("op2")], "op1");
    expect(duplicated.map((entry) => entry.id)).toEqual(["op1", "op1-copy", "op2"]);
    expect(duplicated[1]?.opacity).toBe(40);
    // A deep copy: editing the copy's mask must not reach into the original's.
    expect(duplicated[1]?.mask).not.toBe(masked.mask);
    expect(duplicateOp(duplicated, "op1").map((entry) => entry.id)).toEqual([
      "op1",
      "op1-copy2",
      "op1-copy",
      "op2",
    ]);
    expect(duplicateOp(stack, "nope")).toBe(stack);
  });

  test("delete takes one row out and leaves the order of the rest", () => {
    expect(removeOp(stack, "op2").map((entry) => entry.id)).toEqual(["op1", "op3"]);
  });

  test("solo turns everything else off, and a second solo turns everything back on", () => {
    const solo = soloed(stack, "op2");
    expect(solo.map((entry) => entry.enabled)).toEqual([false, true, false]);
    expect(soloed(solo, "op2").map((entry) => entry.enabled)).toEqual([true, true, true]);
  });

  test("the row summarises the parameters that are not at their default", () => {
    // The unit comes along: "1.50" alone next to a mask summary reads as a count.
    expect(paramSummary(op("op1", "exposure", { value: 1.5 }), exposure)).toBe("1.50 EV");
    expect(paramSummary(op("op1", "exposure", { value: 2 }), exposure)).toBe("2 EV");
    expect(paramSummary(op("op1", "exposure", { value: 0 }), exposure)).toBe("default");
    expect(paramSummary(op("op1"), exposure)).toBe("");

    const twoParams: OpDefinition = {
      ...exposure,
      params: [
        { name: "amount", label: "Amount", type: "number", default: 0 },
        { name: "midpoint", label: "Midpoint", type: "number", default: 50 },
        { name: "roundness", label: "Roundness", type: "number", default: 0 },
      ],
    };
    const vignette = op("op1", "vignette", { amount: -30, midpoint: 20, roundness: 5 });
    // Two is a summary; three is the panel.
    expect(paramSummary(vignette, twoParams)).toBe("Amount -30 · Midpoint 20");
  });

  test("the mask summary names the kinds, and says nothing without a mask", () => {
    expect(maskSummary(op("op1"))).toBe("");
    expect(
      maskSummary({
        ...op("op1"),
        mask: {
          components: [
            { id: "m1", kind: "radial", mode: "add" },
            { id: "m2", kind: "brush", mode: "subtract" },
          ],
        },
      }),
    ).toBe("radial, brush");
  });

  test("an op without an opacity is a full-strength layer", () => {
    expect(opacityOf(op("op1"))).toBe(100);
    expect(opacityOf({ ...op("op1"), opacity: 0 })).toBe(0);
  });
});

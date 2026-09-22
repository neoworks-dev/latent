import { describe, expect, test } from "bun:test";
import type { HistoryStep, Op, OpDefinition } from "@latent/protocol";
import { historyRow, historyRows } from "../src/history";
import { panForPoint, visibleRect } from "../src/navigator";
import {
  applyPreset,
  builtinPresets,
  capturePreset,
  presetGroups,
  presetSize,
  readPresets,
  type Preset,
} from "../src/presets";

const ops: OpDefinition[] = [
  {
    name: "exposure",
    label: "Exposure",
    panel: "light",
    panelLabel: "Light",
    order: 1,
    stage: "tone",
    params: [
      { name: "value", label: "Exposure", type: "number", min: -5, max: 5, step: 0.01, unit: "EV" },
    ],
  },
  {
    name: "white_balance",
    label: "White Balance",
    panel: "color",
    panelLabel: "Color",
    order: 1,
    stage: "tone",
    params: [
      { name: "temperature", label: "Temperature", type: "number", min: -100, max: 100, step: 1 },
      { name: "tint", label: "Tint", type: "number", min: -150, max: 150, step: 1 },
    ],
  },
];

/** A step the engine would send, without repeating its optional fields at every call. */
function step(
  entry: Partial<HistoryStep> & { index: number; kind: HistoryStep["kind"] },
): HistoryStep {
  return entry;
}

describe("history rows", () => {
  test("a moved slider reads in the units of its own control", () => {
    const row = historyRow(
      step({
        index: 3,
        kind: "update",
        op: "exposure",
        changes: [{ param: "value", from: 0, to: 1 }],
      }),
      ops,
    );
    expect(row.title).toBe("Exposure");
    expect(row.detail).toBe("0.00 EV → +1.00 EV");
  });

  test("a multi-slider op is named by the parameter that moved", () => {
    const row = historyRow(
      step({
        index: 2,
        kind: "update",
        op: "white_balance",
        changes: [{ param: "tint", from: 0, to: -20 }],
      }),
      ops,
    );
    expect(row.title).toBe("Tint");
    expect(row.detail).toBe("0 → −20");
  });

  test("a commit that moved several says so instead of showing the first as the whole step", () => {
    const row = historyRow(
      step({
        index: 4,
        kind: "update",
        op: "white_balance",
        changes: [
          { param: "temperature", from: 0, to: 10 },
          { param: "tint", from: 0, to: 5 },
        ],
      }),
      ops,
    );
    expect(row.detail).toBe("0 → +10 · +1 more");
  });

  test("a commit that moved several ops unfolds into one row per op", () => {
    const row = historyRow(
      step({
        index: 6,
        kind: "batch",
        entries: [
          {
            kind: "update",
            op: "exposure",
            opId: "a",
            changes: [{ param: "value", from: 0, to: 1 }],
          },
          { kind: "add", op: "white_balance", opId: "b" },
        ],
      }),
      ops,
    );
    expect(row.title).toBe("Several edits");
    expect(row.detail).toBe("2 ops");
    // Each child reads exactly like the step that op would have been on its own, and names
    // the op `history.revertOp` puts back.
    expect(row.children).toEqual([
      { index: 6, title: "Exposure", detail: "0.00 EV → +1.00 EV", children: [], opId: "a" },
      { index: 6, title: "White Balance", detail: "added", children: [], opId: "b" },
    ]);
  });

  test("the name the caller gave a step wins over the one the diff would derive", () => {
    const row = historyRow(
      step({ index: 7, kind: "batch", label: "Golden hour applied", entries: [] }),
      ops,
    );
    expect(row.title).toBe("Golden hour applied");
    // And on a step about one op, where the derived title would have been right anyway.
    const single = historyRow(
      step({ index: 8, kind: "add", op: "exposure", label: "Settings pasted" }),
      ops,
    );
    expect(single.title).toBe("Settings pasted");
    expect(single.detail).toBe("added");
  });

  test("the steps that are not a value each say what they are", () => {
    expect(historyRow(step({ index: 0, kind: "initial" }), ops)).toMatchObject({
      title: "Opened",
      detail: "",
    });
    expect(historyRow(step({ index: 1, kind: "add", op: "exposure" }), ops).detail).toBe("added");
    expect(historyRow(step({ index: 2, kind: "remove", op: "exposure" }), ops).detail).toBe(
      "removed",
    );
    expect(historyRow(step({ index: 3, kind: "mask", op: "exposure" }), ops).detail).toBe(
      "mask changed",
    );
    expect(historyRow(step({ index: 4, kind: "reorder" }), ops).title).toBe("Reordered");
  });

  test("a curve, whose values no row can print, still reports that it moved", () => {
    const row = historyRow(
      step({ index: 5, kind: "update", op: "tone_curve", changes: [{ param: "rgb" }] }),
      ops,
    );
    expect(row.detail).toBe("changed");
    // No description for the op: the engine's own name is better than an empty row.
    expect(row.title).toBe("tone_curve");
  });

  test("the list is newest first, which is the order it is read in", () => {
    const rows = historyRows(
      [step({ index: 0, kind: "initial" }), step({ index: 1, kind: "add", op: "exposure" })],
      ops,
    );
    expect(rows.map((row) => row.index)).toEqual([1, 0]);
  });
});

describe("presets", () => {
  test("every preset that ships writes something, under a heading, with its own id", () => {
    const ids = new Set<string>();
    for (const preset of builtinPresets) {
      expect(presetSize(preset)).toBeGreaterThan(0);
      expect(preset.builtin).toBe(true);
      expect(preset.group).toBeTruthy();
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
    }
  });

  // A shipped preset writing `saturation` after `color_grading` would have its grade
  // stripped: the renderer runs two ops of one stage in stack order, and applyPreset appends
  // in the order the keys are declared.
  test("a shipped preset declares its ops in pipeline order", () => {
    const pipeline = [
      "white_balance",
      "exposure",
      "contrast",
      "highlights",
      "shadows",
      "whites",
      "blacks",
      "tone_curve",
      "vibrance",
      "saturation",
      "color_mixer",
      "color_grading",
      "texture",
      "clarity",
      "dehaze",
      "vignette",
      "grain",
      "sharpening",
      "noise_reduction",
      "color_noise_reduction",
    ];
    for (const preset of builtinPresets) {
      const order = Object.keys(preset.ops).map((op) => pipeline.indexOf(op));
      expect(order).not.toContain(-1);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  test("the panel's rows are the shipped groups in order, then the user's", () => {
    const mine: Preset = { id: "user:1", label: "Mine", ops: { exposure: { value: 1 } } };
    const groups = presetGroups([mine]);
    expect(groups[0].label).toBe("Essentials");
    expect(groups.at(-1)).toEqual({ label: "Yours", presets: [mine] });
    // Every shipped preset lands under exactly one heading.
    const counted = groups.reduce((total, group) => total + group.presets.length, 0);
    expect(counted).toBe(builtinPresets.length + 1);
  });

  test("applying writes the sliders the photo has and appends the ones it does not", () => {
    const preset: Preset = {
      id: "p",
      label: "P",
      ops: { exposure: { value: 0.5 }, clarity: { value: 30 } },
    };
    const stack: Op[] = [
      { id: "a", op: "exposure", params: { value: 2 }, enabled: false },
      { id: "b", op: "crop", params: { angle: 3 }, enabled: true },
      // Somebody's layer: a global preset has no business overwriting a masked op.
      { id: "c", op: "clarity", params: { value: 80 }, enabled: true, mask: { components: [] } },
    ];
    const next = applyPreset(preset, stack);
    expect(next[0]).toEqual({ id: "a", op: "exposure", params: { value: 0.5 }, enabled: true });
    expect(next[1]).toBe(stack[1]);
    expect(next[2]).toBe(stack[2]);
    // An empty id is the engine's cue to mint one.
    expect(next[3]).toEqual({ id: "", op: "clarity", params: { value: 30 }, enabled: true });
  });

  test("capturing takes the photo's values and leaves what does not travel", () => {
    const stack: Op[] = [
      { id: "a", op: "exposure", params: { value: 0.7 }, enabled: true },
      { id: "b", op: "contrast", params: { value: 20 }, enabled: false },
      { id: "c", op: "clarity", params: { value: 30 }, enabled: true, mask: { components: [] } },
      { id: "d", op: "crop", params: { angle: 3 }, enabled: true },
      { id: "e", op: "tone_curve", params: { rgb: [0, 1] }, enabled: true },
      {
        id: "f",
        op: "tone_curve",
        params: {
          red: [
            { x: 0, y: 0.1 },
            { x: 1, y: 1 },
          ],
        },
        enabled: true,
      },
    ];
    const preset = capturePreset("Mine", stack, "user:1");
    // The disabled op, the masked one and the crop are all left behind; `[0, 1]` is not a
    // curve the engine would read, so that op contributes nothing and is dropped, while the
    // control points of a real one travel.
    expect(preset.ops).toEqual({
      exposure: { value: 0.7 },
      tone_curve: {
        red: [
          { x: 0, y: 0.1 },
          { x: 1, y: 1 },
        ],
      },
    });
    expect(preset.label).toBe("Mine");
  });

  test("a storage entry that is not a preset list is ignored rather than drawn", () => {
    expect(readPresets(null)).toEqual([]);
    expect(readPresets("{oops")).toEqual([]);
    expect(readPresets('{"id":"x"}')).toEqual([]);
    expect(readPresets('[{"id":"x"},{"id":"y","label":"Y","ops":{}}]')).toHaveLength(1);
  });
});

describe("the navigator's box", () => {
  test("fitted, the whole photo is in view", () => {
    expect(visibleRect({ scale: 1, centerX: 0.5, centerY: 0.5, fit: true })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  test("zoomed, it is the part around the centre, held inside the photo", () => {
    const middle = visibleRect({ scale: 4, centerX: 0.5, centerY: 0.5, fit: false });
    expect(middle).toEqual({ x: 0.375, y: 0.375, width: 0.25, height: 0.25 });
    // Panned into the corner: the box stops at the edge rather than hanging off it.
    const corner = visibleRect({ scale: 4, centerX: 0, centerY: 1, fit: false });
    expect(corner.x).toBe(0);
    expect(corner.y).toBe(0.75);
  });

  test("aiming at a point moves the picture against the pointer", () => {
    const pan = panForPoint(0.75, 0.5, { centerX: 0.5, centerY: 0.5 }, 1000, 800);
    expect(pan.dx).toBe(-250);
    expect(pan.dy).toBeCloseTo(0);
  });
});

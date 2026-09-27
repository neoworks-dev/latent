import { describe, expect, test } from "bun:test";
import type { HistoryStep, Op, OpDefinition } from "@latent/protocol";
import { ancestorsOf, graphWidth, historyGraph, historyRow, historyRows } from "../src/history";
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
      {
        name: "value",
        label: "Exposure",
        type: "number",
        min: -5,
        max: 5,
        step: 0.01,
        unit: "EV",
        default: 0,
      },
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
      {
        name: "temperature",
        label: "Temperature",
        type: "number",
        min: -100,
        max: 100,
        step: 1,
        default: 0,
      },
      { name: "tint", label: "Tint", type: "number", min: -150, max: 150, step: 1, default: 0 },
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

  test("an op arriving or leaving says where its slider went, from or to the default", () => {
    const added = historyRow(
      step({ index: 1, kind: "add", op: "exposure", changes: [{ param: "value", to: 1 }] }),
      ops,
    );
    expect(added.detail).toBe("0.00 EV → +1.00 EV");
    const removed = historyRow(
      step({ index: 2, kind: "remove", op: "exposure", changes: [{ param: "value", from: 1 }] }),
      ops,
    );
    expect(removed.detail).toBe("+1.00 EV → 0.00 EV");
    // Added at its default: nothing moved, so there is no pair of values to show.
    const idle = historyRow(
      step({ index: 3, kind: "add", op: "exposure", changes: [{ param: "value", to: 0 }] }),
      ops,
    );
    expect(idle.detail).toBe("added");
  });

  test("a mask step names the component and the property that moved", () => {
    const row = historyRow(
      step({
        index: 5,
        kind: "mask",
        op: "group",
        changes: [
          { param: "radial1.feather", from: 0, to: 40 },
          { param: "brush1", to: "brush" },
        ],
      }),
      ops,
    );
    expect(row.title).toBe("Mask");
    expect(row.detail).toBe("Radial 1 feather 0 → 40 · +1 more");
    const added = historyRow(
      step({ index: 6, kind: "mask", op: "group", changes: [{ param: "sky1", to: "sky" }] }),
      ops,
    );
    expect(added.detail).toBe("Sky 1 added");
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

  test("a merge step is named after the branch it brought in", () => {
    const row = historyRow(
      step({
        index: 4,
        kind: "update",
        op: "exposure",
        parent: 3,
        mergedFrom: 2,
        changes: [{ param: "value", from: 0, to: 1.5 }],
      }),
      ops,
    );
    expect(row.title).toBe("Merged step 2");
    expect(row.detail).toBe("0.00 EV → +1.50 EV");

    // With the whole list at hand, it is called after the step it brought in.
    const rows = historyRows(
      [
        step({ index: 0, kind: "initial" }),
        step({ index: 1, kind: "batch", parent: 0, label: "Punch applied" }),
        step({ index: 2, kind: "update", op: "exposure", parent: 0 }),
        step({ index: 3, kind: "batch", parent: 2, mergedFrom: 1 }),
      ],
      ops,
    );
    expect(rows[0]?.title).toBe("Merged “Punch applied”");
  });
});

describe("the history graph", () => {
  // 0 ─ 1 ─ 2          a step undone and edited past: 3 branches off 1,
  //      └─ 3 ─ 4      and 4 merges 2 back in.
  const tree: HistoryStep[] = [
    step({ index: 0, kind: "initial" }),
    step({ index: 1, kind: "add", parent: 0 }),
    step({ index: 2, kind: "update", parent: 1 }),
    step({ index: 3, kind: "update", parent: 1 }),
    step({ index: 4, kind: "update", parent: 3, mergedFrom: 2 }),
  ];

  test("a line is one lane, straight down", () => {
    const rows = historyGraph(tree.slice(0, 3));
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows[0]?.top).toEqual([]);
    expect(rows[0]?.bottom).toEqual([{ from: 0, to: 0 }]);
    expect(rows[2]?.bottom).toEqual([]);
    expect(graphWidth(rows)).toBe(1);
  });

  test("a branch takes a lane of its own and joins where it left", () => {
    const rows = historyGraph(tree.slice(0, 4));
    expect(rows.map((row) => [row.index, row.lane])).toEqual([
      [3, 0],
      [2, 1],
      [1, 0],
      [0, 0],
    ]);
    // Step 1 is where both lanes were waiting: the second one bends into it.
    expect(rows[2]?.top).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 0 },
    ]);
    expect(graphWidth(rows)).toBe(2);
  });

  test("a merge opens a lane down to the branch it brought in", () => {
    const rows = historyGraph(tree);
    const merge = rows[0];
    expect(merge?.index).toBe(4);
    expect(merge?.bottom).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 1 },
    ]);
    // The branch tip takes the lane the merge opened for it, not a new one.
    expect(rows.find((row) => row.index === 2)?.lane).toBe(1);
  });

  test("what a step is made of follows both parents of a merge", () => {
    const byIndex = (left: number, right: number): number => left - right;
    expect([...ancestorsOf(tree, 4)].sort(byIndex)).toEqual([0, 1, 2, 3, 4]);
    expect([...ancestorsOf(tree, 3)].sort(byIndex)).toEqual([0, 1, 3]);
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

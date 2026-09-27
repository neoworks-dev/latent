// A stand-in for `latentd` so the UI can be developed and screenshotted without a GPU,
// LibRaw or a built engine. It speaks the real protocol: JSON-RPC 2.0 on text frames,
// LFRM binary frames for pixels, `stack.changed` notifications to every connected
// client. The image is synthetic and the op maths is crude on purpose — this proves the
// round trip, not the renderer.
//
//   bun run mock-engine [--port 0]
import type {
  EngineHelloResult,
  Histogram,
  HistoryListResult,
  HistoryStep,
  Mask,
  MaskComponent,
  NotificationName,
  Op,
  OpDefinition,
  OpParamDisplay,
  OpParamSpec,
  OpsDescribeResult,
  PhotoFlag,
  PhotoOpenResult,
  PythonRunResult,
  StackChangedParams,
  OpAddResult,
  StackGetResult,
} from "@latent/protocol";
import { FRAME_HEADER_BYTES } from "@latent/protocol";
import type { ServerWebSocket } from "bun";
import { applyGeometry, contentRectOf, type ContentRect, geometryOf } from "./mock-crop";
import { MockCatalog, scanRawFiles } from "./mock-catalog";
import { applyLut, curveTable } from "./mock-curve";
import {
  annotateStale,
  generativeDefinitions,
  generativeStatus,
  inputHash,
  insideResult,
  isGenerativeOp,
  resultRect,
  resultTint,
} from "./mock-generative";
import {
  applyViewport,
  combineMask,
  FIT,
  geometryMap,
  type MockGeometryMap,
  type MockInsets,
  type MockViewport,
  NO_INSETS,
  coverageOf,
  isAiKind,
  maskFrame,
  mergeEngineOwned,
  placeholderRegion,
  seedComponentStates,
  seedState,
  type BrushSegment,
  type ImageSampler,
} from "./mock-masks";
import { MockExport } from "./mock-export";
import { MockMerge } from "./mock-merge";

/** The layer half of `op.add` / `op.update`: a whole mask (or `null`) and an opacity. */
interface LayerWrite {
  mask?: Mask | null;
  opacity?: number;
}

type Tint = NonNullable<OpParamDisplay["tint"]>;

interface SliderOptions {
  unit?: string;
  default?: number;
  kind?: OpParamDisplay["kind"];
  tint?: Tint;
}

function slider(
  name: string,
  label: string,
  min: number,
  max: number,
  step: number,
  options: SliderOptions = {},
): OpParamSpec {
  const display: OpParamDisplay = { kind: options.kind ?? "slider" };
  if (options.tint) display.tint = options.tint;
  const spec: OpParamSpec = {
    name,
    label,
    type: "number",
    min,
    max,
    step,
    default: options.default ?? 0,
    display,
  };
  if (options.unit) spec.unit = options.unit;
  return spec;
}

/** Lightroom's bipolar amount: -100..100, neutral at zero. */
function bipolar(name: string, label: string, options: SliderOptions = {}): OpParamSpec {
  return slider(name, label, -100, 100, 1, options);
}

/** Lightroom's one-sided sub-slider: 0..100, with its own neutral value. */
function unipolar(
  name: string,
  label: string,
  defaultValue: number,
  options: SliderOptions = {},
): OpParamSpec {
  return slider(name, label, 0, 100, 1, { ...options, default: defaultValue });
}

function toggle(name: string, label: string): OpParamSpec {
  return { name, label, type: "boolean", default: false, display: { kind: "toggle" } };
}

/** A curve param: the control points of one channel, drawn by the curve editor. */
function curve(name: string, label: string): OpParamSpec {
  return { name, label, type: "curve", default: [], display: { kind: "curve" } };
}

function mixerBand(band: string, label: string): OpParamSpec[] {
  return [
    bipolar(`${band}Hue`, `${label} hue`, { kind: "hsl", tint: "hue" }),
    bipolar(`${band}Saturation`, `${label} saturation`, { kind: "hsl", tint: "saturation" }),
    bipolar(`${band}Luminance`, `${label} luminance`, { kind: "hsl" }),
  ];
}

function gradingRange(range: string, label: string): OpParamSpec[] {
  return [
    slider(`${range}Hue`, `${label} hue`, 0, 360, 1, { unit: "°", tint: "hue" }),
    unipolar(`${range}Saturation`, `${label} saturation`, 0, { tint: "saturation" }),
    bipolar(`${range}Luminance`, `${label} luminance`),
  ];
}

function define(
  name: string,
  panel: OpDefinition["panel"],
  section: OpDefinition["section"],
  order: number,
  label: string,
  params: OpParamSpec[],
): OpDefinition {
  // Every develop op takes a mask and an opacity; geometry ops move the whole frame and
  // cannot (PROMPT.md §3.7), which is exactly what `maskable` tells the UI.
  return { name, panel, section, order, label, params, maskable: panel !== "geometry" };
}

// `section` and `order` mirror the engine's registry (engine/src/ops/registry.cpp), which
// mirrors Lightroom's Edit panel: a generated panel built against the mock lays out the
// way it will against latentd. The maths below is crude, but this list is not — it is the
// contract the panel plugin is written against.
export const opDefinitions: OpDefinition[] = [
  define("exposure", "light", "Light", 1, "Exposure", [
    slider("value", "Exposure", -5, 5, 0.01, { unit: "EV" }),
  ]),
  define("contrast", "light", "Light", 2, "Contrast", [bipolar("value", "Contrast")]),
  define("highlights", "light", "Light", 3, "Highlights", [bipolar("value", "Highlights")]),
  define("shadows", "light", "Light", 4, "Shadows", [bipolar("value", "Shadows")]),
  define("whites", "light", "Light", 5, "Whites", [bipolar("value", "Whites")]),
  define("blacks", "light", "Light", 6, "Blacks", [bipolar("value", "Blacks")]),
  define("tone_curve", "light", "Light", 7, "Curve", [
    bipolar("highlights", "Highlights"),
    bipolar("lights", "Lights"),
    bipolar("darks", "Darks"),
    bipolar("shadows", "Shadows"),
    unipolar("shadowSplit", "Shadow split", 25),
    unipolar("midtoneSplit", "Midtone split", 50),
    unipolar("highlightSplit", "Highlight split", 75),
    curve("rgb", "RGB channels"),
    curve("red", "Red channel"),
    curve("green", "Green channel"),
    curve("blue", "Blue channel"),
  ]),

  define("white_balance", "color", "Color", 1, "White Balance", [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      default: "relative",
      values: ["relative", "kelvin"],
    },
    bipolar("temperature", "Temperature", { tint: "temperature" }),
    slider("kelvin", "Temperature", 2000, 50000, 50, {
      unit: "K",
      default: 5500,
      kind: "kelvin",
      tint: "temperature",
    }),
    slider("tint", "Tint", -150, 150, 1, { tint: "tint" }),
  ]),
  define("vibrance", "color", "Color", 2, "Vibrance", [
    bipolar("value", "Vibrance", { tint: "saturation" }),
  ]),
  define("saturation", "color", "Color", 3, "Saturation", [
    bipolar("value", "Saturation", { tint: "saturation" }),
  ]),
  define("color_mixer", "color", "Color", 4, "Color Mixer", [
    ...mixerBand("red", "Red"),
    ...mixerBand("orange", "Orange"),
    ...mixerBand("yellow", "Yellow"),
    ...mixerBand("green", "Green"),
    ...mixerBand("aqua", "Aqua"),
    ...mixerBand("blue", "Blue"),
    ...mixerBand("purple", "Purple"),
    ...mixerBand("magenta", "Magenta"),
  ]),
  define("color_grading", "color", "Color", 5, "Color Grading", [
    ...gradingRange("shadow", "Shadows"),
    ...gradingRange("midtone", "Midtones"),
    ...gradingRange("highlight", "Highlights"),
    ...gradingRange("global", "Global"),
    unipolar("blending", "Blending", 50),
    bipolar("balance", "Balance"),
  ]),

  define("texture", "effects", "Effects", 1, "Texture", [bipolar("value", "Texture")]),
  define("clarity", "effects", "Effects", 2, "Clarity", [bipolar("value", "Clarity")]),
  define("dehaze", "effects", "Effects", 3, "Dehaze", [bipolar("value", "Dehaze")]),
  define("vignette", "effects", "Effects", 4, "Vignette", [
    bipolar("amount", "Amount"),
    unipolar("midpoint", "Midpoint", 50),
    unipolar("feather", "Feather", 50),
    bipolar("roundness", "Roundness"),
    unipolar("highlights", "Highlights", 0),
  ]),
  define("grain", "effects", "Effects", 5, "Grain", [
    unipolar("amount", "Amount", 0),
    unipolar("size", "Size", 25),
    unipolar("roughness", "Roughness", 50),
  ]),

  define("sharpening", "detail", "Detail", 1, "Sharpening", [
    slider("amount", "Amount", 0, 150, 1),
    slider("radius", "Radius", 0.5, 3, 0.1, { unit: "px", default: 1 }),
    unipolar("detail", "Detail", 25),
    unipolar("masking", "Masking", 0),
  ]),
  define("noise_reduction", "detail", "Detail", 2, "Noise Reduction", [
    unipolar("luminance", "Luminance", 0),
    unipolar("detail", "Detail", 50),
    unipolar("contrast", "Contrast", 0),
  ]),
  define("color_noise_reduction", "detail", "Detail", 3, "Color Noise Reduction", [
    unipolar("amount", "Amount", 0),
    unipolar("detail", "Detail", 50),
    unipolar("smoothness", "Smoothness", 50),
  ]),

  define("chromatic_aberration", "optics", "Optics", 1, "Remove Chromatic Aberration", [
    toggle("enabled", "Remove chromatic aberration"),
  ]),
  define("lens_correction", "optics", "Optics", 2, "Lens Corrections", [
    bipolar("distortion", "Distortion"),
    bipolar("vignetting", "Vignetting"),
  ]),
  define("defringe", "optics", "Optics", 3, "Defringe", [
    unipolar("purpleAmount", "Purple amount", 0),
    unipolar("purpleHueLow", "Purple hue low", 30),
    unipolar("purpleHueHigh", "Purple hue high", 70),
    unipolar("greenAmount", "Green amount", 0),
    unipolar("greenHueLow", "Green hue low", 40),
    unipolar("greenHueHigh", "Green hue high", 60),
  ]),

  define("crop", "geometry", "Geometry", 1, "Crop", [
    slider("left", "Left", 0, 1, 0.001),
    slider("top", "Top", 0, 1, 0.001),
    slider("right", "Right", 0, 1, 0.001, { default: 1 }),
    slider("bottom", "Bottom", 0, 1, 0.001, { default: 1 }),
    slider("angle", "Straighten", -45, 45, 0.1, { unit: "°" }),
  ]),
  define("rotate", "geometry", "Geometry", 2, "Rotate", [
    { ...slider("value", "Rotate", 0, 270, 90, { unit: "°" }), type: "integer" },
  ]),
  define("flip", "geometry", "Geometry", 3, "Flip", [
    toggle("horizontal", "Flip horizontal"),
    toggle("vertical", "Flip vertical"),
  ]),
  define("transform", "geometry", "Geometry", 4, "Transform", [
    bipolar("vertical", "Vertical"),
    bipolar("horizontal", "Horizontal"),
    slider("rotate", "Rotate", -10, 10, 0.1, { unit: "°" }),
    bipolar("aspect", "Aspect"),
    slider("scale", "Scale", 50, 150, 0.5, { unit: "%", default: 100 }),
    bipolar("offsetX", "X offset"),
    bipolar("offsetY", "Y offset"),
  ]),
  ...generativeDefinitions,
];

/** Every op of a stack, group children included: an id is unique across the photo. */
function flattenOps(stack: Op[]): Op[] {
  return stack.flatMap((op) => [op, ...(op.ops ?? [])]);
}

/**
 * One rewrite over every op, children included. `inGroup` says the op is under a layer's
 * mask, which is what decides whether a write may carry a mask or an opacity of its own.
 */
function mapOps(stack: Op[], rewrite: (op: Op, inGroup: boolean) => Op): Op[] {
  return stack.map((op) => {
    const mapped = rewrite(op, false);
    if (!mapped.ops) return mapped;
    return { ...mapped, ops: mapped.ops.map((child) => rewrite(child, true)) };
  });
}

/** Only a scalar can be printed in a history row; a curve's point list is left off. */
function scalarOr(value: unknown): number | string | boolean | undefined {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

/**
 * What one commit changed, the engine's `describe_step` (engine/src/ops/history_diff.cpp)
 * in the mock's terms: the first difference in stack order, because one commit is one user
 * action.
 */
function describeStep(before: Op[], after: Op[]): Omit<HistoryStep, "index"> {
  const old = flattenOps(before);
  const next = flattenOps(after);
  const added = next.find((op) => !old.some((entry) => entry.id === op.id));
  if (added) return { kind: "add", op: added.op, opId: added.id };
  const removed = old.find((op) => !next.some((entry) => entry.id === op.id));
  if (removed) return { kind: "remove", op: removed.op, opId: removed.id };
  for (const op of next) {
    const was = old.find((entry) => entry.id === op.id);
    if (!was) continue;
    if (JSON.stringify(was.mask ?? null) !== JSON.stringify(op.mask ?? null)) {
      return { kind: "mask", op: op.op, opId: op.id };
    }
    const keys = [...new Set([...Object.keys(was.params), ...Object.keys(op.params)])];
    const changes = keys
      .filter((key) => JSON.stringify(was.params[key]) !== JSON.stringify(op.params[key]))
      .map((param) => ({
        param,
        from: scalarOr(was.params[param]),
        to: scalarOr(op.params[param]),
      }));
    if (was.enabled !== op.enabled) {
      changes.push({ param: "enabled", from: was.enabled, to: op.enabled });
    }
    if ((was.opacity ?? 100) !== (op.opacity ?? 100)) {
      changes.push({ param: "opacity", from: was.opacity ?? 100, to: op.opacity ?? 100 });
    }
    if (changes.length > 0) return { kind: "update", op: op.op, opId: op.id, changes };
  }
  return { kind: "reorder" };
}

/** One step of the history tree, as the engine's HistoryNode. */
interface HistoryNode {
  stack: Op[];
  parent?: number;
  mergedFrom?: number;
  redoChild?: number;
}

/**
 * The op-stack with the engine's history semantics: a tree of snapshots plus a cursor,
 * never a pop. A transient mutation (slider being dragged) changes the live stack without
 * snapshotting; the next committed mutation adds a child of the cursor, so undo lands
 * before the drag and an edit after an undo starts a branch.
 */
export class PhotoState {
  stack: Op[] = [];
  revision = 0;
  private history: HistoryNode[] = [{ stack: [] }];
  private cursor = 0;
  private nextOpId = 1;

  get canUndo(): boolean {
    return this.history[this.cursor]?.parent !== undefined;
  }

  get canRedo(): boolean {
    return this.history[this.cursor]?.redoChild !== undefined;
  }

  snapshot(): StackGetResult {
    return {
      // `stale` is derived from the ops under each generative one, so it is added on the
      // way out and never stored, exactly as the engine does it.
      stack: annotateStale(this.stack),
      revision: this.revision,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      // Undo steps, not writes: a drag moves the cursor once however many transient
      // mutations it made, which is what the Stack readout shows.
      historyIndex: this.cursor,
      historyDepth: this.history.length,
    };
  }

  /** The engine-owned fields a finished generative job writes onto its op. */
  finishGenerative(opId: string, fields: Partial<Op>): void {
    this.commit(
      this.stack.map((entry) => (entry.id === opId ? { ...entry, ...fields } : entry)),
      false,
    );
  }

  addOp(
    op: string,
    params: Record<string, unknown>,
    index?: number,
    transient = false,
    layer: LayerWrite = {},
    parentId?: string,
  ): Op {
    const entry: Op = { id: `op${this.nextOpId++}`, op, params: { ...params }, enabled: true };
    // A group is a layer: no params of its own, and always a list, empty included.
    if (op === "group") entry.ops = [];
    if (layer.mask) entry.mask = { components: layer.mask.components.map(seedState) };
    if (layer.opacity !== undefined) entry.opacity = layer.opacity;
    // Into a layer: the child shares that group's mask, so it carries neither mask nor
    // opacity of its own (protocol OpAddParams.parentId).
    if (parentId !== undefined) {
      const parent = this.stack.find((candidate) => candidate.id === parentId);
      if (!parent?.ops) throw new Error(`op ${parentId} is not a group`);
      delete entry.mask;
      delete entry.opacity;
      const children = [...parent.ops];
      children.splice(index ?? children.length, 0, entry);
      this.commit(
        this.stack.map((candidate) =>
          candidate.id === parentId ? { ...candidate, ops: children } : candidate,
        ),
        transient,
      );
      return entry;
    }
    const next = [...this.stack];
    next.splice(index ?? next.length, 0, entry);
    this.commit(next, transient);
    return entry;
  }

  /**
   * `params` merges, `mask` replaces whole (and `null` clears it), `opacity` and `enabled`
   * are set when given — the contract of `op.update`. Whatever only the engine knows about
   * a component it already has — its state, its strokes, its raster — is carried forward.
   */
  updateOp(
    opId: string,
    params: Record<string, unknown>,
    enabled: boolean | undefined,
    transient: boolean,
    layer: LayerWrite = {},
  ): void {
    const next = mapOps(this.stack, (entry, inGroup) => {
      if (entry.id !== opId) return entry;
      const updated: Op = {
        ...entry,
        params: { ...entry.params, ...params },
        enabled: enabled ?? entry.enabled,
      };
      // Inside a group the mask and the opacity belong to the group, so a write that
      // carries either is ignored, the way the engine ignores it with a warning.
      if (inGroup) return updated;
      if (layer.opacity !== undefined) updated.opacity = layer.opacity;
      if (layer.mask === null) delete updated.mask;
      else if (layer.mask) updated.mask = layer.mask;
      return updated;
    });
    this.commit(mergeEngineOwned(this.stack, next), transient);
  }

  /** A layer goes with everything under it; a child goes from its layer. */
  removeOp(opId: string): void {
    const next = this.stack
      .filter((entry) => entry.id !== opId)
      .map((entry) => {
        if (!entry.ops) return entry;
        return { ...entry, ops: entry.ops.filter((child) => child.id !== opId) };
      });
    this.commit(next, false);
  }

  setStack(stack: Op[]): void {
    this.commit(seedComponentStates(stack), false);
  }

  /**
   * Rewrites one mask component in place. Strokes go through here transiently while the
   * pointer is down and once committed on release, so a stroke undoes in one step; the
   * engine-owned `state` changes of a detect job never snapshot at all.
   */
  updateComponent(
    opId: string,
    componentId: string,
    patch: (component: MaskComponent) => MaskComponent,
    transient: boolean,
  ): MaskComponent {
    const op = flattenOps(this.stack).find((entry) => entry.id === opId);
    const component = op?.mask?.components.find((entry) => entry.id === componentId);
    if (!op || !component) throw new Error(`unknown mask component ${componentId}`);
    const patched = patch(component);
    const next = mapOps(this.stack, (entry) => {
      if (entry.id !== opId || !entry.mask) return entry;
      const components = entry.mask.components.map((candidate) =>
        candidate.id === componentId ? patched : candidate,
      );
      return { ...entry, mask: { components } };
    });
    this.commit(next, transient);
    return patched;
  }

  component(opId: string, componentId: string): MaskComponent {
    const op = flattenOps(this.stack).find((entry) => entry.id === opId);
    const component = op?.mask?.components.find((entry) => entry.id === componentId);
    if (!component) throw new Error(`unknown mask component ${componentId}`);
    return component;
  }

  maskOf(opId: string): Mask {
    const op = flattenOps(this.stack).find((entry) => entry.id === opId);
    if (!op) throw new Error(`unknown opId ${opId}`);
    if (!op.mask) throw new Error(`op ${opId} has no mask`);
    return op.mask;
  }

  undo(): void {
    const node = this.history[this.cursor];
    if (node?.parent === undefined) return;
    const parent = this.history[node.parent];
    if (parent) parent.redoChild = this.cursor;
    this.moveCursor(node.parent);
  }

  /** The tree described: one row per step, oldest first, each against its parent. */
  historyList(): HistoryListResult {
    const entries = this.history.map((node, index) => {
      const previous = node.parent === undefined ? undefined : this.history[node.parent];
      const links = { parent: node.parent, mergedFrom: node.mergedFrom };
      if (!previous) return { index, kind: "initial" as const };
      return { ...describeStep(previous.stack, node.stack), ...links, index };
    });
    return { entries, index: this.cursor };
  }

  /**
   * Joins step `index` into the current one. The engine merges value by value; this mock
   * merges op by op — whatever the other branch added, changed or removed since the two
   * parted replaces ours, which is the engine's "merged-in wins" at a coarser grain.
   */
  merge(index: number): void {
    const theirs = this.history[index];
    if (!theirs || this.lineOf(this.cursor).has(index)) {
      throw new Error(`step ${index} is already in this one`);
    }
    const shared = this.lineOf(index);
    const baseIndex = Math.max(...[...this.lineOf(this.cursor)].filter((step) => shared.has(step)));
    const base = this.history[baseIndex];
    if (!base) throw new Error(`no common step for ${index}`);
    const same = (left: Op | undefined, right: Op | undefined): boolean =>
      JSON.stringify(left) === JSON.stringify(right);
    const find = (stack: Op[], id: string): Op | undefined =>
      stack.find((entry) => entry.id === id);
    const merged: Op[] = [];
    for (const ours of this.stack) {
      const theirOp = find(theirs.stack, ours.id);
      if (same(theirOp, find(base.stack, ours.id))) merged.push(ours);
      else if (theirOp) merged.push(theirOp);
    }
    const added = theirs.stack.filter(
      (entry) => !find(this.stack, entry.id) && !same(entry, find(base.stack, entry.id)),
    );
    this.revision += 1;
    this.append({ stack: [...merged, ...added], parent: this.cursor, mergedFrom: index });
  }

  /** A step and everything it is made of: parents and merged branches. */
  private lineOf(index: number): Set<number> {
    const found = new Set<number>();
    const pending = [index];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const node = this.history[next];
      if (!node || found.has(next)) continue;
      found.add(next);
      if (node.parent !== undefined) pending.push(node.parent);
      if (node.mergedFrom !== undefined) pending.push(node.mergedFrom);
    }
    return found;
  }

  /** Straight to one snapshot: clicking a row of the history list. */
  jump(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      throw new Error(`no history step ${index}`);
    }
    this.moveCursor(index);
  }

  redo(): void {
    const child = this.history[this.cursor]?.redoChild;
    if (child === undefined) return;
    this.moveCursor(child);
  }

  private moveCursor(cursor: number): void {
    const node = this.history[cursor];
    if (!node) return;
    this.cursor = cursor;
    this.stack = node.stack;
    this.revision += 1;
  }

  /** A new step under the cursor; the caller has already counted the revision. */
  private append(node: HistoryNode): void {
    const parent = node.parent === undefined ? undefined : this.history[node.parent];
    if (parent) parent.redoChild = this.history.length;
    this.history = [...this.history, node];
    this.cursor = this.history.length - 1;
    this.stack = node.stack;
  }

  private commit(stack: Op[], transient: boolean): void {
    this.stack = stack;
    this.revision += 1;
    if (transient) return;
    this.append({ stack, parent: this.cursor });
  }
}

function paramOf(stack: Op[], op: string, name: string, fallback: number): number {
  const entry = stack.find((candidate) => candidate.op === op && candidate.enabled);
  if (!entry) return fallback;
  const value = entry.params[name];
  if (typeof value !== "number") return fallback;
  return value;
}

/** Every parameter of one enabled op — what the curve needs, which is not one number. */
function paramsOf(stack: Op[], op: string): Record<string, unknown> {
  const entry = stack.find((candidate) => candidate.op === op && candidate.enabled);
  if (!entry) return {};
  return entry.params;
}

/**
 * The synthetic photo before any op: a smooth colour gradient with a grid. The frame
 * renderer and the luminance/colour mask kinds read the same function, so a mask built on
 * brightness lines up with the pixels the viewer is showing.
 */
export function baseColor(u: number, v: number, grid: number): [number, number, number] {
  return [0.14 + 0.3 * u + grid, 0.16 + 0.24 * (1 - v) + grid, 0.3 - 0.18 * u + 0.16 * v + grid];
}

/** The grid lines, in pixels of the frame the sampler is asked about. */
function gridAt(x: number, y: number): number {
  return x % 64 < 2 || y % 64 < 2 ? 0.18 : 0;
}

/** `baseColor` in the coordinates a mask rasteriser works in: 0..1 over the image. */
export function imageSampler(width: number, height: number): ImageSampler {
  return (u, v) => baseColor(u, v, gridAt(Math.floor(u * width), Math.floor(v * height)));
}

/**
 * A smooth colour gradient with a grid, with the ops applied crudely so a slider move is
 * visible. Returns an LFRM frame: 32-byte header (frames.md) followed by rgba8 pixels.
 */
export function renderFrame(
  width: number,
  height: number,
  seq: number,
  viewId: number,
  stack: Op[],
): ArrayBuffer {
  const exposure = paramOf(stack, "exposure", "value", 0);
  const contrast = paramOf(stack, "contrast", "value", 0);
  const temperature = paramOf(stack, "white_balance", "temperature", 0);
  const saturation = paramOf(stack, "saturation", "value", 0);
  const gain = Math.pow(2, exposure);
  const slope = 1 + contrast / 100;
  const warm = 1 + temperature / 300;
  const cool = 1 - temperature / 300;
  const vivid = 1 + saturation / 100;
  // The curve is the last of the tone stage, after the light sliders, as in the engine's
  // pipeline. Its tables are built once per frame, not once per pixel.
  const curve = curveTable(paramsOf(stack, "tone_curve"));
  // Generative results composite before the tone stage, so the develop settings apply to
  // them too — the same order the engine's PipelineStage::Generative gives them.
  const generative = stack.filter((op) => op.enabled && isGenerativeOp(op.op) && op.result);

  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + width * height * 4);
  const header = new DataView(buffer);
  header.setUint8(0, 0x4c); // L
  header.setUint8(1, 0x46); // F
  header.setUint8(2, 0x52); // R
  header.setUint8(3, 0x4d); // M
  header.setUint32(4, width, true);
  header.setUint32(8, height, true);
  header.setUint32(12, seq, true);
  header.setUint32(16, viewId, true);
  header.setUint32(20, 0, true);

  const pixels = new Uint8ClampedArray(buffer, FRAME_HEADER_BYTES);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const base = baseColor(u, v, gridAt(x, y));
      for (const op of generative) {
        if (!insideResult(op, u, v)) continue;
        const tint = resultTint(op);
        base[0] = 0.5 * tint[0];
        base[1] = 0.5 * tint[1];
        base[2] = 0.5 * tint[2];
      }
      let r = base[0] * warm;
      let g = base[1];
      let b = base[2] * cool;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * vivid;
      g = luma + (g - luma) * vivid;
      b = luma + (b - luma) * vivid;
      let toneR = 0.5 + (r * gain - 0.5) * slope;
      let toneG = 0.5 + (g * gain - 0.5) * slope;
      let toneB = 0.5 + (b * gain - 0.5) * slope;
      if (curve.active) {
        toneR = applyLut(curve.red, toneR);
        toneG = applyLut(curve.green, toneG);
        toneB = applyLut(curve.blue, toneB);
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = 255 * toneR;
      pixels[offset + 1] = 255 * toneG;
      pixels[offset + 2] = 255 * toneB;
      pixels[offset + 3] = 255;
    }
  }
  return buffer;
}

interface View {
  photoId: number;
  width: number;
  height: number;
  seq: number;
  /** Zoom and pan, sticky per view exactly as in the engine. */
  viewport: MockViewport;
  /** The client's floating panels, sticky in the same way. */
  insets: MockInsets;
}

interface RpcRequest {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface HandledCall {
  result: unknown;
  /** Photo whose stack changed, so the caller can publish `stack.changed`. */
  changed?: number;
  /** Binary frames the caller must send before the result (LTHM thumbnails). */
  frames?: ArrayBuffer[];
  /**
   * Notifications for the calling socket only, sent before the result — `python.output`
   * belongs to the client that asked for the run, not to every connected client.
   */
  notifications?: { method: NotificationName; params: unknown }[];
}

export type Broadcast = (method: NotificationName, params: unknown) => void;

interface Job {
  cancelled: boolean;
  finished: boolean;
}

/** Files a mock import registers per tick; a big directory takes visibly many ticks. */
const importChunk = 25;

/** There is no SQLite here, but engine.hello still has to name a catalog. */
const mockCatalogPath = "/tmp/latent-mock/catalog.db";

/**
 * LTHM tags its frame with a u32 photoId (protocol/frames.md). A larger id cannot be
 * labelled, so the request is refused rather than answered with a truncated frame.
 */
const maxThumbnailPhotoId = 0xffffffff;

/**
 * Long edge of a mask preview raster. The engine rasterises at the view's proxy size; a
 * mock rasterising in TS stays small and lets the overlay scale it.
 */
const maskPreviewMaxEdge = 512;

/**
 * The mask and opacity of an `op.add` / `op.update`. `mask: null` is a clear and has to be
 * told apart from an absent one, which leaves the mask alone.
 */
/**
 * The engine's histogram of a rendered frame: 256 bins a channel over the image rect, the
 * letterbox left out, with the rect clipped to the frame the way a zoomed view needs.
 */
export function histogramOf(
  frame: ArrayBuffer,
  width: number,
  height: number,
  content: ContentRect,
): Histogram {
  const pixels = new Uint8Array(frame, FRAME_HEADER_BYTES);
  const red = new Array<number>(256).fill(0);
  const green = new Array<number>(256).fill(0);
  const blue = new Array<number>(256).fill(0);
  const left = Math.max(0, Math.round(content[0]));
  const top = Math.max(0, Math.round(content[1]));
  const right = Math.min(width, Math.round(content[0] + content[2]));
  const bottom = Math.min(height, Math.round(content[1] + content[3]));
  let clippedLow = 0;
  let clippedHigh = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const texel = (y * width + x) * 4;
      const r = pixels[texel] ?? 0;
      const g = pixels[texel + 1] ?? 0;
      const b = pixels[texel + 2] ?? 0;
      red[r] = (red[r] ?? 0) + 1;
      green[g] = (green[g] ?? 0) + 1;
      blue[b] = (blue[b] ?? 0) + 1;
      const high = Math.max(r, g, b);
      if (high <= 1) clippedLow += 1;
      if (high >= 254) clippedHigh += 1;
    }
  }
  const total = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (total === 0) {
    return { bins: 256, r: red, g: green, b: blue, clippedShadowsPct: 0, clippedHighlightsPct: 0 };
  }
  return {
    bins: 256,
    r: red,
    g: green,
    b: blue,
    clippedShadowsPct: (100 * clippedLow) / total,
    clippedHighlightsPct: (100 * clippedHigh) / total,
  };
}

function layerWrite(params: Record<string, unknown>): LayerWrite {
  const write: LayerWrite = {};
  if (params.mask === null) write.mask = null;
  else if (params.mask) write.mask = params.mask as Mask;
  if (typeof params.opacity === "number") write.opacity = params.opacity;
  return write;
}

/** An id out of an untyped params bag, without stringifying whatever else arrived. */
function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new Error(`expected an id, got ${typeof value}`);
}

/** A prompt out of the same bag: anything that is not text is no prompt at all. */
function textOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

/** A stroke segment appended to a brush component — the engine owns the stroke list. */
function appendSegment(component: MaskComponent, segment: BrushSegment): MaskComponent {
  const previous = component.params?.strokeData;
  const strokeData = Array.isArray(previous) ? [...previous, segment] : [segment];
  return {
    ...component,
    state: "ready",
    params: {
      ...component.params,
      // The stroke list lives in the op so a snapshot captures it; `strokes` is the path
      // the engine mirrors it to.
      strokes: `brush/${component.id}.bin`,
      strokeData,
    },
  };
}

function finishState(cancelled: boolean, failed: boolean): "done" | "cancelled" | "error" {
  if (cancelled) return "cancelled";
  if (failed) return "error";
  return "done";
}

/** What a detect job leaves behind: a raster and the model that made it, or a failure. */
function finishComponent(
  component: MaskComponent,
  failed: boolean,
  hinted: Record<string, unknown>,
): MaskComponent {
  if (failed) {
    // `params.error` is where a failed detect says why; the component itself has no room
    // for a message and the job's notification is gone by the time a client redraws.
    return { ...component, state: "failed", params: { ...hinted, error: "no prompt to detect" } };
  }
  return {
    ...component,
    state: "ready",
    params: {
      ...hinted,
      model: component.kind === "text" ? "florence2+sam2-mock" : "sam2-mock",
      sourceHash: "0".repeat(16),
      raster: placeholderRegion(component.kind, hinted),
    },
  };
}

function requireThumbnailable(photoId: number): void {
  if (photoId <= maxThumbnailPhotoId) return;
  throw new Error(
    `photoId ${photoId} is above the thumbnail frame limit of ${maxThumbnailPhotoId}`,
  );
}

export class MockEngine {
  readonly catalog = new MockCatalog();
  private readonly photos = new Map<number, PhotoState>();
  private readonly views = new Map<number, View>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly jobs = new Map<number, Job>();
  private nextViewId = 1;
  private nextJobId = 1;
  private nextRunId = 1;
  /** `seq` of the next LMSK frame; it counts mask previews the way LFRM counts renders. */
  private maskSeq = 0;
  /**
   * `http://127.0.0.1:<port>`, set by `startMockEngine` once the listener bound. A merge
   * preview's `previewUrl` points back at this server, so the mock has to know its own
   * address the way `latentd` does.
   */
  baseUrl = "";
  private readonly merges = new MockMerge({
    catalog: this.catalog,
    broadcast: (method, params) => this.broadcast(method, params),
    startJob: () => this.startJob(),
    timer: (callback, delayMs) => this.timer(callback, delayMs),
    origin: () => this.baseUrl,
  });
  private readonly exports = new MockExport({
    broadcast: (method, params) => this.broadcast(method, params),
    startJob: () => this.startJob(),
    timer: (callback, delayMs) => this.timer(callback, delayMs),
    sourcePath: (photoId) => this.sourcePath(photoId),
  });

  constructor(private readonly broadcast: Broadcast) {}

  /** Stops every import job's timer; the server calls this when it shuts down. */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** The merge preview PNG behind a `/preview/<name>.png` request, if this mock made it. */
  previewPng(pathname: string): Uint8Array<ArrayBuffer> | undefined {
    return this.merges.servePreview(pathname);
  }

  photo(photoId: number): PhotoState {
    const photo = this.photos.get(photoId);
    if (!photo) throw new Error(`unknown photoId ${photoId}`);
    return photo;
  }

  handle(method: string, params: Record<string, unknown>): HandledCall {
    if (method === "engine.hello") {
      const hello: EngineHelloResult = {
        engineVersion: "mock-0.0.0",
        protocolVersion: 1,
        catalogPath: mockCatalogPath,
        // No mcpUrl: there is no interpreter here, the same shape as latentd --no-mcp.
        gpu: { adapter: "mock software", maxTextureDimension2D: 16384, shaderF16: false },
      };
      return { result: hello };
    }
    if (method === "ops.describe") {
      const described: OpsDescribeResult = { ops: opDefinitions };
      return { result: described };
    }
    if (method === "photo.open") {
      // The catalog owns ids: opening the same path twice is the same photo, whether it
      // came from an import, the file dialog or a script.
      const row = this.catalog.ensurePhoto(String(params.path));
      const opened: PhotoOpenResult = {
        photoId: row.photoId,
        width: row.width,
        height: row.height,
        camera: row.camera,
        hash: "0".repeat(64),
        sidecarLoaded: false,
        // The row rides along: a client that opens a photo never needs a catalog.get.
        catalog: row,
      };
      this.photoState(row.photoId);
      return { result: opened, changed: row.photoId };
    }
    if (method === "photo.close") {
      this.photos.delete(Number(params.photoId));
      return { result: {} };
    }
    if (method === "view.open") {
      const viewId = this.nextViewId++;
      this.views.set(viewId, {
        photoId: Number(params.photoId),
        width: Number(params.width),
        height: Number(params.height),
        seq: 0,
        viewport: FIT,
        insets: NO_INSETS,
      });
      return { result: { viewId } };
    }
    if (method === "view.close") {
      this.views.delete(Number(params.viewId));
      return { result: {} };
    }
    if (method === "python.run") {
      const photoId = params.photoId === undefined ? null : Number(params.photoId);
      const runId = this.nextRunId++;
      const started = performance.now();
      const result = this.runPython(String(params.code), photoId);
      const durationMs = performance.now() - started;
      // One streamed chunk before the result, the way a long script would trickle out,
      // then python.finished to close the stream. The result repeats the complete
      // streams; the console renders one or the other.
      const stream = result.ok ? "stdout" : "stderr";
      const text = result.ok ? result.stdout : result.stderr;
      return {
        result: { ...result, runId, durationMs },
        notifications: [
          { method: "python.output", params: { runId, stream, text } },
          { method: "python.finished", params: { runId, durationMs, ok: result.ok } },
        ],
      };
    }
    if (method === "job.cancel")
      return { result: { cancelled: this.cancelJob(Number(params.jobId)) } };
    // The mock has no preview queue to reorder; it answers so the UI's hint is not an error.
    if (method === "preview.prioritize") {
      const photoIds = params.photoIds as number[] | undefined;
      return { result: { prioritized: photoIds?.length ?? 0 } };
    }
    if (method.startsWith("catalog.")) return this.handleCatalog(method, params);
    if (method === "generative.status") return { result: generativeStatus() };
    if (method === "generative.run") {
      const photoId = Number(params.photoId);
      return {
        result: { jobId: this.startGenerative(photoId, idOf(params.opId)) },
        changed: photoId,
      };
    }
    // Read-only, and its result is not a stack snapshot, so it never reaches handleStack.
    if (method === "history.list") {
      return { result: this.photo(Number(params.photoId)).historyList() };
    }
    if (method.startsWith("mask.")) return this.handleMask(method, params);
    if (method.startsWith("merge.")) return this.merges.handle(method, params);
    if (method.startsWith("export.")) return this.exports.handle(method, params);
    const photoId = Number(params.photoId);
    const result = this.handleStack(method, params);
    if (this.isCommit(method, params)) this.markEdited(photoId);
    return { result, changed: photoId };
  }

  /** `geometry` is view.render's: "full" renders the image uncropped, as the crop tool asks. */
  render(
    viewId: number,
    geometry: "stack" | "full" = "stack",
  ): {
    frame: ArrayBuffer;
    renderMs: number;
    seq: number;
    width: number;
    height: number;
    contentRect: ContentRect;
    revision: number;
    map: MockGeometryMap;
    viewport: MockViewport;
    histogram: Histogram;
  } {
    const view = this.views.get(viewId);
    if (!view) throw new Error(`unknown viewId ${viewId}`);
    view.seq += 1;
    const photo = this.photo(view.photoId);
    const started = performance.now();
    const frame = renderFrame(view.width, view.height, view.seq, viewId, photo.stack);
    // The ops move pixels after the frame is painted rather than while it is: the mock's
    // renderer is a per-pixel loop already, and one more pass keeps the two apart.
    const resolved = geometryOf(photo.stack, geometry === "full");
    const fitted = applyGeometry(frame, FRAME_HEADER_BYTES, view.width, view.height, resolved);
    // Zoom and pan are one more scale of the picture that is now in the buffer, and the
    // matrix that goes out carries both halves (tools/mock-masks.ts).
    const map = geometryMap(resolved, fitted, view.width, view.height, view.viewport, view.insets);
    applyViewport(frame, FRAME_HEADER_BYTES, view.width, view.height, fitted, map);
    return {
      frame,
      renderMs: performance.now() - started,
      seq: view.seq,
      width: view.width,
      height: view.height,
      contentRect: map.content,
      map,
      viewport: view.viewport,
      // The state these pixels came from: a client compares it with the revision of the
      // last stack.changed to know whether its canvas is current.
      revision: photo.revision,
      // Counted off the pixels that are about to go out, as the engine does.
      histogram: histogramOf(frame, view.width, view.height, map.content),
    };
  }

  resize(viewId: number, width?: number, height?: number): void {
    const view = this.views.get(viewId);
    if (!view || !width || !height) return;
    view.width = width;
    view.height = height;
  }

  /** `view.render`'s insets: what the client floats over the frame, sticky per view. */
  setInsets(viewId: number, given: unknown): void {
    const view = this.views.get(viewId);
    if (!view || !given || typeof given !== "object") return;
    const fields = given as Record<string, unknown>;
    view.insets = {
      left: Math.max(0, numberOf(fields.left, 0)),
      top: Math.max(0, numberOf(fields.top, 0)),
      right: Math.max(0, numberOf(fields.right, 0)),
      bottom: Math.max(0, numberOf(fields.bottom, 0)),
    };
  }

  /** `view.render`'s viewport: sticky per view, absent leaves it where it was. */
  setViewport(viewId: number, given: unknown): void {
    const view = this.views.get(viewId);
    if (!view || !given || typeof given !== "object") return;
    const fields = given as Record<string, unknown>;
    const scale = Math.min(32, Math.max(1, numberOf(fields.scale, 1)));
    const hasCentre = fields.centerX !== undefined && fields.centerY !== undefined;
    view.viewport = {
      scale,
      centerX: numberOf(fields.centerX, 0.5),
      centerY: numberOf(fields.centerY, 0.5),
      fit: !hasCentre || scale <= 1,
    };
  }

  private photoState(photoId: number): PhotoState {
    const existing = this.photos.get(photoId);
    if (existing) return existing;
    const created = new PhotoState();
    this.photos.set(photoId, created);
    return created;
  }

  private handleCatalog(method: string, params: Record<string, unknown>): HandledCall {
    if (method === "catalog.import") {
      const paths = (params.paths ?? []) as string[];
      const recursive = params.recursive !== false;
      // Directories become watched roots, files never do — same rule as the engine's.
      for (const path of paths) this.catalog.watchFolder(path, recursive);
      return { result: this.startImport(paths, recursive) };
    }
    if (method === "catalog.list") return { result: this.catalog.list(params) };
    if (method === "catalog.get") return { result: this.catalog.photo(Number(params.photoId)) };
    if (method === "catalog.folders") return { result: this.catalog.folders() };
    if (method === "catalog.setRating") {
      const photo = this.catalog.setRating(Number(params.photoId), Number(params.rating));
      this.broadcast("catalog.changed", { photoIds: [photo.photoId], reason: "rating" });
      return { result: photo };
    }
    if (method === "catalog.setFlag") {
      const photo = this.catalog.setFlag(Number(params.photoId), params.flag as PhotoFlag);
      this.broadcast("catalog.changed", { photoIds: [photo.photoId], reason: "flag" });
      return { result: photo };
    }
    if (method === "catalog.collections") return { result: this.catalog.collections() };
    if (method === "catalog.collectionSet") {
      const result = this.catalog.collectionSet(params);
      const touched = [...((params.add ?? []) as number[]), ...((params.remove ?? []) as number[])];
      this.broadcast("catalog.changed", { photoIds: touched, reason: "collection" });
      return { result };
    }
    if (method === "catalog.thumbnail") {
      const photoId = Number(params.photoId);
      requireThumbnailable(photoId);
      const size = params.size === undefined ? 256 : Number(params.size);
      const thumbnail = this.catalog.thumbnailFrame(photoId, size);
      return {
        result: { photoId, width: thumbnail.width, height: thumbnail.height },
        frames: [thumbnail.frame],
      };
    }
    if (method === "catalog.thumbnails") {
      // One frame per photo that has one, then a result that accounts for the rest: a
      // photo the catalog does not know is `missing`, never an error and never a frame.
      const photoIds = [...new Set((params.photoIds ?? []) as number[])];
      // An unrepresentable id fails the call; only a photo that could not be rendered is
      // `missing`.
      for (const photoId of photoIds) requireThumbnailable(photoId);
      const size = params.size === undefined ? 256 : Number(params.size);
      const frames: ArrayBuffer[] = [];
      const missing: number[] = [];
      for (const photoId of photoIds) {
        if (!this.catalog.has(photoId)) {
          missing.push(photoId);
          continue;
        }
        frames.push(this.catalog.thumbnailFrame(photoId, size).frame);
      }
      return {
        result: { requested: photoIds.length, sent: frames.length, missing },
        frames,
      };
    }
    if (method === "catalog.remove") {
      const photoIds = (params.photoIds ?? []) as number[];
      const removed = this.catalog.remove(photoIds);
      for (const photoId of photoIds) this.photos.delete(photoId);
      if (removed > 0) this.broadcast("catalog.changed", { photoIds, reason: "remove" });
      return { result: { removed } };
    }
    throw new Error(`unknown method ${method}`);
  }

  /**
   * `mask.preview`, `mask.detect`, `mask.stroke`. Rasters never leave the engine as JSON:
   * the preview answers with one LMSK frame and a coverage number, and the UI only ever
   * sends parameters and stroke points back.
   */
  private handleMask(method: string, params: Record<string, unknown>): HandledCall {
    const photoId = Number(params.photoId);
    const photo = this.photo(photoId);
    const opId = idOf(params.opId);
    if (method === "mask.preview") {
      const componentId = params.componentId === undefined ? null : idOf(params.componentId);
      const viewId = params.viewId === undefined ? 0 : Number(params.viewId);
      const mask = this.previewMask(photo, opId, componentId);
      const size = this.previewSize(photoId, viewId);
      // Resolved at the raster's own grid, not the view's: `previewSize` caps the long
      // edge, and the bytes below are written at that size.
      const resolved = geometryOf(photo.stack, false);
      const fitted = contentRectOf(resolved, size.width, size.height);
      const map = geometryMap(
        resolved,
        fitted,
        size.width,
        size.height,
        this.views.get(viewId)?.viewport ?? FIT,
      );
      const bytes = combineMask(
        mask,
        size.width,
        size.height,
        imageSampler(size.width, size.height),
        map,
      );
      this.maskSeq += 1;
      return {
        result: {
          width: size.width,
          height: size.height,
          contentRect: map.content,
          imageTransform: map.imageToView,
          coverage: coverageOf(bytes),
        },
        frames: [maskFrame(size.width, size.height, this.maskSeq, viewId, bytes)],
      };
    }
    if (method === "mask.detect") {
      const componentId = idOf(params.componentId);
      const hint = (params.hint ?? {}) as Record<string, unknown>;
      return {
        result: { jobId: this.startDetect(photoId, opId, componentId, hint) },
        changed: photoId,
      };
    }
    if (method === "mask.stroke") {
      const componentId = idOf(params.componentId);
      const component = photo.component(opId, componentId);
      if (component.kind !== "brush") {
        throw new Error(`component ${componentId} is a ${component.kind}, not a brush`);
      }
      const segment: BrushSegment = {
        points: (params.points ?? []) as number[][],
        size: numberOf(params.size, numberOf(component.params?.size, 0.08)),
        flow: numberOf(params.flow, numberOf(component.params?.flow, 100)),
        erase: params.erase === true,
      };
      const transient = params.transient === true;
      photo.updateComponent(opId, componentId, (entry) => appendSegment(entry, segment), transient);
      if (!transient) this.markEdited(photoId);
      return { result: photo.snapshot(), changed: photoId };
    }
    throw new Error(`unknown method ${method}`);
  }

  /** The combined mask, or one component's own raster — which is an error while it pends. */
  private previewMask(photo: PhotoState, opId: string, componentId: string | null): Mask {
    const mask = photo.maskOf(opId);
    if (componentId === null) return mask;
    const component = photo.component(opId, componentId);
    if (component.state === "pending" || component.state === "failed") {
      throw new Error(`component ${componentId} is ${component.state} and has no raster`);
    }
    return { components: [{ ...component, mode: "add" }] };
  }

  /**
   * The raster is sized like the view it will be laid over, capped at
   * `maskPreviewMaxEdge` — the UI scales it onto the drawn image, and a 1:1 raster at
   * viewport resolution is the real engine's job, not a TS loop's.
   */
  private previewSize(photoId: number, viewId: number): { width: number; height: number } {
    const size = this.proxySize(photoId, viewId);
    const scale = Math.min(1, maskPreviewMaxEdge / Math.max(size.width, size.height));
    const { width, height } = size;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /** The view's size when the preview names one, else the photo's own. */
  private proxySize(photoId: number, viewId: number): { width: number; height: number } {
    const view = this.views.get(viewId);
    if (view) return { width: view.width, height: view.height };
    if (this.catalog.has(photoId)) {
      const row = this.catalog.photo(photoId);
      return { width: row.width, height: row.height };
    }
    return { width: 1024, height: 683 };
  }

  /**
   * The AI rasterisation of one component: `pending` right away, a few `job.progress`
   * ticks, then `ready` with a placeholder region — or `failed`, which is what a text
   * component without a prompt gets. Never inline in the call, exactly like the engine.
   */
  private startDetect(
    photoId: number,
    opId: string,
    componentId: string,
    hint: Record<string, unknown>,
  ): number {
    const photo = this.photo(photoId);
    const component = photo.component(opId, componentId);
    if (!isAiKind(component.kind)) {
      throw new Error(`component ${componentId} is a ${component.kind}: nothing to detect`);
    }
    const jobId = this.nextJobId++;
    const job: Job = { cancelled: false, finished: false };
    this.jobs.set(jobId, job);
    const merged = { ...component.params, ...hint };
    // Only `text` needs words from the user; every other kind detects from the pixels.
    const prompt = component.kind === "text" ? textOf(merged.prompt) : "ok";
    photo.updateComponent(
      opId,
      componentId,
      (entry) => ({ ...entry, state: "pending", jobId }),
      true,
    );

    const total = 3;
    let done = 0;
    const tick = (): void => {
      done += 1;
      const finished = done >= total || job.cancelled;
      const failed = prompt.trim() === "";
      const progress: Record<string, unknown> = {
        jobId,
        kind: "mask",
        done,
        total,
        finished,
        state: finished ? finishState(job.cancelled, failed) : "running",
        message: `${component.kind} mask`,
      };
      if (finished && failed) progress.error = "no prompt to detect";
      this.broadcast("job.progress", progress);
      if (!finished) {
        this.timer(tick, 40);
        return;
      }
      job.finished = true;
      photo.updateComponent(
        opId,
        componentId,
        (entry) => finishComponent(entry, failed || job.cancelled, merged),
        true,
      );
      this.broadcast("stack.changed", {
        ...photo.snapshot(),
        photoId,
        source: "external",
        client: "external",
      });
    };
    this.timer(tick, 40);
    return jobId;
  }

  /**
   * One generative run: a few `job.progress` ticks with kind `generative`, then the op
   * fields a real backend's answer would have written — `result`, `inputHash`,
   * `resultRect`. No pixels move over the wire; the frame renderer tints the rect, and the
   * stale badge follows from the hash the way it does in the engine (PROMPT.md 3.5).
   */
  private startGenerative(photoId: number, opId: string): number {
    const photo = this.photo(photoId);
    const op = photo.stack.find((entry) => entry.id === opId);
    if (!op) throw new Error(`unknown opId ${opId}`);
    if (!isGenerativeOp(op.op)) throw new Error(`op ${opId} is a ${op.op}, not a generative op`);
    if ((op.mask?.components.length ?? 0) === 0) {
      throw new Error("a generative op needs a mask: it is the region to repaint");
    }

    const jobId = this.nextJobId++;
    const job: Job = { cancelled: false, finished: false };
    this.jobs.set(jobId, job);
    const hash = inputHash(photo.stack, opId);
    const rect = resultRect(op);
    const total = 5;
    let done = 0;
    const tick = (): void => {
      done += 1;
      const finished = done >= total || job.cancelled;
      this.broadcast("job.progress", {
        jobId,
        kind: "generative",
        done,
        total,
        finished,
        state: finished ? finishState(job.cancelled, false) : "running",
        message: job.cancelled ? "cancelled" : "mock-tint",
      });
      if (!finished) {
        this.timer(tick, 120);
        return;
      }
      job.finished = true;
      // A cancelled run leaves the last result exactly as it was — that is the whole point
      // of a cached raster.
      if (!job.cancelled) {
        photo.finishGenerative(opId, {
          result: `generative/${opId}.png`,
          inputHash: hash,
          resultRect: rect,
        });
        this.markEdited(photoId);
      }
      this.broadcast("stack.changed", {
        ...photo.snapshot(),
        photoId,
        source: "external",
        client: "external",
      });
    };
    this.timer(tick, 120);
    return jobId;
  }

  /**
   * Walks the paths for raws and registers them over a few ticks, so the UI sees a real
   * job.progress sequence instead of one instant answer. Returns before any of it runs.
   * The thumbnail job is named in the same answer and reported when the import ends —
   * trivially, since the mock's thumbnails are drawn on demand and cost nothing.
   */
  private startImport(
    paths: string[],
    recursive: boolean,
  ): { jobId: number; thumbnailJobId: number; previewJobId: number } {
    const jobId = this.nextJobId++;
    const thumbnailJobId = this.nextJobId++;
    const previewJobId = this.nextJobId++;
    const job: Job = { cancelled: false, finished: false };
    const thumbnailJob: Job = { cancelled: false, finished: false };
    const previewJob: Job = { cancelled: false, finished: false };
    this.jobs.set(jobId, job);
    this.jobs.set(thumbnailJobId, thumbnailJob);
    this.jobs.set(previewJobId, previewJob);
    const files = scanRawFiles(paths, recursive);
    const total = files.length;
    let done = 0;

    const finish = (state: "done" | "cancelled", message: string): void => {
      job.finished = true;
      this.broadcast("job.progress", {
        jobId,
        kind: "import",
        done,
        total,
        finished: true,
        state,
        message,
      });
      // Always reported, even after a cancelled or empty import: catalog.import handed out
      // the id, so a client waiting on it must not wait forever.
      thumbnailJob.finished = true;
      const thumbnails = state === "cancelled" ? 0 : done;
      this.broadcast("job.progress", {
        jobId: thumbnailJobId,
        parentJobId: jobId,
        kind: "thumbnails",
        done: thumbnails,
        total: thumbnails,
        finished: true,
        state,
        message: `${thumbnails} thumbnails`,
      });
      // The real engine decodes every imported photo into its preview cache on a thread of
      // its own; here it is instant, so the job exists only to drive the same badge.
      previewJob.finished = true;
      this.broadcast("job.progress", {
        jobId: previewJobId,
        parentJobId: jobId,
        kind: "previews",
        done: thumbnails,
        total: thumbnails,
        finished: true,
        state,
        message: `${thumbnails} previews`,
      });
    };

    const tick = (): void => {
      // Cancellation lands between ticks: whatever was registered stays registered.
      if (job.cancelled) {
        finish("cancelled", `import cancelled after ${done} of ${total} photos`);
        return;
      }
      const slice = files.slice(done, done + importChunk);
      const photoIds = slice.map((path) => this.catalog.ensurePhoto(path).photoId);
      done += slice.length;
      if (photoIds.length > 0) this.broadcast("catalog.changed", { photoIds, reason: "import" });
      if (done >= total) {
        finish("done", `imported ${total} photos`);
        return;
      }
      this.broadcast("job.progress", {
        jobId,
        kind: "import",
        done,
        total,
        finished: false,
        state: "running",
        message: `importing ${done}/${total}`,
      });
      this.timer(tick, 120);
    };

    if (total === 0) {
      this.timer(() => finish("done", "no raw files found"), 30);
      return { jobId, thumbnailJobId, previewJobId };
    }
    this.timer(tick, 60);
    return { jobId, thumbnailJobId, previewJobId };
  }

  /** A cancellable job id, for work that runs outside this class (Photo Merge). */
  /** Where an exported file's `{name}` comes from. An id nobody imported has none. */
  private sourcePath(photoId: number): string {
    if (!this.catalog.has(photoId)) return "";
    return this.catalog.photo(photoId).path;
  }

  private startJob(): { jobId: number; job: Job } {
    const jobId = this.nextJobId++;
    const job: Job = { cancelled: false, finished: false };
    this.jobs.set(jobId, job);
    return { jobId, job };
  }

  /** A job that is unknown or already finished cannot be cancelled — that is not an error. */
  private cancelJob(jobId: number): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.finished) return false;
    job.cancelled = true;
    return true;
  }

  /**
   * Not Python — a stand-in that recognises the two statements the console advertises, so
   * the console's round trip (code in, stdout and a stack change out) is exercised without
   * an interpreter. The real engine runs this in embedded CPython (PROMPT.md §3.4).
   */
  private runPython(code: string, photoId: number | null): PythonRunResult {
    const exposure = /develop\.exposure\s*=\s*(-?\d+(?:\.\d+)?)/.exec(code);
    if (exposure && photoId === null) {
      return {
        ok: false,
        stdout: "",
        stderr: "RuntimeError: no photo is open; latent.photo is None",
      };
    }
    if (exposure) {
      const value = Number(exposure[1]);
      const photo = this.photoState(Number(photoId));
      const existing = photo.stack.find((entry) => entry.op === "exposure");
      if (existing) photo.updateOp(existing.id, { value }, undefined, false);
      else photo.addOp("exposure", { value });
      this.markEdited(Number(photoId));
      this.broadcast("stack.changed", {
        ...photo.snapshot(),
        photoId: Number(photoId),
        source: "python",
        client: "python",
      });
      return {
        ok: true,
        stdout: `latent.photo.develop.exposure = ${value.toFixed(2)}\n`,
        stderr: "",
        value: String(value),
      };
    }
    return {
      ok: true,
      stdout: `mock python: ${code.trim().split("\n").length} line(s), no interpreter here\n`,
      stderr: "",
      value: "None",
    };
  }

  /** A committed (non-transient) stack write is what stamps `editedAt` on a catalog row. */
  private isCommit(method: string, params: Record<string, unknown>): boolean {
    if (params.transient === true) return false;
    return ["op.add", "op.update", "op.remove", "stack.set"].includes(method);
  }

  private markEdited(photoId: number): void {
    if (!this.catalog.has(photoId)) return;
    this.catalog.markEdited(photoId);
    this.broadcast("catalog.changed", { photoIds: [photoId], reason: "edit" });
  }

  private timer(callback: () => void, delayMs: number): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      callback();
    }, delayMs);
    this.timers.add(handle);
  }

  // `op.add` answers with the new op's id beside the snapshot (protocol OpAddResult);
  // every other method here answers with the snapshot alone.
  private handleStack(
    method: string,
    params: Record<string, unknown>,
  ): StackGetResult | OpAddResult {
    const photo = this.photo(Number(params.photoId));
    const opParams = (params.params ?? {}) as Record<string, unknown>;
    if (method === "stack.get") return photo.snapshot();
    if (method === "stack.set") {
      // The UI writes masks and layer opacity through the whole stack, and its copy of a
      // component is one the engine handed it: rasterisation state and strokes are kept
      // from the engine's own stack rather than taken from the writer.
      photo.setStack(mergeEngineOwned(photo.stack, params.stack as Op[]));
      return photo.snapshot();
    }
    if (method === "op.add") {
      const added = photo.addOp(
        String(params.op),
        opParams,
        params.index as number | undefined,
        params.transient === true,
        layerWrite(params),
        params.parentId === undefined ? undefined : idOf(params.parentId),
      );
      // The id goes back with the stack: a caller that added into a layer cannot find the
      // op by position (protocol OpAddResult).
      return { ...photo.snapshot(), opId: added.id };
    }
    if (method === "op.update") {
      const enabled = typeof params.enabled === "boolean" ? params.enabled : undefined;
      photo.updateOp(
        idOf(params.opId),
        opParams,
        enabled,
        params.transient === true,
        layerWrite(params),
      );
      return photo.snapshot();
    }
    if (method === "op.remove") {
      photo.removeOp(String(params.opId));
      return photo.snapshot();
    }
    if (method === "history.undo") {
      photo.undo();
      return photo.snapshot();
    }
    if (method === "history.redo") {
      photo.redo();
      return photo.snapshot();
    }
    if (method === "history.jump") {
      photo.jump(Number(params.index));
      return photo.snapshot();
    }
    if (method === "history.merge") {
      photo.merge(Number(params.index));
      return photo.snapshot();
    }
    throw new Error(`unknown method ${method}`);
  }
}

export function startMockEngine(port: number): { port: number; stop: () => void } {
  const clients = new Set<ServerWebSocket<unknown>>();
  const engine = new MockEngine((method, params) => {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const client of clients) client.send(message);
  });

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      // The one thing this server answers over HTTP: a merge preview. `previewUrl` is an
      // absolute URL a renderer puts straight in an <img src>, which a file:// path could
      // not be — so the engine that wrote the PNG is also the one that serves it.
      const png = engine.previewPng(new URL(request.url).pathname);
      if (png) return new Response(png, { headers: { "content-type": "image/png" } });
      return new Response("latent mock engine: websocket only", { status: 426 });
    },
    websocket: {
      open(socket) {
        clients.add(socket);
      },
      close(socket) {
        clients.delete(socket);
      },
      message(socket, raw) {
        const request: RpcRequest = JSON.parse(String(raw));
        const params = request.params ?? {};
        try {
          if (request.method === "view.render") {
            const viewId = Number(params.viewId);
            engine.resize(
              viewId,
              params.width as number | undefined,
              params.height as number | undefined,
            );
            engine.setViewport(viewId, params.viewport);
            engine.setInsets(viewId, params.insets);
            const rendered = engine.render(viewId, params.geometry === "full" ? "full" : "stack");
            socket.send(new Uint8Array(rendered.frame));
            reply(socket, request.id, {
              seq: rendered.seq,
              width: rendered.width,
              height: rendered.height,
              // Where the geometry ops and the viewport put the image inside that buffer
              // (tools/mock-crop.ts, tools/mock-masks.ts).
              contentRect: rendered.contentRect,
              imageTransform: rendered.map.imageToView,
              viewport: rendered.viewport,
              renderMs: rendered.renderMs,
              readbackMs: 0,
              revision: rendered.revision,
              histogram: rendered.histogram,
            });
            return;
          }
          const { result, changed, frames, notifications } = engine.handle(request.method, params);
          // Both go before the result: the caller sees a script's output while the run is
          // still open, and has the thumbnail before the result tells it the size.
          for (const notification of notifications ?? []) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: notification.method,
                params: notification.params,
              }),
            );
          }
          for (const frame of frames ?? []) socket.send(new Uint8Array(frame));
          reply(socket, request.id, result);
          if (changed === undefined) return;
          publish(clients, socket, changed, engine.photo(changed).snapshot());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }),
          );
        }
      },
    },
  });

  const listeningPort = server.port;
  if (listeningPort === undefined) throw new Error("mock engine did not bind a TCP port");
  engine.baseUrl = `http://127.0.0.1:${listeningPort}`;
  return {
    port: listeningPort,
    stop: () => {
      engine.stop();
      void server.stop(true);
    },
  };
}

function reply(
  socket: ServerWebSocket<unknown>,
  id: number | string | undefined,
  result: unknown,
): void {
  if (id === undefined) return;
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

/**
 * Tells the writer its own change (`ui`, which its optimistic mirror already has) apart
 * from everyone else's (`mcp`, which has to trigger a re-render on the other clients).
 */
function publish(
  clients: Set<ServerWebSocket<unknown>>,
  writer: ServerWebSocket<unknown>,
  photoId: number,
  snapshot: StackGetResult,
): void {
  for (const client of clients) {
    const params: StackChangedParams = {
      ...snapshot,
      photoId,
      source: client === writer ? "ui" : "mcp",
      // One step finer than `source`, and free-form so an agent's tool can be named.
      client: client === writer ? "ui" : "mcp:run_python",
    };
    client.send(JSON.stringify({ jsonrpc: "2.0", method: "stack.changed", params }));
  }
}

if (import.meta.main) {
  const flagIndex = Bun.argv.indexOf("--port");
  const port = flagIndex < 0 ? 0 : Number(Bun.argv[flagIndex + 1]);
  const engine = startMockEngine(port);
  console.log(`listening on ws://127.0.0.1:${engine.port}`);
}

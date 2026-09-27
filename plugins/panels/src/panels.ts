// Pure mapping from what the engine describes to what the panel column shows. No engine
// calls, no DOM: `ops.describe` in, groups, control kinds, readout text and slider
// arithmetic out. Everything a slider does to a number lives here so it can be tested.
import type { Op, OpDefinition, OpParamDisplay, OpParamSpec } from "@latent/protocol";
import { curveJson, curvePoints, type SplitName } from "./curve";

/** Lightroom's Edit-panel headings, top to bottom, then Latent's own. */
export const sectionOrder = [
  "Light",
  "Color",
  "Effects",
  "Detail",
  "Optics",
  "Geometry",
  "Generative",
  "Enhance",
] as const;

/** Headings for an engine that predates `section` and only reports the `panel` key. */
const legacyLabels: Record<string, string> = {
  light: "Light",
  color: "Color",
  effects: "Effects",
  detail: "Detail",
  optics: "Optics",
  geometry: "Geometry",
  generative: "Generative",
  enhance: "Enhance",
};

/**
 * The section a generated pane draws: the part of `edit:<section>` after the colon. The
 * Edit column registers one pane per described section so each is its own draggable card.
 */
export function sectionOf(paneId: string): string {
  const colon = paneId.indexOf(":");
  if (colon < 0) return "";
  return paneId.slice(colon + 1);
}

export interface PanelGroup {
  /** The heading lowercased: the fold key and the `data-section` hook. */
  key: string;
  label: string;
  ops: OpDefinition[];
}

/** The heading an op is drawn under: `section` when the engine sends one, `panel` before that. */
export function sectionLabel(op: OpDefinition): string {
  if (op.section) return op.section;
  const known = legacyLabels[op.panel];
  if (known) return known;
  return op.panel.charAt(0).toUpperCase() + op.panel.slice(1);
}

/**
 * `order` ascending inside a section. An op without one sorts last; ties, and two ops that
 * both lack an `order`, keep the engine's order — so a describe from before `order` existed
 * still lays out the way the engine listed it rather than alphabetically.
 */
export function compareOrder(a: OpDefinition, b: OpDefinition): number {
  if (a.order === undefined && b.order === undefined) return 0;
  if (a.order === undefined) return 1;
  if (b.order === undefined) return -1;
  return a.order - b.order;
}

function sectionRank(key: string): number {
  const index = sectionOrder.findIndex((name) => name.toLowerCase() === key);
  if (index < 0) return sectionOrder.length;
  return index;
}

/** One group per section the engine serves, in Lightroom's order, ops by `order`. */
export function groupBySection(ops: OpDefinition[]): PanelGroup[] {
  const groups = new Map<string, PanelGroup>();
  for (const op of ops) {
    const label = sectionLabel(op);
    const key = label.toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.ops.push(op);
    else groups.set(key, { key, label, ops: [op] });
  }
  for (const group of groups.values()) group.ops.sort(compareOrder);
  return [...groups.values()].sort((a, b) => sectionRank(a.key) - sectionRank(b.key));
}

export type ControlKind = "slider" | "checkbox" | "select" | "pending" | "unsupported";

/**
 * `display.kind` decides the control when the engine sends one; `type` is the fallback for
 * an engine that does not. A colour-mixer parameter is an ordinary bipolar slider — `hsl`
 * says the mixer groups it into a band, not that it needs a different control — and the
 * mixer draws it with the same `Slider` as the rest of the column.
 *
 * `pending` is the note left for a parameter no control can hold. Curve parameters never
 * reach here in practice: `curveParams` takes them out of the generated list and the
 * hand-built editor draws them.
 */
export function controlKind(spec: OpParamSpec): ControlKind {
  const kind = spec.display?.kind;
  if (kind === "toggle") return "checkbox";
  if (kind === "slider" || kind === "kelvin" || kind === "hsl") return "slider";
  if (kind === "curve" || spec.type === "curve") return "pending";
  if (spec.type === "number" || spec.type === "integer") return "slider";
  if (spec.type === "boolean") return "checkbox";
  if (spec.type === "enum" && spec.values && spec.values.length > 0) return "select";
  return "unsupported";
}

/** What the placeholder row says in place of a control no generated widget can hold. */
export const pendingNote = "Drawn by the curve editor";

/** A point curve, whichever way the engine labelled it. */
function isCurveSpec(spec: OpParamSpec): boolean {
  return spec.display?.kind === "curve" || spec.type === "curve";
}

/**
 * The engine describes a split point as an ordinary 0..100 slider — `display.kind` has no
 * value for one — so the three are matched by name. Renaming them in
 * engine/src/ops/registry.cpp needs the same change here.
 */
const splitNames: SplitName[] = ["shadowSplit", "midtoneSplit", "highlightSplit"];

/** One split point: its engine name, typed, beside the spec the handle reads its range from. */
export interface CurveSplit {
  name: SplitName;
  spec: OpParamSpec;
}

export interface CurveParams {
  /** The point curves, one per channel, drawn as one graph with a tab each. */
  points: OpParamSpec[];
  /** The parametric region amounts, Lightroom's four sliders under the graph. */
  regions: OpParamSpec[];
  /** The three split points, drawn as handles on the graph's x axis. */
  splits: CurveSplit[];
}

/**
 * What the hand-built curve editor draws, or null for an op without a point curve.
 *
 * An op that has any point curve is the editor's whole op: `tone_curve`'s parametric
 * regions and splits share the same graph, and generating sliders for them beside the
 * editor would draw the same curve twice.
 */
export function curveParams(op: OpDefinition): CurveParams | null {
  const points = op.params.filter(isCurveSpec);
  if (points.length === 0) return null;
  const rest = op.params.filter((spec) => !isCurveSpec(spec));
  const splits: CurveSplit[] = [];
  for (const name of splitNames) {
    const spec = rest.find((candidate) => candidate.name === name);
    if (spec) splits.push({ name, spec });
  }
  return {
    points,
    regions: rest.filter((spec) => !splitNames.some((name) => name === spec.name)),
    splits,
  };
}

/** Lightroom's Color Mixer tabs: one per channel, then the grid of all of them. */
export const mixerChannels = ["Hue", "Saturation", "Luminance"] as const;
export type MixerChannel = (typeof mixerChannels)[number];

/** One band's slider for one channel. */
export interface MixerSlider {
  channel: MixerChannel;
  spec: OpParamSpec;
}

/** One of Lightroom's eight colour bands, with whichever channels the engine describes. */
export interface MixerBand {
  /** The engine's band name, `red` … `magenta`. */
  name: string;
  label: string;
  sliders: MixerSlider[];
}

export interface MixerParams {
  bands: MixerBand[];
}

/**
 * The engine names a mixer slider `<band><Channel>` and marks it `display.kind: "hsl"`.
 * The kind says it belongs to the mixer but not to which band or which of the three, so
 * the name is split here; renaming them in engine/src/ops/registry.cpp needs the same
 * change. A parameter whose name carries no channel is not the mixer's.
 */
function mixerSlot(spec: OpParamSpec): { band: string; channel: MixerChannel } | null {
  if (spec.display?.kind !== "hsl") return null;
  for (const channel of mixerChannels) {
    if (!spec.name.endsWith(channel)) continue;
    const band = spec.name.slice(0, -channel.length);
    if (band.length === 0) return null;
    return { band, channel };
  }
  return null;
}

/**
 * What the hand-built colour mixer draws, or null for an op with no mixer band. An op that
 * has any is entirely the mixer's, the same rule the curve editor follows.
 */
export function mixerParams(op: OpDefinition): MixerParams | null {
  const bands: MixerBand[] = [];
  for (const spec of op.params) {
    const slot = mixerSlot(spec);
    if (!slot) continue;
    const existing = bands.find((band) => band.name === slot.band);
    if (existing) {
      existing.sliders.push({ channel: slot.channel, spec });
      continue;
    }
    bands.push({
      name: slot.band,
      label: titleCase(slot.band),
      sliders: [{ channel: slot.channel, spec }],
    });
  }
  if (bands.length === 0) return null;
  return { bands };
}

/** The parameters `ParamControl` draws: everything the hand-built editors did not take. */
export function generatedParams(op: OpDefinition): OpParamSpec[] {
  if (curveParams(op) || mixerParams(op)) return [];
  return op.params;
}

const curveStrokes: Record<string, string> = {
  parametric: "var(--color-default)",
  rgb: "var(--color-default)",
  red: "var(--ctx-red)",
  green: "var(--ctx-green)",
  blue: "var(--ctx-blue)",
};

/**
 * The colour a curve is stroked in — the channel it steers, in context tokens, so the
 * graph follows the theme the way the tinted slider tracks do. A channel the engine
 * invents is stroked like the RGB one rather than going invisible.
 */
export function curveStroke(tab: string): string {
  return curveStrokes[tab] ?? "var(--color-default)";
}

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

/** Lightroom's sliders are symmetric around zero, which is the right default here too. */
export function sliderRange(spec: OpParamSpec): SliderRange {
  const min = spec.min ?? -100;
  const max = spec.max ?? 100;
  if (spec.step) return { min, max, step: spec.step };
  if (spec.type === "integer") return { min, max, step: 1 };
  return { min, max, step: (max - min) / 200 };
}

/** An engine name as a heading: separators to spaces, first letter up. */
function titleCase(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function paramLabel(spec: OpParamSpec): string {
  if (spec.label) return spec.label;
  return titleCase(spec.name);
}

/**
 * Lightroom labels a one-slider op with the op's name ("Exposure"), and a multi-slider
 * op with each parameter's name ("Temperature", "Tint").
 */
export function rowLabel(op: OpDefinition, spec: OpParamSpec): string {
  if (op.params.length === 1) return op.label;
  return paramLabel(spec);
}

/** A range that straddles zero: it gets a centre detent, a centred fill and signed readouts. */
export function isBipolar(range: SliderRange): boolean {
  return range.min < 0 && range.max > 0;
}

/** Decimals to print: the step decides, so a 0.01 step never shows a bare integer. */
export function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

/** The minus Lightroom draws is the typographic one, not the hyphen a keyboard types. */
const MINUS = "−";

/** A Kelvin slider prints `K` without the engine having to spell the unit out. */
export function readoutUnit(spec: OpParamSpec): string {
  if (spec.unit) return spec.unit;
  if (spec.display?.kind === "kelvin") return "K";
  return "";
}

/**
 * Readout text. Bipolar sliders sign every non-zero value the way Lightroom does
 * (`+0.52`, `−19`, `0`); one-sided ones stay bare (`40`). Kelvin is an absolute
 * temperature, so it never takes a `+`. The unit follows.
 */
export function formatValue(value: number, spec: OpParamSpec): string {
  const range = sliderRange(spec);
  const digits = decimalsFor(range.step);
  const rounded = Number(value.toFixed(digits));
  const magnitude = Math.abs(rounded).toFixed(digits);
  const text = signPrefix(rounded, range, spec) + magnitude;
  const unit = readoutUnit(spec);
  if (unit) return `${text} ${unit}`;
  return text;
}

/**
 * One side of a recorded change as its control would print it — a history row, the
 * Assistant's change list. A value the engine left off is an em dash.
 */
export function formatSide(
  value: number | string | boolean | undefined,
  spec: OpParamSpec | undefined,
): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return value;
  if (!spec) return String(value);
  return formatValue(value, spec);
}

function signPrefix(rounded: number, range: SliderRange, spec: OpParamSpec): string {
  if (rounded < 0) return MINUS;
  if (spec.display?.kind === "kelvin") return "";
  if (rounded > 0 && isBipolar(range)) return "+";
  return "";
}

/** What the readout field puts in the text box when it is clicked: plain, re-typeable. */
export function editableText(value: number, spec: OpParamSpec): string {
  return value.toFixed(decimalsFor(sliderRange(spec).step));
}

/**
 * Text the user typed back into a number. Tolerates the signs and unit the readout
 * prints — no exponent, because `e`/`E` cannot be told apart from a unit like `EV`.
 * Refuses anything that is not a number so a bad edit can be cancelled.
 */
export function parseValue(text: string, range: SliderRange): number | null {
  const cleaned = text.replace(MINUS, "-").replace(/[^\d+.-]/g, "");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return quantize(parsed, range);
}

export function clamp(value: number, range: SliderRange): number {
  if (value < range.min) return range.min;
  if (value > range.max) return range.max;
  return value;
}

/** Snap to the slider's step so a drag cannot produce 0.4999999999 for a 0.01 step. */
export function quantize(value: number, range: SliderRange): number {
  const snapped = range.min + Math.round((value - range.min) / range.step) * range.step;
  return clamp(Number(snapped.toFixed(6)), range);
}

/** How wide the zero detent is, as a fraction of the whole range. */
const DETENT_FRACTION = 0.015;

/**
 * Pointer moves near the middle of a bipolar slider land exactly on zero — the notch
 * Lightroom has, so "back to neutral" does not need a double-click.
 */
export function detented(value: number, range: SliderRange): number {
  if (!isBipolar(range)) return value;
  if (Math.abs(value) > (range.max - range.min) * DETENT_FRACTION) return value;
  return 0;
}

/** Where a value sits on the track, 0–100, for `left`/`width` styles. */
export function percentOf(value: number, range: SliderRange): number {
  return ((clamp(value, range) - range.min) / (range.max - range.min)) * 100;
}

export interface FillBounds {
  left: number;
  width: number;
}

/** Lightroom fills from the centre outwards on bipolar sliders, from the left otherwise. */
export function fillBounds(value: number, range: SliderRange): FillBounds {
  const thumb = percentOf(value, range);
  if (!isBipolar(range)) return { left: 0, width: thumb };
  const origin = percentOf(0, range);
  return { left: Math.min(origin, thumb), width: Math.abs(thumb - origin) };
}

export interface Modifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * How far the pointer travels to sweep a slider end to end at plain gain. Fixed in pixels
 * rather than in steps, so every slider scrubs at the same speed whatever its range is —
 * a step per pixel made Contrast (−100…100, step 1) cross its whole range in 200 px, which
 * is a twitch, while Exposure's 0.01 step needed 1000 px for the same sweep.
 */
const SCRUB_PIXELS_PER_RANGE = 800;

/**
 * Scrubbing the readout: a sweep of the range per {@link SCRUB_PIXELS_PER_RANGE} pixels,
 * ten times that with Shift, a quarter of it with Ctrl/Alt. Anchored to the value the drag
 * started from so a round trip lands where it began.
 */
export function scrubbedValue(
  start: number,
  deltaX: number,
  range: SliderRange,
  modifiers: Modifiers,
): number {
  const perPixel = (range.max - range.min) / SCRUB_PIXELS_PER_RANGE;
  return quantize(start + deltaX * perPixel * scrubGain(modifiers), range);
}

function scrubGain(modifiers: Modifiers): number {
  if (modifiers.shiftKey) return 10;
  if (modifiers.ctrlKey || modifiers.altKey) return 0.25;
  return 1;
}

/** Arrow keys move one step, ten with Shift. Anything else is not the slider's key. */
export function keyboardDelta(key: string, shiftKey: boolean, range: SliderRange): number | null {
  const stride = shiftKey ? range.step * 10 : range.step;
  if (key === "ArrowLeft" || key === "ArrowDown") return -stride;
  if (key === "ArrowRight" || key === "ArrowUp") return stride;
  return null;
}

/** The spectrum, in context tokens: red round to red so a hue wheel wraps without a seam. */
const SPECTRUM =
  "var(--ctx-red), var(--ctx-amber), var(--ctx-green), var(--ctx-blue), " +
  "var(--ctx-violet), var(--ctx-pink), var(--ctx-red)";

const tintGradients: Record<NonNullable<OpParamDisplay["tint"]>, string> = {
  temperature: "linear-gradient(to right, var(--ctx-blue), var(--ctx-amber))",
  tint: "linear-gradient(to right, var(--ctx-green), var(--ctx-pink))",
  hue: `linear-gradient(to right, ${SPECTRUM})`,
  saturation: `linear-gradient(to right, var(--color-line-strong), ${SPECTRUM})`,
};

/**
 * A track carries the colour it steers towards, as Lightroom's do. The axis comes from the
 * engine's `display.tint`, never from the parameter's name; a parameter without one gets a
 * plain fill.
 */
export function trackTint(spec: OpParamSpec): string | null {
  const tint = spec.display?.tint;
  if (!tint) return null;
  return tintGradients[tint];
}

/**
 * One entry by id, wherever it is. A layer's adjustments are one level down (protocol
 * Op.ops) and are exactly what a control aimed at a mask reads and writes, so a lookup that
 * only walked the top level would show every masked slider at its default.
 */
export function opEntry(stack: Op[], opId: string): Op | undefined {
  const top = stack.find((candidate) => candidate.id === opId);
  if (top) return top;
  for (const entry of stack) {
    const child = entry.ops?.find((candidate) => candidate.id === opId);
    if (child) return child;
  }
  return undefined;
}

/**
 * The value the control shows: the engine's stack when the op is in it, else the default.
 * `opId` picks one entry by id — the same op can be in the stack twice, once masked.
 */
export function paramValue(
  stack: Op[],
  op: OpDefinition,
  spec: OpParamSpec,
  opId?: string | null,
): unknown {
  const entry = opId ? opEntry(stack, opId) : stack.find((candidate) => candidate.op === op.name);
  if (!entry) return spec.default;
  const value = entry.params[spec.name];
  if (value === undefined) return spec.default;
  return value;
}

/** Numbers compare within half a step; the engine may round a float on the way back. */
function isDefaultValue(value: unknown, spec: OpParamSpec): boolean {
  // A curve is an array, so it is never the same object as the described default; the
  // untouched curve is the one with no points, and a bare pair of endpoints is that curve.
  if (isCurveSpec(spec)) return curveJson(curvePoints(value)).length === 0;
  if (typeof value !== "number" || typeof spec.default !== "number") {
    return value === spec.default;
  }
  return Math.abs(value - spec.default) < sliderRange(spec).step / 2;
}

/** A control someone pointed at, for its row to scroll into view and flash (`PanelsState`). */
export interface Highlight {
  /** The stack entry, which is what a Masks-pane row is keyed by. */
  opId: string;
  /** The op's name, which is what an Edit-column row is keyed by. */
  op: string;
  /** Null names every row of the op. */
  param: string | null;
  /** `Date.now()` when it was asked for. */
  at: number;
}

/** How long a highlight still flashes a row that mounts after it: a mode switch, a flyout. */
const HIGHLIGHT_FRESH_MS = 1000;

/** Whether this row flashes: the named entry where the row has one, else the op by name. */
export function isHighlighted(
  target: Highlight | null,
  row: { op: string; param: string; opId: string | null },
  now: number,
): boolean {
  if (!target || now - target.at > HIGHLIGHT_FRESH_MS) return false;
  if (target.param !== null && target.param !== row.param) return false;
  if (row.opId) return target.opId === row.opId;
  return target.op === row.op;
}

/**
 * The stack entry the Edit column reads and writes while a mask is selected: that layer's
 * child with this op name (`ViewerService.maskTarget`). Null while the layer does not hold
 * the adjustment yet — the write that adds it goes through `setParam`, which the viewer
 * routes into the layer.
 */
export function layerEntryId(stack: Op[], targetId: string | null, name: string): string | null {
  if (!targetId) return null;
  const layer = stack.find((entry) => entry.id === targetId);
  return layer?.ops?.find((child) => child.op === name)?.id ?? null;
}

/**
 * What a control shows. `opId` is the entry it was aimed at; without one it is the photo's
 * own copy of the op — unless a mask is selected, in which case the control belongs to that
 * mask and a mask that does not hold the adjustment is at the described default. Showing the
 * photo's value there would be a lie: the next drag writes into the mask, not into it.
 */
export function controlValue(
  stack: Op[],
  op: OpDefinition,
  spec: OpParamSpec,
  opId: string | null,
  targetId: string | null,
): unknown {
  if (opId) return paramValue(stack, op, spec, opId);
  if (targetId !== null) return spec.default;
  return paramValue(stack, op, spec);
}

/** "Mask 2" — how the Edit column names the layer it is writing into. */
export function maskTargetLabel(stack: Op[], targetId: string | null): string | null {
  if (!targetId) return null;
  const index = stack.filter((entry) => entry.op === "group").findIndex((op) => op.id === targetId);
  if (index < 0) return null;
  return `Mask ${index + 1}`;
}

export function opEdited(stack: Op[], op: OpDefinition, targetId: string | null = null): boolean {
  const entryId = layerEntryId(stack, targetId, op.name);
  // A mask that does not hold this adjustment is at the defaults, whatever the photo's own
  // copy of it says.
  if (targetId !== null && entryId === null) return false;
  return op.params.some((spec) => !isDefaultValue(paramValue(stack, op, spec, entryId), spec));
}

/** The section's "edited" dot: does any op in this section differ from its defaults? */
export function groupEdited(
  stack: Op[],
  group: PanelGroup,
  targetId: string | null = null,
): boolean {
  return group.ops.some((op) => opEdited(stack, op, targetId));
}

/** Every parameter of an op back at its described default — one write per op for a reset. */
export function defaultParams(op: OpDefinition): Record<string, unknown> {
  return Object.fromEntries(op.params.map((spec) => [spec.name, spec.default]));
}

/** What the Edit column says about an op that is also in a mask, or is a layer of its own. */
export interface LayerBadge {
  /** The layer to open: the group holding this adjustment, or the op itself. */
  opId: string;
  /** How many layers hold this adjustment; 0 for an op that is only a layer by opacity. */
  layers: number;
  components: number;
  opacity: number;
}

/**
 * The badge for one op of the generated column, or null when the op is an ordinary global
 * adjustment. An adjustment that is also inside a mask says so and opens that mask, because
 * the Edit column's copy of it is the *global* one: the two are different stack entries
 * (PROMPT.md 3.7). Opacity only shows when it is below 100, the way Lightroom only shows an
 * amount that is not full.
 */
export function layerBadge(stack: Op[], op: OpDefinition): LayerBadge | null {
  const holders = stack.filter((candidate) =>
    (candidate.ops ?? []).some((child) => child.op === op.name),
  );
  const first = holders[0];
  if (first) {
    return {
      opId: first.id,
      layers: holders.length,
      components: first.mask?.components.length ?? 0,
      opacity: first.opacity ?? 100,
    };
  }
  // No layer holds it: the op itself may still carry an opacity, and a generative op
  // carries the mask of the region it painted.
  const entry = stack.find((candidate) => candidate.op === op.name);
  if (!entry) return null;
  const components = entry.mask?.components.length ?? 0;
  const opacity = entry.opacity ?? 100;
  if (components === 0 && opacity >= 100) return null;
  return { opId: entry.id, layers: 0, components, opacity };
}

export interface HistoryKeyEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+Z undoes, Ctrl+Shift+Z redoes; anything else is not ours. */
export function historyShortcut(event: HistoryKeyEvent): "undo" | "redo" | null {
  if (!event.ctrlKey) return null;
  if (event.key.toLowerCase() !== "z") return null;
  if (event.shiftKey) return "redo";
  return "undo";
}

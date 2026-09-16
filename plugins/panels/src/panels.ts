// Pure mapping from what the engine describes to what the panel column shows. No engine
// calls, no DOM: `ops.describe` in, groups, control kinds, readout text and slider
// arithmetic out. Everything a slider does to a number lives here so it can be tested.
import type { Op, OpDefinition, OpParamDisplay, OpParamSpec } from "@latent/protocol";

/** Lightroom's Edit-panel headings, top to bottom. Sections the engine invents sort after. */
export const sectionOrder = ["Light", "Color", "Effects", "Detail", "Optics", "Geometry"] as const;

/** Headings for an engine that predates `section` and only reports the `panel` key. */
const legacyLabels: Record<string, string> = {
  light: "Light",
  color: "Color",
  effects: "Effects",
  detail: "Detail",
  optics: "Optics",
  geometry: "Geometry",
  generative: "Generative",
};

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
 * an engine that does not. `pending` is a curve or colour-mixer parameter — it gets a note
 * rather than a generated control, because the real editor is a hand-built plugin and a
 * slider over those values would be a lie.
 */
export function controlKind(spec: OpParamSpec): ControlKind {
  const kind = spec.display?.kind;
  if (kind === "curve" || kind === "hsl") return "pending";
  if (kind === "toggle") return "checkbox";
  if (kind === "slider" || kind === "kelvin") return "slider";
  if (spec.type === "number" || spec.type === "integer") return "slider";
  if (spec.type === "boolean") return "checkbox";
  if (spec.type === "enum" && spec.values && spec.values.length > 0) return "select";
  if (spec.type === "curve") return "pending";
  return "unsupported";
}

/** What the placeholder row says in place of a control that is not built yet. */
export function pendingNote(spec: OpParamSpec): string {
  if (spec.display?.kind === "hsl") return "Color mixer — coming";
  return "Curve editor — coming";
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

export function paramLabel(spec: OpParamSpec): string {
  if (spec.label) return spec.label;
  const spaced = spec.name.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
 * Scrubbing the readout: one step per pixel, ten with Shift, a quarter with Ctrl/Alt.
 * Anchored to the value the drag started from so a round trip lands where it began.
 */
export function scrubbedValue(
  start: number,
  deltaX: number,
  range: SliderRange,
  modifiers: Modifiers,
): number {
  return quantize(start + deltaX * range.step * scrubGain(modifiers), range);
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

/** The value the control shows: the engine's stack when the op is in it, else the default. */
export function paramValue(stack: Op[], op: OpDefinition, spec: OpParamSpec): unknown {
  const entry = stack.find((candidate) => candidate.op === op.name);
  if (!entry) return spec.default;
  const value = entry.params[spec.name];
  if (value === undefined) return spec.default;
  return value;
}

/** Numbers compare within half a step; the engine may round a float on the way back. */
function isDefaultValue(value: unknown, spec: OpParamSpec): boolean {
  if (typeof value !== "number" || typeof spec.default !== "number") {
    return value === spec.default;
  }
  return Math.abs(value - spec.default) < sliderRange(spec).step / 2;
}

export function opEdited(stack: Op[], op: OpDefinition): boolean {
  return op.params.some((spec) => !isDefaultValue(paramValue(stack, op, spec), spec));
}

/** The section's "edited" dot: does any op in this section differ from its defaults? */
export function groupEdited(stack: Op[], group: PanelGroup): boolean {
  return group.ops.some((op) => opEdited(stack, op));
}

/** Every parameter of an op back at its described default — one write per op for a reset. */
export function defaultParams(op: OpDefinition): Record<string, unknown> {
  return Object.fromEntries(op.params.map((spec) => [spec.name, spec.default]));
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

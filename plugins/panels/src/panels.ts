// Pure mapping from what the engine describes to what the panel column shows. No engine
// calls, no DOM: `ops.describe` in, groups and control kinds out.
import type { OpDefinition, OpParamSpec } from "@latent/protocol";

/** Lightroom's Edit-panel order. Panels the engine adds later sort after these. */
export const panelOrder = ["light", "color", "effects", "detail", "optics", "geometry"] as const;

const panelLabels: Record<string, string> = {
  light: "Light",
  color: "Color",
  effects: "Effects",
  detail: "Detail",
  optics: "Optics",
  geometry: "Geometry",
  generative: "Generative",
};

export interface PanelGroup {
  panel: string;
  label: string;
  ops: OpDefinition[];
}

export function panelLabel(panel: string): string {
  const known = panelLabels[panel];
  if (known) return known;
  return panel.charAt(0).toUpperCase() + panel.slice(1);
}

/** One group per panel the engine actually serves, in Lightroom order, ops in engine order. */
export function groupByPanel(ops: OpDefinition[]): PanelGroup[] {
  const groups = new Map<string, OpDefinition[]>();
  for (const op of ops) {
    const existing = groups.get(op.panel);
    if (existing) existing.push(op);
    else groups.set(op.panel, [op]);
  }
  const served = panelOrder.filter((panel) => groups.has(panel));
  const rest = [...groups.keys()].filter((panel) => !panelOrder.some((known) => known === panel));
  return [...served, ...rest].map((panel) => ({
    panel,
    label: panelLabel(panel),
    ops: groups.get(panel) ?? [],
  }));
}

export type ControlKind = "slider" | "checkbox" | "select" | "unsupported";

/** Curves and anything unknown get a hand-built plugin, not a generated control. */
export function controlKind(spec: OpParamSpec): ControlKind {
  if (spec.type === "number" || spec.type === "integer") return "slider";
  if (spec.type === "boolean") return "checkbox";
  if (spec.type === "enum" && spec.values && spec.values.length > 0) return "select";
  return "unsupported";
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

/** Readout text: integer steps print whole, finer steps print two decimals, plus the unit. */
export function formatValue(value: number, spec: OpParamSpec): string {
  const { step } = sliderRange(spec);
  const digits = step >= 1 ? 0 : 2;
  const text = value.toFixed(digits);
  if (spec.unit) return `${text} ${spec.unit}`;
  return text;
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

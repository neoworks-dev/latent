// Everything the Masks column knows that is not a DOM node: the kind catalogue, the edits
// a component list accepts, the overlay's tint table, and the signature that decides when a
// preview is stale. No engine calls here — the state object makes those.
import type { Mask, MaskComponent, MaskComponentKind, Op, OpParamSpec } from "@latent/protocol";

/** Kinds that need a model, so creating one is followed by `mask.detect`. */
const aiKinds: readonly MaskComponentKind[] = [
  "subject",
  "sky",
  "background",
  "objects",
  "people",
  "text",
];

export function isAiKind(kind: MaskComponentKind): boolean {
  return aiKinds.includes(kind);
}

export type KindGroup = "ai" | "manual" | "range";

export interface KindSpec {
  kind: MaskComponentKind;
  label: string;
  group: KindGroup;
  /** The tool the overlay arms once the component exists, if any. */
  tool: MaskTool;
}

/** Lightroom's Create New Mask menu, in its order and its three groups. */
export const kindSpecs: readonly KindSpec[] = [
  { kind: "subject", label: "Select subject", group: "ai", tool: "none" },
  { kind: "sky", label: "Select sky", group: "ai", tool: "none" },
  { kind: "background", label: "Select background", group: "ai", tool: "none" },
  { kind: "objects", label: "Select objects", group: "ai", tool: "box" },
  { kind: "people", label: "Select people", group: "ai", tool: "none" },
  { kind: "text", label: "Select by text", group: "ai", tool: "none" },
  { kind: "brush", label: "Brush", group: "manual", tool: "brush" },
  { kind: "linear", label: "Linear gradient", group: "manual", tool: "linear" },
  { kind: "radial", label: "Radial gradient", group: "manual", tool: "radial" },
  { kind: "luminance", label: "Luminance range", group: "range", tool: "none" },
  { kind: "color", label: "Color range", group: "range", tool: "none" },
  { kind: "depth", label: "Depth range", group: "range", tool: "none" },
];

export const groupLabels: Record<KindGroup, string> = {
  ai: "AI",
  manual: "Tools",
  range: "Range",
};

/** What the overlay is doing with a drag. `none` = the overlay only tints. */
export type MaskTool = "none" | "brush" | "linear" | "radial" | "box";

export function kindSpec(kind: MaskComponentKind): KindSpec {
  const found = kindSpecs.find((spec) => spec.kind === kind);
  // A kind the engine invented is still drawable: label it and give it no tool.
  return found ?? { kind, label: kind, group: "range", tool: "none" };
}

/** Ids are the UI's only invention here; the engine takes the mask as it is written. */
export function componentId(existing: Mask | undefined, kind: MaskComponentKind): string {
  const taken = new Set((existing?.components ?? []).map((component) => component.id));
  for (let index = 1; ; index++) {
    const candidate = `${kind}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A new component at the defaults its kind edits from. Manual kinds start on something
 * visible — a centred ellipse, a gradient down the frame — so the overlay has handles to
 * drag before the first drag happens.
 */
export function defaultComponent(
  kind: MaskComponentKind,
  id: string,
  mode: MaskComponent["mode"] = "add",
): MaskComponent {
  const base: MaskComponent = { id, kind, mode, invert: false, opacity: 100 };
  if (kind === "radial") {
    return {
      ...base,
      feather: 50,
      params: { center: [0.5, 0.5], radius: [0.25, 0.25], angle: 0 },
    };
  }
  if (kind === "linear") {
    return { ...base, feather: 50, params: { start: [0.5, 0.25], end: [0.5, 0.75] } };
  }
  if (kind === "brush") return { ...base, feather: 50, params: { size: 0.08, flow: 100 } };
  if (kind === "luminance") {
    return { ...base, feather: 0, params: { range: [0.5, 1], smoothness: 0.1 } };
  }
  if (kind === "color") {
    return { ...base, feather: 0, params: { samples: [[0.4, 0.4, 0.5]], range: 0.25 } };
  }
  return { ...base, feather: 0 };
}

export function addComponent(mask: Mask | undefined, component: MaskComponent): Mask {
  return { components: [...(mask?.components ?? []), component] };
}

/** Dropping the last component drops the mask: an op with an empty mask is not a layer. */
export function removeComponent(mask: Mask, id: string): Mask | undefined {
  const components = mask.components.filter((component) => component.id !== id);
  if (components.length === 0) return undefined;
  return { components };
}

export function patchComponent(mask: Mask, id: string, patch: Partial<MaskComponent>): Mask {
  return {
    components: mask.components.map((component) => {
      if (component.id !== id) return component;
      return { ...component, ...patch };
    }),
  };
}

/** Merges into `params` rather than replacing it, so a drag keeps the rest of the kind. */
export function patchComponentParams(
  mask: Mask,
  id: string,
  params: Record<string, unknown>,
): Mask {
  return {
    components: mask.components.map((component) => {
      if (component.id !== id) return component;
      return { ...component, params: { ...component.params, ...params } };
    }),
  };
}

export function opById(stack: Op[], opId: string | null): Op | undefined {
  if (!opId) return undefined;
  return stack.find((op) => op.id === opId);
}

/** The op the column opens on: the last one carrying a mask, the way a layer list reads. */
export function lastMaskedOp(stack: Op[]): Op | undefined {
  return [...stack].reverse().find((op) => (op.mask?.components.length ?? 0) > 0);
}

/**
 * What a preview was made from. The overlay re-asks when this changes and not when some
 * other op moved, so a slider on a different layer costs no mask round trip.
 */
export function maskSignature(op: Op | undefined, componentId_: string | null): string {
  if (!op) return "";
  return JSON.stringify([op.id, op.mask?.components ?? [], componentId_]);
}

export type MaskTint = "red" | "green" | "white" | "blackOnWhite";

const tintOrder: readonly MaskTint[] = ["red", "green", "white", "blackOnWhite"];

export const tintLabels: Record<MaskTint, string> = {
  red: "Red",
  green: "Green",
  white: "White",
  blackOnWhite: "Black on white",
};

/** Shift+O walks the overlay styles, the way Lightroom's overlay mode menu does. */
export function nextTint(tint: MaskTint): MaskTint {
  const index = tintOrder.indexOf(tint);
  return tintOrder[(index + 1) % tintOrder.length] ?? "red";
}

/** rgba of the tint at full coverage, plus the wash laid under it, if the mode has one. */
export interface TintStyle {
  /** [r, g, b] of the mask itself. */
  color: [number, number, number];
  /** Alpha at full coverage. */
  alpha: number;
  /** A flat wash over the whole photo under the mask, e.g. white for black-on-white. */
  wash: [number, number, number, number] | null;
}

export function tintStyle(tint: MaskTint): TintStyle {
  if (tint === "green") return { color: [40, 230, 90], alpha: 0.55, wash: null };
  if (tint === "white") return { color: [255, 255, 255], alpha: 0.65, wash: null };
  if (tint === "blackOnWhite") {
    return { color: [0, 0, 0], alpha: 1, wash: [255, 255, 255, 0.92] };
  }
  return { color: [255, 60, 60], alpha: 0.55, wash: null };
}

/**
 * The r8 raster as rgba pixels for an ImageData: the tint's colour everywhere, alpha from
 * the coverage. One pass, no per-pixel branch, because this runs on every preview.
 */
export function tintPixels(coverage: Uint8Array, tint: MaskTint): Uint8ClampedArray<ArrayBuffer> {
  const { color, alpha } = tintStyle(tint);
  const pixels = new Uint8ClampedArray(coverage.length * 4);
  for (let index = 0; index < coverage.length; index++) {
    const offset = index * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = (coverage[index] ?? 0) * alpha;
  }
  return pixels;
}

/** "18%" — enough precision to see a stroke land, never a number that jitters. */
export function coverageLabel(fraction: number): string {
  if (fraction <= 0) return "empty";
  if (fraction < 0.01) return "<1%";
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The Edit column's sliders are generated from `ops.describe`; a mask component's are not
 * described by anything, so the specs are written here and fed to the same controls. One
 * slider implementation, one readout, one set of gestures.
 */
function spec(name: string, label: string, max: number, step: number, unit?: string): OpParamSpec {
  const built: OpParamSpec = {
    name,
    label,
    type: "number",
    min: 0,
    max,
    step,
    default: 0,
    display: { kind: "slider" },
  };
  if (unit) built.unit = unit;
  return built;
}

export const featherSpec = spec("feather", "Feather", 100, 1);
export const opacitySpec = spec("opacity", "Opacity", 100, 1, "%");
export const flowSpec = spec("flow", "Flow", 100, 1, "%");
/** Brush diameter as a percentage of the long edge: `params.size` × 100. */
export const brushSizeSpec = spec("size", "Size", 80, 0.5, "%");

export interface MaskKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
}

export type MaskAction = "toggleOverlay" | "cycleTint" | "brushSmaller" | "brushLarger";

/** O, Shift+O and the bracket keys. A keystroke aimed at a text field is that field's. */
export function maskShortcut(event: MaskKeyEvent): MaskAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (target?.isContentEditable) return null;
  const tag = target?.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  if (event.key === "[") return "brushSmaller";
  if (event.key === "]") return "brushLarger";
  if (event.key.toLowerCase() !== "o") return null;
  return event.shiftKey ? "cycleTint" : "toggleOverlay";
}

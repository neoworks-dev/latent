// The Layers column's arithmetic: the stack read top-down, the moves a drag makes, and the
// one-line summary a row shows. Pure — the column calls `viewer.setStack` with what comes
// out of here, and the engine decides what the stack actually becomes.
import type { Op, OpDefinition } from "@latent/protocol";

export interface LayerRow {
  op: Op;
  /** Position in the stack; the column draws them the other way round. */
  index: number;
}

/** Luminar's list: the last op applied is the top row, the base of the stack the bottom. */
export function layerRows(stack: Op[]): LayerRow[] {
  return stack.map((op, index) => ({ op, index })).reverse();
}

/** Display position → stack position. The column is the stack upside down. */
export function stackIndexOf(stackLength: number, displayIndex: number): number {
  return stackLength - 1 - displayIndex;
}

function moved<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (!item) return items;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

/**
 * A row dragged from one place in the column to another, expressed as the stack the engine
 * should end up with. Order matters to the result — moving a layer past another is a real
 * edit, not a view preference.
 */
export function reorderByDisplay(stack: Op[], fromDisplay: number, toDisplay: number): Op[] {
  const from = stackIndexOf(stack.length, fromDisplay);
  const to = stackIndexOf(stack.length, toDisplay);
  return moved(stack, from, to);
}

/**
 * Which row a pointer at `y` is over, given each row's top and bottom. A pointer past the
 * last row drops at the end; the halves decide, so a row swaps as soon as the pointer is
 * over the other row's middle.
 */
export function dropIndex(bounds: { top: number; bottom: number }[], y: number): number {
  for (const [index, row] of bounds.entries()) {
    if (y < (row.top + row.bottom) / 2) return index;
  }
  return bounds.length - 1;
}

/** A copy above the original, with an id of its own — the stack keys rows by id. */
export function duplicateOp(stack: Op[], opId: string): Op[] {
  const index = stack.findIndex((op) => op.id === opId);
  const original = stack[index];
  if (!original) return stack;
  const copy: Op = structuredClone(original);
  copy.id = uniqueId(stack, `${original.id}-copy`);
  return [...stack.slice(0, index + 1), copy, ...stack.slice(index + 1)];
}

function uniqueId(stack: Op[], base: string): string {
  const taken = new Set(stack.map((op) => op.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function removeOp(stack: Op[], opId: string): Op[] {
  return stack.filter((op) => op.id !== opId);
}

/**
 * Alt-click on an eye: everything else off, or everything back on when this layer is
 * already the only one enabled.
 */
export function soloed(stack: Op[], opId: string): Op[] {
  const alreadySolo = stack.every((op) => (op.id === opId) === op.enabled);
  return stack.map((op) => ({ ...op, enabled: alreadySolo || op.id === opId }));
}

/** Trailing zeros are noise in a one-line summary; a whole number stays whole. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2);
}

function formatValue(value: unknown): string | null {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return value;
  return null;
}

/**
 * What the row says under the op's name: the parameters that are not at their default, the
 * first two of them. An op at its defaults says nothing rather than repeating zeros.
 */
export function paramSummary(op: Op, definition: OpDefinition | undefined): string {
  const specs = definition?.params ?? [];
  const parts: string[] = [];
  for (const spec of specs) {
    const value = op.params[spec.name];
    if (value === undefined || value === spec.default) continue;
    const text = formatValue(value);
    if (text === null) continue;
    const withUnit = spec.unit ? `${text} ${spec.unit}` : text;
    parts.push(specs.length === 1 ? withUnit : `${spec.label ?? spec.name} ${withUnit}`);
    if (parts.length === 2) break;
  }
  if (parts.length > 0) return parts.join(" · ");
  // An op the engine describes with no parameters has nothing to summarise; one whose
  // parameters are all at their defaults says so.
  if (Object.keys(op.params).length === 0) return "";
  return "default";
}

/** The mask summary on a row: how many components, or nothing when the op has no mask. */
export function maskSummary(op: Op): string {
  const count = op.mask?.components.length ?? 0;
  if (count === 0) return "";
  const kinds = new Set((op.mask?.components ?? []).map((component) => component.kind));
  return [...kinds].join(", ");
}

export function opacityOf(op: Op): number {
  return op.opacity ?? 100;
}

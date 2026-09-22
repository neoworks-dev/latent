// Turning the engine's `history.list` into the rows the History pane draws. The engine
// says which op and which parameter moved, in the parameter's own units; the labels and
// the formatting are `ops.describe`'s, so a history row reads exactly like the slider it
// came from. Pure — no engine calls, no DOM.
import { formatValue, paramLabel, rowLabel } from "@latent/plugin-panels";
import type {
  HistoryChange,
  HistoryEntry,
  HistoryStep,
  OpDefinition,
  OpParamSpec,
} from "@latent/protocol";

export interface HistoryRow {
  index: number;
  /** What moved: "Exposure", "Temperature", "Opened", "Golden hour applied". */
  title: string;
  /** Where it went: "0.00 → +1.00 EV", "added", "" when there is nothing to say. */
  detail: string;
  /** A batch's ops, one row each, to unfold under it. Empty on every other step. */
  children: HistoryRow[];
  /** A child row's op, which `history.revertOp` puts back on its own. */
  opId?: string;
}

function specOf(definition: OpDefinition | undefined, param: string): OpParamSpec | undefined {
  return definition?.params.find((spec) => spec.name === param);
}

/** One value as its control would print it; a value the engine left off is an em dash. */
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

function changeText(change: HistoryChange, definition: OpDefinition | undefined): string {
  const spec = specOf(definition, change.param);
  // Neither side survived the wire: a curve's point list, which a row can only report as
  // having moved.
  if (change.from === undefined && change.to === undefined) return "changed";
  return `${formatSide(change.from, spec)} → ${formatSide(change.to, spec)}`;
}

/**
 * What one op's change is called. A one-slider op is named by the op ("Exposure"), a
 * multi-slider one by the parameter that moved ("Temperature") — the rule the panel column
 * already uses for its rows. A batch's entries read exactly like the steps they would have
 * been on their own, which is the point of unfolding one.
 */
function opTitle(entry: HistoryEntry | HistoryStep, definition: OpDefinition | undefined): string {
  if (!definition) return entry.op ?? "Edit";
  const change = entry.changes?.[0];
  const spec = change ? specOf(definition, change.param) : undefined;
  if (!spec) return definition.label;
  return rowLabel(definition, spec);
}

function stepTitle(step: HistoryStep, definition: OpDefinition | undefined): string {
  if (step.kind === "initial") return "Opened";
  if (step.kind === "reorder") return "Reordered";
  // A batch nobody named: the engine cannot know a dozen ops arrived together as a preset.
  if (step.kind === "batch") return "Several edits";
  return opTitle(step, definition);
}

/** Where one op went. Empty for the steps that are about the stack rather than an op. */
function opDetail(entry: HistoryEntry | HistoryStep, definition: OpDefinition | undefined): string {
  if (entry.kind === "add") return "added";
  if (entry.kind === "remove") return "removed";
  if (entry.kind === "mask") return "mask changed";
  const changes = entry.changes ?? [];
  const first = changes[0];
  if (!first) return "";
  const detail = changeText(first, definition);
  // A commit that moved several parameters at once — the panel's Reset, one op of a preset —
  // says so rather than pretending the first one was the whole step.
  if (changes.length === 1) return detail;
  return `${detail} · +${changes.length - 1} more`;
}

/** What one step did, ready to draw. `ops` is `ops.describe`'s answer. */
export function historyRow(step: HistoryStep, ops: OpDefinition[]): HistoryRow {
  const definition = ops.find((entry) => entry.name === step.op);
  // The caller's own name for the step wins over the one the diff would derive: it knew the
  // dozen ops were a preset and the diff never can.
  const title = step.label ?? stepTitle(step, definition);
  const children = (step.entries ?? []).map((entry) => {
    const entryDefinition = ops.find((candidate) => candidate.name === entry.op);
    return {
      index: step.index,
      title: opTitle(entry, entryDefinition),
      detail: opDetail(entry, entryDefinition),
      children: [],
      opId: entry.opId,
    };
  });
  if (step.kind === "batch") {
    return { index: step.index, title, detail: `${children.length} ops`, children };
  }
  return { index: step.index, title, detail: opDetail(step, definition), children };
}

/** Every step as a row, newest first: the order a history list is read in. */
export function historyRows(steps: HistoryStep[], ops: OpDefinition[]): HistoryRow[] {
  return steps.map((step) => historyRow(step, ops)).reverse();
}

/** The parameter label a row's tooltip spells out, for a change whose title is the op's. */
export function changeLabel(change: HistoryChange, ops: OpDefinition[], op?: string): string {
  const definition = ops.find((entry) => entry.name === op);
  const spec = specOf(definition, change.param);
  if (!spec) return change.param;
  return paramLabel(spec);
}

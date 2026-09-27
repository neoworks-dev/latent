// Turning the engine's `history.list` into the rows the History pane draws. The engine
// says which op and which parameter moved, in the parameter's own units; the labels and
// the formatting are `ops.describe`'s, so a history row reads exactly like the slider it
// came from. Pure — no engine calls, no DOM.
import { formatSide, paramLabel, rowLabel } from "@latent/plugin-panels";
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
  // Whatever it brought in, it is one branch joining another, and that is what it is called.
  if (step.mergedFrom !== undefined) return `Merged step ${step.mergedFrom}`;
  if (step.kind === "reorder") return "Reordered";
  // A batch nobody named: the engine cannot know a dozen ops arrived together as a preset.
  if (step.kind === "batch") return "Several edits";
  // The op a mask sits on is a layer group, which has no panel label of its own.
  if (step.kind === "mask") return "Mask";
  return opTitle(step, definition);
}

/** "radial1" → "Radial 1": mask component ids are the Masks panel's `<kind><n>`. */
function componentName(id: string): string {
  const match = /^([a-z]+)(\d+)$/.exec(id);
  if (!match) return id;
  const [, kind = id, number = ""] = match;
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${number}`;
}

/**
 * One mask change: `radial1` is a component arriving or leaving, `radial1.feather` a
 * property of one. Values are raw — a mask property has no `ops.describe` spec.
 */
function maskChangeText(change: HistoryChange): string {
  const [id = change.param, property] = change.param.split(".");
  const name = componentName(id);
  if (!property) return change.to === undefined ? `${name} removed` : `${name} added`;
  if (change.from === undefined || change.to === undefined) return `${name} ${property}`;
  return `${name} ${property} ${String(change.from)} → ${String(change.to)}`;
}

function maskDetail(entry: HistoryEntry | HistoryStep): string {
  const changes = entry.changes ?? [];
  const first = changes[0];
  if (!first) return "mask changed";
  const detail = maskChangeText(first);
  if (changes.length === 1) return detail;
  return `${detail} · +${changes.length - 1} more`;
}

/** A spec default a row can print; a list default (a curve's points) prints as nothing. */
function printableDefault(spec: OpParamSpec | undefined): HistoryChange["to"] {
  const value = spec?.default;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

/**
 * An op arriving or leaving, told as the slider it is: "0.00 → +1.00 EV" rather than
 * "added". The engine sends the op's values with the missing side empty, which stands for
 * the default. Values still at their default moved nothing and are left out.
 */
function arrivalDetail(
  entry: HistoryEntry | HistoryStep,
  definition: OpDefinition | undefined,
): string {
  const adding = entry.kind === "add";
  const moved = (entry.changes ?? []).filter((change) => {
    const value = adding ? change.to : change.from;
    return value !== undefined && value !== printableDefault(specOf(definition, change.param));
  });
  const [first] = moved;
  if (!first) return adding ? "added" : "removed";
  const spec = specOf(definition, first.param);
  const fallback = printableDefault(spec);
  const detail = adding
    ? `${formatSide(fallback, spec)} → ${formatSide(first.to, spec)}`
    : `${formatSide(first.from, spec)} → ${formatSide(fallback, spec)}`;
  if (moved.length === 1) return detail;
  return `${detail} · +${moved.length - 1} more`;
}

/** Where one op went. Empty for the steps that are about the stack rather than an op. */
function opDetail(entry: HistoryEntry | HistoryStep, definition: OpDefinition | undefined): string {
  if (entry.kind === "add" || entry.kind === "remove") return arrivalDetail(entry, definition);
  if (entry.kind === "mask") return maskDetail(entry);
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

/**
 * Every step as a row, newest first: the order a history list is read in. A merge nobody
 * named is called after the branch step it brought in, which only the whole list knows.
 */
export function historyRows(steps: HistoryStep[], ops: OpDefinition[]): HistoryRow[] {
  const rows = steps.map((step) => historyRow(step, ops));
  const titles = new Map(rows.map((row) => [row.index, row.title]));
  for (const [position, step] of steps.entries()) {
    const row = rows[position];
    const merged = step.mergedFrom === undefined ? undefined : titles.get(step.mergedFrom);
    if (!row || step.label !== undefined || merged === undefined) continue;
    row.title = `Merged “${merged}”`;
  }
  return rows.reverse();
}

/** One line of the graph inside one row: from a lane at one edge to a lane at the other. */
export interface GraphEdge {
  from: number;
  to: number;
}

/**
 * One row of the history graph, git-log style. `top` runs from the row's upper edge to its
 * middle, where the step's node sits in `lane`; `bottom` from the middle on down, towards
 * the older steps below. An edge whose lanes differ is a branch joining or leaving.
 */
export interface GraphRow {
  index: number;
  lane: number;
  top: GraphEdge[];
  bottom: GraphEdge[];
}

function freeLane(lanes: (number | null)[]): number {
  const free = lanes.indexOf(null);
  return free < 0 ? lanes.length : free;
}

/**
 * The history tree laid out as lanes, newest step first — the order `historyRows` gives.
 * Each lane holds the step it is waiting to reach: a step takes the lane that waited for it
 * (the leftmost, when two branches both did, and the others end there), hands that lane to
 * its parent, and opens one more for the branch a merge brought in.
 */
export function historyGraph(steps: HistoryStep[]): GraphRow[] {
  const lanes: (number | null)[] = [];
  const rows: GraphRow[] = [];
  for (const step of [...steps].sort((left, right) => right.index - left.index)) {
    const waiting: number[] = [];
    for (const [waitingLane, expected] of lanes.entries()) {
      if (expected === step.index) waiting.push(waitingLane);
    }
    const lane = waiting[0] ?? freeLane(lanes);
    const top: GraphEdge[] = [];
    for (const [from, expected] of lanes.entries()) {
      if (expected === null) continue;
      top.push({ from, to: expected === step.index ? lane : from });
    }
    for (const joined of waiting) lanes[joined] = null;
    lanes[lane] = step.parent ?? null;

    const bottom: GraphEdge[] = [];
    if (step.parent !== undefined) bottom.push({ from: lane, to: lane });
    let opened: number | null = null;
    if (step.mergedFrom !== undefined) {
      const existing = lanes.indexOf(step.mergedFrom);
      const target = existing < 0 ? freeLane(lanes) : existing;
      if (existing < 0) opened = target;
      lanes[target] = step.mergedFrom;
      bottom.push({ from: lane, to: target });
    }
    for (const [through, expected] of lanes.entries()) {
      if (expected === null || through === lane || through === opened) continue;
      bottom.push({ from: through, to: through });
    }
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
    rows.push({ index: step.index, lane, top, bottom });
  }
  return rows;
}

/** How many lanes the widest row of the graph needs. */
export function graphWidth(rows: GraphRow[]): number {
  let width = 1;
  for (const row of rows) {
    for (const edge of [...row.top, ...row.bottom]) {
      width = Math.max(width, edge.from + 1, edge.to + 1);
    }
    width = Math.max(width, row.lane + 1);
  }
  return width;
}

/**
 * Every step the one at `index` is made of: itself, its parents, and the branches merged
 * into it. What is outside this set is not in the photo as it stands — another branch.
 */
export function ancestorsOf(steps: HistoryStep[], index: number): Set<number> {
  const byIndex = new Map(steps.map((step) => [step.index, step]));
  const found = new Set<number>();
  const pending = [index];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const step = byIndex.get(next);
    if (!step || found.has(next)) continue;
    found.add(next);
    if (step.parent !== undefined) pending.push(step.parent);
    if (step.mergedFrom !== undefined) pending.push(step.mergedFrom);
  }
  return found;
}

/** The parameter label a row's tooltip spells out, for a change whose title is the op's. */
export function changeLabel(change: HistoryChange, ops: OpDefinition[], op?: string): string {
  const definition = ops.find((entry) => entry.name === op);
  const spec = specOf(definition, change.param);
  if (!spec) return change.param;
  return paramLabel(spec);
}

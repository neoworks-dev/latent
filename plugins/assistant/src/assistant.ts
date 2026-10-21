// Pure assistant logic: the selection box, what the agent is told, and how the daemon's session
// events become a chat transcript. No engine, no daemon connection, no DOM.
// Before @latent/contracts on purpose: this is the first file tsc checks, and when the
// contracts load before the kernel does, their `Context` augmentation (engine, panes,
// viewer, …) does not take and index.ts fails to typecheck.
import type {} from "@neoworks/extension-system";
import type { SafeArea } from "@latent/contracts";
import { formatSide, rowLabel } from "@latent/plugin-panels";
import type {
  HistoryChange,
  HistoryEntry,
  HistoryStep,
  JobProgressParams,
  OpDefinition,
  OpParamSpec,
} from "@latent/protocol";
import type { Client, SubscribeOptions } from "@neoworks-dev/neo-sdk";

/** One event of a daemon session (the protocol's SessionEvent, which the SDK doesn't re-export). */
export type SessionEvent = Parameters<SubscribeOptions["onEvent"]>[0];
export type PermissionRequest = Extract<SessionEvent, { type: "permission_request" }>;
/** One harness the session can run on, and the models, efforts and modes it offers. */
export type HarnessSettings = Awaited<ReturnType<Client["sessionSettings"]>>["harnesses"][number];
export type ConfigOption = HarnessSettings["options"][number];
/** One of the daemon's sessions, as it lists them: title, state, last activity. */
export type SessionInfo = Client["sessions"]["value"][number];

/** `[x0, y0, x1, y1]`, 0..1 over the uncropped photo — the space masks are stored in. */
export type Box = [number, number, number, number];
export type Point = [number, number];
/** What the chat is about: a box on the photo, or all of it. */
export type Target = Box | "photo";

/** The rail mode the assistant's column lives on. */
export const ASSISTANT_MODE = "assistant";

/** A drag shorter than this, as a fraction of the photo, is a click, not a selection. */
const MINIMUM_BOX = 0.01;

export function boxFromDrag(start: Point, end: Point): Box | null {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const box: Box = [
    clamp(Math.min(start[0], end[0])),
    clamp(Math.min(start[1], end[1])),
    clamp(Math.max(start[0], end[0])),
    clamp(Math.max(start[1], end[1])),
  ];
  if (box[2] - box[0] < MINIMUM_BOX || box[3] - box[1] < MINIMUM_BOX) return null;
  return box;
}

/** The daemon's sessions, the one that did something last first. */
export function sortSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((left, right) => right.lastActivity - left.lastActivity);
}

/** What a session goes by in a list: its title, else the last thing said in it. */
export function sessionTitle(session: SessionInfo): string {
  if (session.title) return session.title;
  if (session.preview) return session.preview;
  return "Untitled session";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a session last did something, as "5 min ago", and the date once it is a week old. */
export function activityLabel(timestamp: number, now: number): string {
  const age = Math.max(0, now - timestamp);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * One photo's conversation: its daemon session, the last event the chat has seen of it, and what
 * the chat showed (with the turn summaries and change rows the daemon doesn't know about).
 */
export interface Conversation {
  sessionId: string;
  seq: number;
  items: TranscriptItem[];
  costUsd: number | null;
}

// v1 held sidecar sessions, which the daemon can't resume.
export const CONVERSATIONS_KEY = "latent.assistant.conversations.v2";

/** localStorage holds a few MB: the most recent photos only, and no pictures. */
const MAX_CONVERSATIONS = 20;

/** Oldest first. An array, not an object keyed by photo: integer keys iterate sorted. */
type StoredConversation = Conversation & { photoId: number };

function readConversations(storage: Pick<Storage, "getItem">): StoredConversation[] {
  const stored = storage.getItem(CONVERSATIONS_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredConversation[];
  } catch {
    return [];
  }
}

export function loadConversation(
  storage: Pick<Storage, "getItem">,
  photoId: number,
): Conversation | null {
  const stored = readConversations(storage).find((entry) => entry.photoId === photoId);
  if (!stored) return null;
  const { photoId: _photoId, ...conversation } = stored;
  return conversation;
}

/** Stores a photo's conversation as the newest, or forgets it with `null`. */
export function saveConversation(
  storage: Pick<Storage, "getItem" | "setItem">,
  photoId: number,
  conversation: Conversation | null,
): void {
  const kept = readConversations(storage)
    .filter((entry) => entry.photoId !== photoId)
    .slice(-(MAX_CONVERSATIONS - 1));
  if (conversation) kept.push({ ...forStorage(conversation), photoId });
  storage.setItem(CONVERSATIONS_KEY, JSON.stringify(kept));
}

/**
 * No pictures, and no turn summaries: their Undo is a history index, which means nothing
 * once the engine restarts with a fresh undo stack — it would land on some other step.
 */
function forStorage(conversation: Conversation): Conversation {
  const items = conversation.items
    .filter((item) => item.kind !== "summary")
    .map((item): TranscriptItem => {
      if (item.kind === "user") return { kind: "user", text: item.text };
      if (item.kind === "tool") return { ...item, image: undefined };
      return item;
    });
  return { ...conversation, items };
}

const JOB_LABELS: Partial<Record<JobProgressParams["kind"], string>> = {
  mask: "mask detection",
  generative: "generative run",
  depth: "depth estimate",
};

/** The jobs an agent starts and waits on; anything else (an import, an export) is not its. */
export function agentJobLabel(kind: JobProgressParams["kind"]): string | null {
  return JOB_LABELS[kind] ?? null;
}

/** How one finished job went, for the message that wakes the agent. */
export function jobOutcome(params: JobProgressParams): string {
  const label = agentJobLabel(params.kind) ?? params.kind;
  const state = params.state ?? "done";
  if (state === "error") return `${label} failed: ${params.error ?? "no reason given"}`;
  if (state === "cancelled") return `${label} was cancelled`;
  return `${label} finished`;
}

/** What wakes the agent once the jobs it started are all done. */
export function jobsFinishedPrompt(outcomes: string[]): string {
  return `<jobs_finished>\n${outcomes.map((outcome) => `- ${outcome}`).join("\n")}\n</jobs_finished>\n\nContinue.`;
}

/** The user's instruction plus where it applies and how many reference images follow it. */
export function buildPrompt(
  instruction: string,
  photoId: number,
  target: Target,
  references = 0,
): string {
  const where =
    target === "photo"
      ? `<selection photo_id="${photoId}" whole_photo="true" />`
      : `<selection photo_id="${photoId}" box="[${target.map((value) => value.toFixed(4)).join(", ")}]" />`;
  if (references === 0) return `${instruction.trim()}\n\n${where}`;
  const attached = references === 1 ? "1 reference image" : `${references} reference images`;
  return `${instruction.trim()}\n\n${where}\n\nAttached: ${attached}.`;
}

/** The engine's MCP tools, as named in engine/python/latent/mcp_server.py, as the chat says them. */
const TOOL_LABELS: Record<string, string> = {
  run_python: "Ran a script",
  get_stack: "Read the edits",
  get_histogram: "Read the histogram",
  render_preview: "Looked at the photo",
  list_photos: "Listed the photos",
  generative_fill: "Generative fill",
  generative_remove: "Generative remove",
  generative_status: "Checked ComfyUI",
  export: "Exported",
  merge_hdr: "HDR merge",
  merge_panorama: "Panorama merge",
  merge_star_trail: "Star trail merge",
  merge_preview: "Merge preview",
  undo: "Undid a step",
  find_photos: "Searched the catalog",
  open_photo: "Opened a photo",
};

/**
 * What a tool row is called: the agent's own explanation of a script, else the Latent
 * tool's label, else the title the agent gave the call.
 */
export function toolLabel(title: string, input?: unknown): string {
  const name = latentToolName(title);
  if (name === null) return title;
  const explained = typeof input === "object" && input !== null && "explanation" in input;
  if (explained && typeof input.explanation === "string" && input.explanation.trim()) {
    return input.explanation.trim();
  }
  const asksForMask = typeof input === "object" && input !== null && "mask" in input;
  if (name === "render_preview" && asksForMask && input.mask) return "Looked at a mask";
  const zooms = typeof input === "object" && input !== null && "region" in input;
  if (name === "render_preview" && zooms && input.region) return "Zoomed in";
  return TOOL_LABELS[name] ?? title;
}

/**
 * The Latent tool a call is about. Agents title an MCP call differently — `latent.export` for
 * neo, `mcp__latent__export` for a guest — so look for the name as a whole token.
 */
export function latentToolName(title: string): string | null {
  for (const token of title.split(/[^a-z0-9_]+/i)) {
    const name = token.split("__").at(-1) ?? "";
    if (Object.hasOwn(TOOL_LABELS, name)) return name;
  }
  return null;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  title: string;
  status: "running" | "done" | "failed";
  /** What the agent passed: run_python's `code`, render_preview's arguments. */
  input?: unknown;
  /** The text the tool answered with. */
  output?: string;
  /** The picture it answered with, as a data URL — render_preview's. */
  image?: string;
  /** The undo steps the engine committed while it ran: what it changed. */
  steps?: HistoryStep[];
}

export type TranscriptItem =
  | { kind: "user"; text: string; images?: string[] }
  | { kind: "assistant"; text: string }
  | ToolItem
  | { kind: "note"; text: string; tone: "muted" | "error" }
  /**
   * After a turn that changed the photo: every step it committed, for the summary, and the
   * history index it started from, which Undo jumps back to.
   */
  | { kind: "summary"; index: number; steps: HistoryStep[]; undone: boolean };

type ToolCallUpdate = Extract<SessionEvent, { type: "tool_call_update" }>;

/** The text and the last image of a tool's answer; `imageUrl` turns an image's src into a URL. */
function toolOutput(
  content: NonNullable<ToolCallUpdate["content"]>,
  imageUrl: (src: string) => string | undefined,
): Pick<ToolItem, "output" | "image"> {
  const texts: string[] = [];
  let image: string | undefined;
  for (const entry of content) {
    if (entry.type === "text") texts.push(entry.text);
    if (entry.type === "image") image = imageUrl(entry.src);
  }
  return { output: texts.length > 0 ? texts.join("\n") : undefined, image };
}

/** neo calls an app's tool through `tools_call {name, args}`: what the chat shows is `args`. */
function callInput(rawInput: unknown): unknown {
  if (typeof rawInput !== "object" || rawInput === null) return rawInput;
  if (!("name" in rawInput) || !("args" in rawInput)) return rawInput;
  return rawInput.args;
}

/** One session event folded into the transcript; text chunks join the reply they belong to. */
export function applyEvent(
  items: TranscriptItem[],
  event: SessionEvent,
  imageUrl: (src: string) => string | undefined,
): TranscriptItem[] {
  if (event.type === "agent_message_chunk") {
    const last = items.at(-1);
    if (last?.kind === "assistant") {
      return [...items.slice(0, -1), { kind: "assistant", text: last.text + event.text }];
    }
    return [...items, { kind: "assistant", text: event.text }];
  }
  if (event.type === "tool_call") {
    const tool: ToolItem = {
      kind: "tool",
      id: event.toolCallId,
      title: event.title,
      status: "running",
      input: callInput(event.rawInput),
    };
    return [...items, tool];
  }
  if (event.type !== "tool_call_update") return items;
  return items.map((item) => {
    if (item.kind !== "tool" || item.id !== event.toolCallId) return item;
    const next: ToolItem = { ...item, title: event.title ?? item.title };
    if (event.rawInput !== undefined) next.input = callInput(event.rawInput);
    if (event.content) Object.assign(next, toolOutput(event.content, imageUrl));
    if (event.status === "completed") next.status = "done";
    if (event.status === "failed") next.status = "failed";
    return next;
  });
}

/** The tool's input as the chat shows it: a script as itself, anything else as JSON. */
export function toolInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  if ("code" in input && typeof input.code === "string") return input.code;
  if (Object.keys(input).length === 0) return null;
  return JSON.stringify(input, null, 2);
}

/** One thing a tool changed, as a row the chat draws and a click reveals in the sidebar. */
export interface ChangeRow {
  opId: string;
  op: string;
  /** Null for a row about the whole op: added, removed, its mask. */
  param: string | null;
  /** "Highlights", "Layer". */
  title: string;
  /** "0 → −80", "added". */
  detail: string;
}

/** Every op each step touched, one row per parameter that moved. */
export function changeRows(steps: HistoryStep[], ops: OpDefinition[]): ChangeRow[] {
  return entriesOf(steps).flatMap((entry) => entryRows(entry, ops));
}

/**
 * A whole turn's edits as one list: each parameter once, from where the turn found it to
 * where it left it, and nothing for one that ended where it started. An agent nudges the
 * same slider three times; the user wants to know where it went.
 */
export function netChangeRows(steps: HistoryStep[], ops: OpDefinition[]): ChangeRow[] {
  const merged = new Map<string, HistoryEntry>();
  for (const entry of entriesOf(steps)) mergeEntry(merged, entry);
  return [...merged.values()]
    .filter((entry) => entry.changes?.some((change) => change.from !== change.to) ?? true)
    .flatMap((entry) => entryRows(entry, ops));
}

function entriesOf(steps: HistoryStep[]): (HistoryEntry | HistoryStep)[] {
  return steps.flatMap((step): (HistoryEntry | HistoryStep)[] =>
    step.kind === "batch" ? (step.entries ?? []) : [step],
  );
}

/** Keyed by op and parameter; a later change keeps the first one's `from`. */
function mergeEntry(merged: Map<string, HistoryEntry>, entry: HistoryEntry | HistoryStep): void {
  const { op, opId, kind } = entry;
  // Only an op's own steps: `initial`, `reorder` and `batch` carry no op (a batch arrives
  // here already unfolded).
  if (!op || !opId || kind === "initial" || kind === "reorder" || kind === "batch") return;
  if (kind !== "update") {
    merged.set(`${opId}#${kind}`, { kind, op, opId });
    return;
  }
  for (const change of entry.changes ?? []) {
    const key = `${opId}.${change.param}`;
    const first = merged.get(key)?.changes?.[0] ?? change;
    merged.set(key, {
      kind: "update",
      op,
      opId,
      changes: [{ param: change.param, from: first.from, to: change.to }],
    });
  }
}

function entryRows(entry: HistoryEntry | HistoryStep, ops: OpDefinition[]): ChangeRow[] {
  // `initial` and `reorder` are about the stack, not an op.
  const { op, opId } = entry;
  if (!op || !opId) return [];
  const definition = ops.find((candidate) => candidate.name === op);
  const opLabel = op === "group" ? "Layer" : (definition?.label ?? op);
  const about = { opId, op, param: null, title: opLabel };
  if (entry.kind === "add") return [{ ...about, detail: "added" }];
  if (entry.kind === "remove") return [{ ...about, detail: "removed" }];
  if (entry.kind === "mask") return [{ ...about, detail: "mask changed" }];
  return (entry.changes ?? []).map((change) => {
    const spec = definition?.params.find((candidate) => candidate.name === change.param);
    return {
      opId,
      op,
      param: change.param,
      title: definition && spec ? rowLabel(definition, spec) : `${opLabel} ${change.param}`,
      detail: changeDetail(change, spec),
    };
  });
}

function changeDetail(change: HistoryChange, spec: OpParamSpec | undefined): string {
  // Neither side survived the wire: a curve's point list.
  if (change.from === undefined && change.to === undefined) return "changed";
  return `${formatSide(sideValue(change.from, spec), spec)} → ${formatSide(sideValue(change.to, spec), spec)}`;
}

/** A side the engine left off is the parameter's default: the op did not hold it. */
function sideValue(
  value: HistoryChange["from"],
  spec: OpParamSpec | undefined,
): HistoryChange["from"] {
  if (value !== undefined) return value;
  const fallback = spec?.default;
  if (typeof fallback === "number" || typeof fallback === "string") return fallback;
  if (typeof fallback === "boolean") return fallback;
  return undefined;
}

/**
 * Between the chat and the selection it is about. Not against the panels: the safe area
 * already ends in the shell's gutter, the same gap every floating card keeps.
 */
const SELECTION_GAP = 8;

/**
 * Where the chat card goes: under the selection when it fits, above it when it does not,
 * kept inside the part of the viewer the floating panels leave free. All in the overlay's
 * CSS pixels.
 */
export function chatPosition(
  selection: { left: number; top: number; right: number; bottom: number },
  chat: { width: number; height: number },
  viewer: { width: number; height: number },
  safeArea: SafeArea,
): { left: number; top: number } {
  const below = selection.bottom + SELECTION_GAP;
  const fitsBelow = below + chat.height <= viewer.height - safeArea.bottom;
  const top = fitsBelow ? below : selection.top - SELECTION_GAP - chat.height;
  return placedPosition({ left: selection.left, top }, chat, viewer, safeArea);
}

/** A share of the free area, within the widths a chat still reads well at. */
export function chatWidth(viewer: { width: number }, safeArea: SafeArea): number {
  const free = viewer.width - safeArea.left - safeArea.right;
  const wanted = Math.min(640, Math.max(380, free * 0.45));
  return Math.round(Math.max(0, Math.min(free, wanted)));
}

/** How tall the conversation may grow before it scrolls: most of the free height. */
export function transcriptHeight(viewer: { height: number }, safeArea: SafeArea): number {
  // What the input, its toolbar and the gaps take below the conversation.
  const composer = 200;
  return Math.max(160, viewer.height - safeArea.top - safeArea.bottom - composer);
}

/** Where a chat the user dragged sits: where it was dropped, kept inside the free area. */
export function placedPosition(
  placed: { left: number; top: number },
  chat: { width: number; height: number },
  viewer: { width: number; height: number },
  safeArea: SafeArea,
): { left: number; top: number } {
  const minimumLeft = safeArea.left;
  const minimumTop = safeArea.top;
  const maximumLeft = Math.max(minimumLeft, viewer.width - safeArea.right - chat.width);
  const maximumTop = Math.max(minimumTop, viewer.height - safeArea.bottom - chat.height);
  return {
    left: Math.min(maximumLeft, Math.max(minimumLeft, placed.left)),
    top: Math.min(maximumTop, Math.max(minimumTop, placed.top)),
  };
}

export const PLACEMENT_KEY = "latent.assistant.placement.v1";

export function loadPlacement(
  storage: Pick<Storage, "getItem">,
): { left: number; top: number } | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PLACEMENT_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("left" in parsed) || !("top" in parsed)) return null;
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
    return { left: parsed.left, top: parsed.top };
  } catch {
    return null;
  }
}

/** A whole-photo chat has nothing to sit next to: it docks at the bottom, centred in the free area. */
export function dockedPosition(
  chat: { width: number; height: number },
  viewer: { width: number; height: number },
  safeArea: SafeArea,
): { left: number; top: number } {
  const free = viewer.width - safeArea.left - safeArea.right;
  const centred = { left: safeArea.left + (free - chat.width) / 2, top: viewer.height };
  return placedPosition(centred, chat, viewer, safeArea);
}

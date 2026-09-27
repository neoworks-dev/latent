// Pure assistant logic: the selection box, what the agent is told, which of its tool calls
// need the user, and how the harness's event stream becomes a chat transcript. No engine,
// no sidecar, no DOM.
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
import type { Effort, HarnessId, SessionUpdate } from "@neoworks/harness/client";

/** `[x0, y0, x1, y1]`, 0..1 over the uncropped photo — the space masks are stored in. */
export type Box = [number, number, number, number];
export type Point = [number, number];
/** What the chat is about: a box on the photo, or all of it. */
export type Target = Box | "photo";

/** The rail mode the assistant's column lives on. */
export const ASSISTANT_MODE = "assistant";

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "pi",
};

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

export interface AssistantSettings {
  harness: HarnessId;
  /** Empty for the harness's own default. */
  model: string;
  /** Empty for the harness's own default. */
  effort: Effort | "";
}

export const SETTINGS_KEY = "latent.assistant.v1";

const DEFAULT_SETTINGS: AssistantSettings = { harness: "claude", model: "", effort: "" };

export function loadSettings(storage: Pick<Storage, "getItem">): AssistantSettings {
  const stored = storage.getItem(SETTINGS_KEY);
  if (!stored) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    // Written by this build or an older one; each field is kept only if it still makes sense.
    const entry = parsed as Partial<Record<keyof AssistantSettings, unknown>>;
    return {
      harness: isHarness(entry.harness) ? entry.harness : DEFAULT_SETTINGS.harness,
      model: typeof entry.model === "string" ? entry.model : DEFAULT_SETTINGS.model,
      effort: isEffort(entry.effort) ? entry.effort : DEFAULT_SETTINGS.effort,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function isHarness(value: unknown): value is HarnessId {
  return typeof value === "string" && Object.hasOwn(HARNESS_LABELS, value);
}

/** Every `Effort` the harness accepts, labelled for the picker. */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultracode: "Ultracode",
};

function isEffort(value: unknown): value is Effort | "" {
  return typeof value === "string" && (value === "" || Object.hasOwn(EFFORT_LABELS, value));
}

export function saveSettings(storage: Pick<Storage, "setItem">, settings: AssistantSettings): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** One photo's conversation: the harness session to resume and what the chat showed. */
export interface Conversation {
  sessionId: string;
  harness: HarnessId;
  items: TranscriptItem[];
  costUsd: number | null;
}

export const CONVERSATIONS_KEY = "latent.assistant.conversations.v1";

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

/**
 * Replaces the harness's own system prompt entirely: this agent edits one photo through
 * Latent's MCP server and has no shell and no files, so a coding agent's instructions
 * would only cost tokens and mislead it.
 */
export const SYSTEM_PROMPT = `You edit a photo in Latent, a raw photo editor, through its MCP tools. The user says what to change, either in a region they selected or across the whole photo.

- The edits are an ordered op-stack. Read it with get_stack. Change it only with run_python, against the \`latent\` module. Every run_python call carries an \`explanation\`: one plain sentence the user reads instead of your code, saying what the script does and why. Look at the result with render_preview; pass mask=["<op id>"] to see a layer's mask.
- A <selection> with a box is a region in image space: [x0, y0, x1, y1], 0..1 over the uncropped photo, the space masks use. whole_photo="true" means the request is about the entire photo.
- A whole-photo change goes on the stack directly: \`latent.photo.stack.add("vibrance", value=20)\`, or the develop settings: \`latent.photo.develop.exposure = 0.3\`.
- A local change is one layer: \`layer = latent.photo.stack.group()\`, a mask on it, adjustments inside it. Mask the selected thing with \`cid = layer.mask.add("objects", box=[x0, y0, x1, y1])\` then \`latent.photo.masks.detect(layer.id, cid)\`, or name it: \`layer.mask.add("text", prompt="dragon")\` and detect. Then add adjustments: \`layer.add("exposure", value=-0.6)\`. Op names and ranges follow Lightroom: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, texture, clarity, dehaze.
- Adding, replacing or removing content is generative: generative_fill (repaint from a prompt) and generative_remove (erase). Call generative_status first; if ComfyUI is not running, say so instead of trying. For a named thing pass select="the cat". For the selected box, make the op yourself with run_python — \`op = latent.photo.stack.add("generative_fill", prompt="...", seed=0, model="")\` (or "remove" without a prompt), \`cid = op.mask.add("objects", box=[...])\`, \`latent.photo.masks.detect(op.id, cid)\` — once the component is ready, call the tool with op_id.
- Mask detection, generative fill and remove, and depth estimates run as background jobs. Never poll for them. Once you have started one, end your turn with one short sentence saying what you are waiting for. When every job has finished you get a message <jobs_finished>…</jobs_finished> saying how each went; carry on from there.
- Images attached after the selection are references from the user (a look to match, an object to add), not the photo being edited.
- Every write is an undo step the user sees. Keep one request in one layer, and adjust it rather than stacking new ones.
- Do not export, merge, or touch other photos unless asked.
- For tone — exposure, contrast, clipping, "too dark", "blown out" — read get_histogram before and after: its zones map onto the blacks, shadows, exposure, highlights and whites ops.
- render_preview takes region=[x0, y0, x1, y1] in the selection's image space and renders it from the full-resolution photo. Zoom in to judge detail, noise or an edge, and to compare a part of the photo side by side with a reference image.
- Check the result with render_preview before you answer. Answer in one or two short sentences.`;

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
};

/**
 * What a tool row is called: the agent's own explanation of a script, else the Latent
 * tool's label, else the harness's title.
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

/** They write files or new photos; everything else is a read or an undoable edit. */
const ASKS_FIRST = new Set(["export", "merge_hdr", "merge_panorama", "merge_star_trail"]);

/**
 * The Latent tool a permission request is about. Harnesses title an MCP call differently —
 * `mcp__latent__export`, `latent.export`, `export (latent)` — so look for the name as a
 * whole token.
 */
export function latentToolName(title: string): string | null {
  for (const token of title.split(/[^a-z0-9_]+/i)) {
    const name = token.split("__").at(-1) ?? "";
    if (Object.hasOwn(TOOL_LABELS, name)) return name;
  }
  return null;
}

/** Whether the user is asked before this call runs. Unknown tools always ask. */
export function asksFirst(title: string): boolean {
  const name = latentToolName(title);
  if (name === null) return true;
  return ASKS_FIRST.has(name);
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

type ToolCallContent = NonNullable<
  Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]
>;

/** The text and the last image of a tool's answer. */
function toolOutput(content: ToolCallContent): Pick<ToolItem, "output" | "image"> {
  const texts: string[] = [];
  let image: string | undefined;
  for (const entry of content) {
    if (entry.type !== "content") continue;
    const block = entry.content;
    if (block.type === "text") texts.push(block.text);
    if (block.type === "image") image = `data:${block.mimeType};base64,${block.data}`;
  }
  return { output: texts.length > 0 ? texts.join("\n") : undefined, image };
}

/** One `session/update` folded into the transcript; text chunks join the reply they belong to. */
export function applyUpdate(items: TranscriptItem[], update: SessionUpdate): TranscriptItem[] {
  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type !== "text") return items;
    const last = items.at(-1);
    if (last?.kind === "assistant") {
      return [...items.slice(0, -1), { kind: "assistant", text: last.text + update.content.text }];
    }
    return [...items, { kind: "assistant", text: update.content.text }];
  }
  if (update.sessionUpdate === "tool_call") {
    return [
      ...items,
      {
        kind: "tool",
        id: update.toolCallId,
        title: update.title,
        status: "running",
        input: update.rawInput,
      },
    ];
  }
  if (update.sessionUpdate !== "tool_call_update") return items;
  return items.map((item) => {
    if (item.kind !== "tool" || item.id !== update.toolCallId) return item;
    const next: ToolItem = { ...item, title: update.title ?? item.title };
    if (update.rawInput !== undefined) next.input = update.rawInput;
    if (update.content) Object.assign(next, toolOutput(update.content));
    if (update.status === "completed") next.status = "done";
    if (update.status === "failed") next.status = "failed";
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

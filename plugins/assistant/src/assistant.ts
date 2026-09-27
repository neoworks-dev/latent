// Pure assistant logic: the selection box, what the agent is told, which of its tool calls
// need the user, and how the harness's event stream becomes a chat transcript. No engine,
// no sidecar, no DOM.
// Before @latent/contracts on purpose: this is the first file tsc checks, and when the
// contracts load before the kernel does, their `Context` augmentation (engine, panes,
// viewer, …) does not take and index.ts fails to typecheck.
import type {} from "@neoworks/extension-system";
import type { SafeArea } from "@latent/contracts";
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

const EFFORTS: readonly string[] = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] satisfies (Effort | "")[];

function isEffort(value: unknown): value is Effort | "" {
  return typeof value === "string" && EFFORTS.includes(value);
}

export function saveSettings(storage: Pick<Storage, "setItem">, settings: AssistantSettings): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Replaces the harness's own system prompt entirely: this agent edits one photo through
 * Latent's MCP server and has no shell and no files, so a coding agent's instructions
 * would only cost tokens and mislead it.
 */
export const SYSTEM_PROMPT = `You edit a photo in Latent, a raw photo editor, through its MCP tools. The user says what to change, either in a region they selected or across the whole photo.

- The edits are an ordered op-stack. Read it with get_stack. Change it only with run_python, against the \`latent\` module. Look at the result with render_preview; pass mask=["<op id>"] to see a layer's mask.
- A <selection> with a box is a region in image space: [x0, y0, x1, y1], 0..1 over the uncropped photo, the space masks use. whole_photo="true" means the request is about the entire photo.
- A whole-photo change goes on the stack directly: \`latent.photo.stack.add("vibrance", value=20)\`, or the develop settings: \`latent.photo.develop.exposure = 0.3\`.
- A local change is one layer: \`layer = latent.photo.stack.group()\`, a mask on it, adjustments inside it. Mask the selected thing with \`cid = layer.mask.add("objects", box=[x0, y0, x1, y1])\` then \`latent.photo.masks.detect(layer.id, cid)\`, or name it: \`layer.mask.add("text", prompt="dragon")\` and detect. Detection runs as a job: poll get_stack until the component is "ready". Then add adjustments: \`layer.add("exposure", value=-0.6)\`. Op names and ranges follow Lightroom: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, texture, clarity, dehaze.
- Adding, replacing or removing content is generative: generative_fill (repaint from a prompt) and generative_remove (erase). Call generative_status first; if ComfyUI is not running, say so instead of trying. For a named thing pass select="the cat". For the selected box, make the op yourself with run_python — \`op = latent.photo.stack.add("generative_fill", prompt="...", seed=0, model="")\` (or "remove" without a prompt), \`cid = op.mask.add("objects", box=[...])\`, \`latent.photo.masks.detect(op.id, cid)\` — wait until the component is ready, then call the tool with op_id. A fill runs as a job: poll get_stack until it has finished.
- Images attached after the selection are references from the user (a look to match, an object to add), not the photo being edited.
- Every write is an undo step the user sees. Keep one request in one layer, and adjust it rather than stacking new ones.
- Do not export, merge, or touch other photos unless asked.
- Check the result with render_preview before you answer. Answer in one or two short sentences.`;

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

/** The engine's MCP tools, as named in engine/python/latent/mcp_server.py. */
const LATENT_TOOLS = new Set([
  "run_python",
  "get_stack",
  "render_preview",
  "list_photos",
  "generative_fill",
  "generative_remove",
  "generative_status",
  "export",
  "merge_hdr",
  "merge_panorama",
  "merge_star_trail",
  "merge_preview",
]);

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
    if (LATENT_TOOLS.has(name)) return name;
  }
  return null;
}

/** Whether the user is asked before this call runs. Unknown tools always ask. */
export function asksFirst(title: string): boolean {
  const name = latentToolName(title);
  if (name === null) return true;
  return ASKS_FIRST.has(name);
}

export type TranscriptItem =
  | { kind: "user"; text: string; images?: string[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; title: string; status: "running" | "done" | "failed" }
  | { kind: "note"; text: string; tone: "muted" | "error" };

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
      { kind: "tool", id: update.toolCallId, title: update.title, status: "running" },
    ];
  }
  if (update.sessionUpdate !== "tool_call_update") return items;
  return items.map((item) => {
    if (item.kind !== "tool" || item.id !== update.toolCallId) return item;
    const title = update.title ?? item.title;
    if (update.status === "completed") return { ...item, title, status: "done" };
    if (update.status === "failed") return { ...item, title, status: "failed" };
    return { ...item, title };
  });
}

const CHAT_GAP = 8;

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
  const minimumLeft = safeArea.left + CHAT_GAP;
  const maximumLeft = Math.max(minimumLeft, viewer.width - safeArea.right - chat.width - CHAT_GAP);
  const left = Math.min(maximumLeft, Math.max(minimumLeft, selection.left));
  const below = selection.bottom + CHAT_GAP;
  const maximumTop = viewer.height - safeArea.bottom - chat.height - CHAT_GAP;
  if (below <= maximumTop) return { left, top: below };
  const above = selection.top - CHAT_GAP - chat.height;
  return { left, top: Math.max(safeArea.top + CHAT_GAP, Math.min(maximumTop, above)) };
}

/** A whole-photo chat has nothing to sit next to: it docks at the bottom, centred in the free area. */
export function dockedPosition(
  chat: { width: number; height: number },
  viewer: { width: number; height: number },
  safeArea: SafeArea,
): { left: number; top: number } {
  const free = viewer.width - safeArea.left - safeArea.right;
  const left = Math.max(safeArea.left + CHAT_GAP, safeArea.left + (free - chat.width) / 2);
  const top = Math.max(
    safeArea.top + CHAT_GAP,
    viewer.height - safeArea.bottom - chat.height - CHAT_GAP,
  );
  return { left, top };
}

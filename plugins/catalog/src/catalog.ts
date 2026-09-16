// Pure catalog logic: the engine's rows in, what the panes draw out. No engine calls, no
// DOM — everything here is unit-tested directly.
import type {
  CatalogListParams,
  CatalogFoldersResult,
  CatalogPhoto,
  JobProgressParams,
  PhotoFlag,
} from "@latent/protocol";

export interface FolderNode {
  /** Absolute path, the value `catalog.list { folder }` expects. */
  path: string;
  /** What the row shows: one segment, or a collapsed run of them. */
  label: string;
  depth: number;
  /** Photos in this folder and everything under it. */
  count: number;
}

interface TrieNode {
  path: string;
  label: string;
  count: number;
  children: Map<string, TrieNode>;
}

/**
 * Folder rows grouped into a tree by path prefix, with counts rolled up. A run of
 * directories that adds nothing — one child, same count — collapses into one row, so an
 * import of `/home/me/Pictures/trip` is not five levels of indentation.
 */
export function folderTree(folders: CatalogFoldersResult["folders"]): FolderNode[] {
  const root: TrieNode = { path: "", label: "", count: 0, children: new Map() };
  for (const folder of folders) {
    let node = root;
    for (const segment of folder.path.split("/").filter(Boolean)) {
      const existing = node.children.get(segment);
      const child = existing ?? {
        path: `${node.path}/${segment}`,
        label: segment,
        count: 0,
        children: new Map(),
      };
      if (!existing) node.children.set(segment, child);
      child.count += folder.count;
      node = child;
    }
  }

  const rows: FolderNode[] = [];
  const emit = (node: TrieNode, depth: number): void => {
    let collapsed = node;
    let label = node.label;
    while (collapsed.children.size === 1) {
      const [only] = [...collapsed.children.values()];
      if (!only || only.count !== collapsed.count) break;
      label = `${label}/${only.label}`;
      collapsed = only;
    }
    rows.push({ path: collapsed.path, label, depth, count: collapsed.count });
    const children = [...collapsed.children.values()].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    for (const child of children) emit(child, depth + 1);
  };
  for (const child of [...root.children.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    emit(child, 0);
  }
  return rows;
}

export interface FolderRow {
  node: FolderNode;
  /** A row the chevron can fold; leaves get no chevron at all. */
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * The folder rows a collapsed tree actually shows. `folderTree` is flat with a depth per
 * row, so a row is hidden when any shallower row above it is collapsed — the first row
 * whose depth is not deeper than a collapsed ancestor ends that ancestor's run.
 */
export function folderRows(nodes: FolderNode[], collapsed: Iterable<string>): FolderRow[] {
  const folded = new Set(collapsed);
  const rows: FolderRow[] = [];
  let hiddenBelow: number | null = null;
  for (const [index, node] of nodes.entries()) {
    if (hiddenBelow !== null && node.depth > hiddenBelow) continue;
    hiddenBelow = null;
    const next = nodes[index + 1];
    const hasChildren = next !== undefined && next.depth > node.depth;
    const expanded = hasChildren && !folded.has(node.path);
    if (hasChildren && !expanded) hiddenBelow = node.depth;
    rows.push({ node, hasChildren, expanded });
  }
  return rows;
}

export type SortKey = NonNullable<CatalogListParams["sort"]>;

/** The sort keys `catalog.list` accepts, in the order the menu offers them. */
export const sortOptions: { value: SortKey; label: string }[] = [
  { value: "capturedAt", label: "Capture time" },
  { value: "importedAt", label: "Import time" },
  { value: "editedAt", label: "Edited" },
  { value: "filename", label: "File name" },
  { value: "rating", label: "Rating" },
];

/** The design system's Select answers with a bare string; this is the narrowing. */
export function isSortKey(value: string): value is SortKey {
  return sortOptions.some((option) => option.value === value);
}

export const gridSizeRange = { min: 96, max: 320, step: 8 };

export function clampGridSize(size: number): number {
  if (!Number.isFinite(size)) return gridSizeRange.min;
  return Math.min(gridSizeRange.max, Math.max(gridSizeRange.min, Math.round(size)));
}

/** Grid columns for a cell size: as many as fit, then share the remainder evenly. */
export function gridTemplate(size: number): string {
  return `repeat(auto-fill, minmax(${clampGridSize(size)}px, 1fr))`;
}

export interface InfoRow {
  label: string;
  value: string;
  /** The full text when `value` is a shortened form of it; the row's tooltip. */
  title?: string;
}

function exposureSummary(photo: CatalogPhoto): string {
  const parts: string[] = [];
  if (photo.shutter) parts.push(`${photo.shutter} s`);
  if (photo.aperture !== undefined) parts.push(`ƒ/${photo.aperture}`);
  if (photo.iso !== undefined) parts.push(`ISO ${photo.iso}`);
  if (photo.focalLength !== undefined) parts.push(`${photo.focalLength} mm`);
  return parts.join(" · ");
}

/** ISO 8601 from the engine, shown the way a capture time is read. */
function timestamp(value: string | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const flagNames: Record<PhotoFlag, string> = {
  none: "Unflagged",
  pick: "Pick",
  reject: "Reject",
};

/** What the Info pane lists for the open photo — one catalog row, no second source. */
export function infoRows(photo: CatalogPhoto): InfoRow[] {
  const rows: InfoRow[] = [
    { label: "Camera", value: photo.camera },
    { label: "Lens", value: photo.lens ?? "—" },
    { label: "Exposure", value: exposureSummary(photo) || "—" },
    { label: "Captured", value: timestamp(photo.capturedAt) },
    { label: "Imported", value: timestamp(photo.importedAt) },
    { label: "Edited", value: timestamp(photo.editedAt) },
    { label: "Size", value: `${photo.width} × ${photo.height}` },
    { label: "Rating", value: photo.rating === 0 ? "—" : "★".repeat(photo.rating) },
    { label: "Flag", value: flagNames[photo.flag] },
    { label: "Folder", value: photo.folder },
    { label: "Sidecar", value: photo.hasSidecar ? "written" : "none" },
  ];
  // The engine hashes a file after it has registered the row, so a freshly imported photo
  // has none yet — then the pane is short one row, not showing a row that says "no hash".
  if (photo.hash) {
    rows.push({ label: "Hash", value: photo.hash.slice(0, 12), title: photo.hash });
  }
  return rows;
}

export interface CatalogFilter {
  folder?: string;
  collectionId?: number;
  flag?: PhotoFlag;
  minRating?: number;
  /** Case-insensitive substring over filename and camera; the engine does the matching. */
  query?: string;
}

const flagLabels: Record<PhotoFlag, string> = {
  none: "Unflagged",
  pick: "Picks",
  reject: "Rejects",
};

/** What the filmstrip header says it is showing. */
export function filterLabel(filter: CatalogFilter, collectionName?: string): string {
  if (filter.query) return `“${filter.query}”`;
  if (filter.collectionId !== undefined)
    return collectionName ?? `Collection ${filter.collectionId}`;
  if (filter.folder !== undefined) return filter.folder.split("/").filter(Boolean).at(-1) ?? "/";
  if (filter.flag !== undefined) return flagLabels[filter.flag];
  if (filter.minRating !== undefined) return `${filter.minRating}★ and up`;
  return "All photos";
}

export type CatalogAction =
  | { kind: "move"; delta: number }
  | { kind: "edge"; edge: "first" | "last" }
  | { kind: "rating"; rating: number }
  | { kind: "flag"; flag: PhotoFlag }
  | { kind: "grid" }
  | { kind: "open" }
  | { kind: "remove" };

/**
 * The parts of a keyboard event the mapping needs. Structural rather than DOM types, so
 * the mapping is testable without a document; an `HTMLElement` satisfies `KeyEventTarget`.
 */
export interface KeyEventTarget {
  tagName: string;
  isContentEditable: boolean;
}

export interface CatalogKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: KeyEventTarget | null;
}

/** A shortcut must never steal a keystroke from a text field — the console has one. */
export function isTypingTarget(target: KeyEventTarget | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Lightroom's library keys: arrows walk the filmstrip, Home/End jump to its ends, 0–5
 * rate, P/X/U flag, G toggles the grid, Enter opens the selected photo, Delete takes the
 * selection out of the catalog (the files stay). Modified keystrokes belong to someone
 * else (Ctrl+Z is history, Ctrl+` is the console); Backspace is not a remove, because it
 * is one fat finger away from the arrow keys.
 */
export function catalogShortcut(event: CatalogKeyEvent): CatalogAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") return { kind: "move", delta: 1 };
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") return { kind: "move", delta: -1 };
  if (event.key === "Home") return { kind: "edge", edge: "first" };
  if (event.key === "End") return { kind: "edge", edge: "last" };
  if (event.key === "Enter") return { kind: "open" };
  if (event.key === "Delete") return { kind: "remove" };
  if (/^[0-5]$/.test(event.key)) return { kind: "rating", rating: Number(event.key) };
  const key = event.key.toLowerCase();
  if (key === "p") return { kind: "flag", flag: "pick" };
  if (key === "x") return { kind: "flag", flag: "reject" };
  if (key === "u") return { kind: "flag", flag: "none" };
  if (key === "g") return { kind: "grid" };
  return null;
}

export interface SelectionModifiers {
  shift: boolean;
  ctrl: boolean;
}

/**
 * Click semantics over the visible page: plain click replaces the selection, Ctrl toggles
 * one photo, Shift takes the run from the anchor to the clicked photo.
 */
export function nextSelection(
  visible: number[],
  selection: number[],
  anchor: number | null,
  photoId: number,
  modifiers: SelectionModifiers,
): number[] {
  if (modifiers.ctrl) {
    if (selection.includes(photoId)) return selection.filter((entry) => entry !== photoId);
    return [...selection, photoId];
  }
  if (!modifiers.shift) return [photoId];
  const from = visible.indexOf(anchor ?? photoId);
  const to = visible.indexOf(photoId);
  if (from < 0 || to < 0) return [photoId];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return visible.slice(start, end + 1);
}

/** What the thumbnail cache needs off a row: the file it is, and the row it came in as. */
export interface ThumbnailTarget {
  photoId: number;
  /** SHA-256 of the raw file; absent until the engine has hashed it. */
  hash?: string;
}

/**
 * The cache key for a photo's thumbnail. The hash identifies the *file*, so re-importing
 * one the catalog already had — a new row with a new photoId — draws the thumbnail the UI
 * is already holding instead of asking for the same JPEG again. An import registers a row
 * before hashing it, so a row without a hash yet falls back to its id.
 */
export function thumbnailKey(photo: ThumbnailTarget): string {
  if (photo.hash) return `hash:${photo.hash}`;
  return `photo:${photo.photoId}`;
}

/**
 * The photos of a page whose thumbnail the UI neither has nor has already asked for. The
 * filmstrip feeds this to one `catalog.thumbnails` call per page change — never one call
 * per cell, and never a second call for a page it is already waiting on. `known` is cache
 * keys, so two rows of the same file are one request.
 */
export function missingThumbnails<T extends ThumbnailTarget>(
  visible: T[],
  known: Iterable<string>,
): T[] {
  const have = new Set(known);
  const wanted: T[] = [];
  for (const photo of visible) {
    const key = thumbnailKey(photo);
    if (have.has(key)) continue;
    have.add(key);
    wanted.push(photo);
  }
  return wanted;
}

export type JobState = NonNullable<JobProgressParams["state"]>;

/** One badge in the status line: an import and the thumbnail job it queued behind itself. */
export interface JobGroup {
  /** The parent's jobId — the group's key, and what its children point at. */
  jobId: number;
  /** The whole group on one line: `imported 12 photos · thumbnails 7/12`. */
  label: string;
  /** `running` while anything in the group is; the worst finished state otherwise. */
  state: JobState;
  /** What Cancel stops: the first job still going, parent before child. */
  cancelJobId: number | null;
}

/** A job's own state, for an engine that leaves the optional field out. */
function jobState(job: JobProgressParams): JobState {
  if (job.state) return job.state;
  return job.finished ? "done" : "running";
}

/** A job's share of the line: counts while it runs, the engine's own words once it ends. */
function jobLabel(job: JobProgressParams): string {
  if (!job.finished) return `${job.kind} ${job.done}/${job.total}`;
  return job.message ?? `${job.kind} ${jobState(job)}`;
}

/**
 * The status line's badges. A thumbnail job carries `parentJobId`, so it belongs under the
 * import that spawned it rather than beside it as a second, unexplained bar: one badge,
 * both counts, and one line once the pair has finished. A child whose parent is not here —
 * never seen, or already aged out — is a badge of its own rather than nothing.
 */
export function jobGroups(jobs: JobProgressParams[]): JobGroup[] {
  const present = new Set(jobs.map((job) => job.jobId));
  const groups: JobGroup[] = [];
  for (const job of jobs) {
    if (job.parentJobId !== undefined && present.has(job.parentJobId)) continue;
    const members = [job, ...jobs.filter((entry) => entry.parentJobId === job.jobId)];
    const running = members.find((member) => !member.finished);
    groups.push({
      jobId: job.jobId,
      label: members.map(jobLabel).join(" · "),
      state: groupState(members, running !== undefined),
      cancelJobId: running?.jobId ?? null,
    });
  }
  return groups;
}

/** Cancelling the import cancels the badge, but only once nothing in it is still going. */
function groupState(members: JobProgressParams[], running: boolean): JobState {
  if (running) return "running";
  const states = members.map(jobState);
  if (states.includes("error")) return "error";
  if (states.includes("cancelled")) return "cancelled";
  return "done";
}

/** Where an arrow key lands: one step from the last selected photo, clamped to the page. */
export function movedSelection(
  visible: number[],
  selection: number[],
  delta: number,
): number | null {
  if (visible.length === 0) return null;
  const current = selection.at(-1);
  if (current === undefined) return visible[0] ?? null;
  const index = visible.indexOf(current);
  if (index < 0) return visible[0] ?? null;
  const next = Math.min(visible.length - 1, Math.max(0, index + delta));
  return visible[next] ?? null;
}

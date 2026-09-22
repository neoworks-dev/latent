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
  /**
   * Every folder under this row is watched, so photos dropped anywhere in it turn up on
   * their own. A branch with one unwatched folder in it is not watched: the row would
   * otherwise promise freshness it cannot keep.
   */
  watched: boolean;
}

interface TrieNode {
  path: string;
  label: string;
  count: number;
  watched: boolean;
  children: Map<string, TrieNode>;
}

/**
 * Folder rows grouped into a tree by path prefix, with counts rolled up. A run of
 * directories that adds nothing — one child, same count — collapses into one row, so an
 * import of `/home/me/Pictures/trip` is not five levels of indentation.
 */
export function folderTree(folders: CatalogFoldersResult["folders"]): FolderNode[] {
  const root: TrieNode = { path: "", label: "", count: 0, watched: true, children: new Map() };
  for (const folder of folders) {
    let node = root;
    for (const segment of folder.path.split("/").filter(Boolean)) {
      const existing = node.children.get(segment);
      const child = existing ?? {
        path: `${node.path}/${segment}`,
        label: segment,
        count: 0,
        watched: true,
        children: new Map(),
      };
      if (!existing) node.children.set(segment, child);
      child.count += folder.count;
      child.watched = child.watched && folder.watched;
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
    rows.push({
      path: collapsed.path,
      label,
      depth,
      count: collapsed.count,
      watched: collapsed.watched,
    });
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

/** The slider is the row height the grid aims for, not a cell width. */
export const gridSizeRange = { min: 96, max: 320, step: 8 };

/** Pixels between cells, both axes. Must match the `gap` the grid pane draws. */
export const gridGap = 8;

/**
 * Widest and tallest cell the grid will lay out, as a width:height ratio. A 6:1 panorama
 * left unclamped is a row on its own, three pixels tall.
 */
export const gridAspectLimit = 3;

export function clampGridSize(size: number): number {
  if (!Number.isFinite(size)) return gridSizeRange.min;
  return Math.min(gridSizeRange.max, Math.max(gridSizeRange.min, Math.round(size)));
}

export interface GridCell {
  photo: CatalogPhoto;
  width: number;
}

export interface GridRow {
  /** Distance from the top of the grid's content box: the grid positions rows absolutely. */
  top: number;
  height: number;
  cells: GridCell[];
}

/**
 * Height of a section title. Baked in rather than measured because the layout runs for the
 * whole catalog, most of which is nowhere near the screen and has no box to measure. The
 * title element is drawn at exactly this height so the two cannot drift apart.
 */
export const gridHeaderHeight = 32;

/** The aspect a cell gets: the photo's own, clamped so one frame can't flatten a row. */
export function cellAspect(photo: CatalogPhoto): number {
  if (photo.width <= 0 || photo.height <= 0) return 1;
  const aspect = photo.width / photo.height;
  return Math.min(gridAspectLimit, Math.max(1 / gridAspectLimit, aspect));
}

function packRow(run: CatalogPhoto[], top: number, height: number): GridRow {
  return {
    top,
    height: Math.round(height),
    cells: run.map((photo) => ({ photo, width: Math.round(cellAspect(photo) * height) })),
  };
}

/**
 * Lightroom's justified grid: fill each row across `containerWidth` at one shared height
 * near `targetHeight`, so every cell keeps its own aspect and the reading order stays
 * left-to-right, top-to-bottom. A trailing part-row is left at the target height rather
 * than stretched across the pane. `startTop` is where the first row's top edge lands, so a
 * section can lay its rows out in the coordinates the whole grid scrolls through.
 */
export function justifyRows(
  photos: CatalogPhoto[],
  containerWidth: number,
  targetHeight: number,
  startTop = 0,
): GridRow[] {
  if (containerWidth <= 0) return [];
  const target = clampGridSize(targetHeight);
  const rows: GridRow[] = [];
  let run: CatalogPhoto[] = [];
  let aspectSum = 0;
  let top = startTop;

  for (const photo of photos) {
    run.push(photo);
    aspectSum += cellAspect(photo);
    const spare = containerWidth - gridGap * (run.length - 1);
    if (aspectSum * target < spare) continue;
    const row = packRow(run, top, spare / aspectSum);
    // Rounding every width down leaves a pixel or two at the right edge; the last cell
    // takes them, so the row ends flush with the pane.
    const total = row.cells.reduce((sum, cell) => sum + cell.width, 0);
    row.cells[row.cells.length - 1].width += spare - total;
    rows.push(row);
    top += row.height + gridGap;
    run = [];
    aspectSum = 0;
  }

  if (run.length > 0) rows.push(packRow(run, top, target));
  return rows;
}

export interface GridSection {
  /** The run's first photo; the `each` key, since a date can repeat under another sort. */
  key: number;
  title: string;
  count: number;
  rows: GridRow[];
  /** Top edge in the grid's content box, and the title plus every row under it. */
  top: number;
  height: number;
}

/** The calendar day a photo belongs to: the grouping key, and the heading it reads as. */
function captureDay(photo: CatalogPhoto): { key: string; title: string } {
  const parsed = photo.capturedAt ? new Date(photo.capturedAt) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) return { key: "", title: "No capture date" };
  return {
    key: parsed.toDateString(),
    title: parsed.toLocaleDateString(undefined, { dateStyle: "full" }),
  };
}

function section(
  run: CatalogPhoto[],
  containerWidth: number,
  targetHeight: number,
  top: number,
): GridSection {
  const rows = justifyRows(run, containerWidth, targetHeight, top + gridHeaderHeight + gridGap);
  const last = rows.at(-1);
  return {
    key: run[0].photoId,
    title: captureDay(run[0]).title,
    count: run.length,
    rows,
    top,
    height: last ? last.top + last.height - top : gridHeaderHeight,
  };
}

/**
 * The grid under capture-date titles: each run of consecutive photos from one day is
 * justified on its own, so a row never straddles two dates. Runs rather than a group-by —
 * the page arrives in the engine's sort order and the grid never re-sorts it, so sorting
 * by anything but time gives whatever sections that order happens to contain.
 */
export function gridSections(
  photos: CatalogPhoto[],
  containerWidth: number,
  targetHeight: number,
): GridSection[] {
  const sections: GridSection[] = [];
  let run: CatalogPhoto[] = [];
  let top = 0;

  const close = (): void => {
    const entry = section(run, containerWidth, targetHeight, top);
    sections.push(entry);
    top += entry.height;
    run = [];
  };

  for (const photo of photos) {
    const first = run[0];
    if (first && captureDay(first).key !== captureDay(photo).key) close();
    run.push(photo);
  }

  if (run.length > 0) close();
  return sections;
}

export interface WindowedSection {
  section: GridSection;
  /** Only the rows near the scrollport; every other row is its height and nothing else. */
  rows: GridRow[];
}

/**
 * What a scrolled grid actually has to draw. Every section is kept, because a title that
 * only existed while its own rows were on screen could not stick to the top of the
 * scrollport — there is one title per day and they cost nothing. The rows are windowed: a
 * library is thousands of cells, a cell is a dozen elements, and the whole catalog is
 * listed now rather than a page of it.
 *
 * A screen of overscan either way, so a flick has cells to show before the next scroll
 * event lands.
 */
export function gridWindow(
  sections: GridSection[],
  scrollTop: number,
  viewportHeight: number,
): WindowedSection[] {
  const top = scrollTop - viewportHeight;
  const bottom = scrollTop + viewportHeight * 2;
  return sections.map((entry) => ({
    section: entry,
    rows: entry.rows.filter((row) => row.top < bottom && row.top + row.height > top),
  }));
}

/** The filmstrip's cell box: the width a cell is drawn at, and the gap to the next one. */
export const stripCellWidth = 104;
export const stripGap = 6;

/**
 * The cells a horizontally scrolled filmstrip has to draw: the scrollport plus a strip's
 * width either way. Every cell is the same width, so the range is arithmetic rather than a
 * measurement. `end` is exclusive.
 */
export function stripWindow(
  count: number,
  scrollLeft: number,
  viewportWidth: number,
): { start: number; end: number } {
  const pitch = stripCellWidth + stripGap;
  return {
    start: Math.max(0, Math.floor((scrollLeft - viewportWidth) / pitch)),
    end: Math.min(count, Math.ceil((scrollLeft + viewportWidth * 2) / pitch)),
  };
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

/**
 * The one-click filters, shared by the library inside the grid and by the strip's own bar.
 * Each is a whole `catalog.list` filter rather than a flag toggled onto the current one:
 * the engine does the filtering, and "All" has to be able to say "nothing at all".
 */
export const quickFilters: { label: string; filter: CatalogFilter }[] = [
  { label: "All", filter: {} },
  { label: "Picks", filter: { flag: "pick" } },
  { label: "Rejects", filter: { flag: "reject" } },
  { label: "3★+", filter: { minRating: 3 } },
];

/**
 * Whether two filters are the same request. The quick filters are the only objects with
 * these shapes, so comparing the serialised filter is enough to know which row is on —
 * a search typed into the box is a different filter and turns all of them off.
 */
export function sameFilter(a: CatalogFilter, b: CatalogFilter): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

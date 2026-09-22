import type { EngineClient, ViewerService } from "@latent/contracts";
import type {
  CatalogCollection,
  CatalogFoldersResult,
  CatalogPhoto,
  JobProgressParams,
  PhotoFlag,
} from "@latent/protocol";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import {
  clampGridSize,
  gridSizeRange,
  missingThumbnails,
  movedSelection,
  nextSelection,
  thumbnailKey,
  type CatalogFilter,
  type SelectionModifiers,
  type SortKey,
} from "./catalog";

const thumbnailSize = 256;
/**
 * Thumbnails held in memory at once. `catalog.list` is not paged any more — the panes get
 * the whole filtered catalog and window it themselves — so the cache is bounded by this
 * rather than by a page size. Comfortably more than any one viewport asks for, and a key
 * a pane says it is showing is never evicted whatever the count.
 */
const thumbnailCacheSize = 1024;

/**
 * Mirror of the engine's catalog for the panes that draw it: folders, collections, every
 * row the filter matches, the selection, and one object URL per thumbnail. Nothing here is
 * edit state — ratings, flags and collection membership are engine writes that come back
 * as `catalog.changed`, and the state re-lists.
 *
 * `photos` is the whole filtered catalog, not a page of it: the grid and the filmstrip
 * scroll through all of it and each asks for the thumbnails of the cells it is drawing
 * (`needThumbnails`). Row metadata for a large library is cheap; a cell and its decode are
 * not.
 */
export class CatalogState {
  folders = $state<CatalogFoldersResult["folders"]>([]);
  collections = $state<CatalogCollection[]>([]);
  photos = $state<CatalogPhoto[]>([]);
  total = $state(0);
  filter = $state<CatalogFilter>({});
  sort = $state<SortKey>("capturedAt");
  descending = $state(true);
  selection = $state<number[]>([]);
  jobs = $state<JobProgressParams[]>([]);
  error = $state("");
  /** Grid view: the centre region covers the viewer with a page of thumbnails. */
  gridVisible = $state(false);
  gridSize = $state(160);
  /** The row for the open photo when it is not on the listed page (`catalog.get`). */
  openRow = $state<CatalogPhoto | null>(null);
  /**
   * Cache key (`thumbnailKey`: the file's hash, or the row id until it has one) → object
   * URL of the JPEG the engine sent as an LTHM frame.
   */
  readonly thumbnails = new SvelteMap<string, string>();
  /** Folder paths whose children are folded away; the tree itself is the engine's. */
  readonly collapsedFolders = new SvelteSet<string>();

  private anchor: number | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  // Bookkeeping, not view state; the reactive collections keep the Svelte lint rule happy
  // and cost nothing at this size. Both are keyed like `thumbnails` is.
  private readonly pendingThumbnails = new SvelteMap<string, () => void>();
  /** photoId → the cache key its thumbnail went in under, so a removed row can free it. */
  private readonly thumbnailKeys = new SvelteMap<number, string>();
  /** Pane id → the cache keys it says it is drawing; eviction leaves those alone. */
  private readonly shownThumbnails = new SvelteMap<string, SvelteSet<string>>();
  private readonly timers = new SvelteSet<ReturnType<typeof setTimeout>>();
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
  ) {
    this.unsubscribes.push(
      engine.on("catalog.changed", (params) => {
        // Rows that left the catalog take their thumbnails with them, whoever removed
        // them: the object URLs are this client's to free.
        if (params.reason === "remove") this.forgetThumbnails(params.photoIds);
        this.scheduleReload();
      }),
      engine.on("job.progress", (params) => this.trackJob(params)),
    );
  }

  get selectedPhotos(): CatalogPhoto[] {
    return this.photos.filter((photo) => this.selection.includes(photo.photoId));
  }

  /** The thumbnail this row draws, if the UI has it yet — two rows of one file share it. */
  thumbnailUrl(photo: CatalogPhoto): string | undefined {
    return this.thumbnails.get(thumbnailKey(photo));
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    for (const unsubscribe of this.pendingThumbnails.values()) unsubscribe();
    this.pendingThumbnails.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const url of this.thumbnails.values()) URL.revokeObjectURL(url);
    this.thumbnails.clear();
    this.thumbnailKeys.clear();
    this.shownThumbnails.clear();
  }

  async reload(): Promise<void> {
    await this.engine.whenOpen();
    try {
      const [folders, collections, listed] = await Promise.all([
        this.engine.call("catalog.folders", {}),
        this.engine.call("catalog.collections", {}),
        // No limit: the panes window what they draw, so a page here would only be a
        // second, invisible limit on top of that one.
        this.engine.call("catalog.list", {
          ...this.filter,
          sort: this.sort,
          descending: this.descending,
        }),
      ]);
      this.folders = folders.folders;
      this.collections = collections.collections;
      this.photos = listed.photos;
      this.total = listed.total;
      this.error = "";
      // The open photo's row is in the list unless the filter excludes it; take it from
      // there rather than asking for it a second time.
      const openId = this.openRow?.photoId;
      const listedRow = listed.photos.find((photo) => photo.photoId === openId);
      if (listedRow) this.openRow = listedRow;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  setFilter(filter: CatalogFilter): void {
    this.filter = filter;
    void this.reload();
  }

  /** One `catalog.list` per sort change: the engine sorts, the UI never re-orders rows. */
  setSort(sort: SortKey, descending: boolean): void {
    this.sort = sort;
    this.descending = descending;
    void this.reload();
  }

  toggleGrid(): void {
    this.gridVisible = !this.gridVisible;
  }

  setGridSize(size: number): void {
    this.gridSize = clampGridSize(size);
  }

  /** One notch of the size slider, for the grid's zoom buttons. */
  stepGridSize(steps: number): void {
    this.setGridSize(this.gridSize + steps * gridSizeRange.step);
  }

  toggleFolder(path: string): void {
    if (this.collapsedFolders.has(path)) this.collapsedFolders.delete(path);
    else this.collapsedFolders.add(path);
  }

  /** Typing is not one filter change per keystroke: the list reloads once it stops. */
  setQuery(query: string): void {
    this.filter = { ...this.filter, query };
    if (this.queryTimer !== null) {
      clearTimeout(this.queryTimer);
      this.timers.delete(this.queryTimer);
    }
    this.queryTimer = this.timer(() => {
      this.queryTimer = null;
      void this.reload();
    }, 200);
  }

  /**
   * Moving the selection opens the photo in the filmstrip, where the viewer behind it is
   * what you are looking at, and does not in the grid, where it is not: a decode per arrow
   * key is a second of work for a photo nobody asked to see. Enter or a double-click is
   * how a grid cell is entered.
   */
  private openOnSelect(photoId: number): void {
    this.prioritizePreviews();
    if (this.gridVisible) return;
    void this.open(photoId);
  }

  /**
   * Tells a running preview job to decode what is selected before the rest of its queue,
   * so the photo about to be opened is the one that is ready. A hint the engine may have
   * nothing to do with; the call is fire-and-forget for that reason.
   */
  private prioritizePreviews(): void {
    const photoIds = [...this.selection];
    if (photoIds.length === 0) return;
    void this.engine.call("preview.prioritize", { photoIds }).catch(() => {});
  }

  /** Click on a thumbnail: selection follows the modifiers, the viewer follows the click. */
  select(photoId: number, modifiers: SelectionModifiers): void {
    const visible = this.photos.map((photo) => photo.photoId);
    this.selection = nextSelection(visible, this.selection, this.anchor, photoId, modifiers);
    if (!modifiers.shift) this.anchor = photoId;
    if (modifiers.ctrl || modifiers.shift) return;
    this.openOnSelect(photoId);
  }

  move(delta: number): void {
    const visible = this.photos.map((photo) => photo.photoId);
    const photoId = movedSelection(visible, this.selection, delta);
    if (photoId === null) return;
    this.selection = [photoId];
    this.anchor = photoId;
    this.openOnSelect(photoId);
  }

  /** Home/End: the ends of the listed catalog, not of whatever is on screen. */
  moveToEdge(edge: "first" | "last"): void {
    const photo = edge === "first" ? this.photos.at(0) : this.photos.at(-1);
    if (!photo) return;
    this.selection = [photo.photoId];
    this.anchor = photo.photoId;
    this.openOnSelect(photo.photoId);
  }

  /** Opens a photo in the viewer at the size the viewer's canvas already knows. */
  async open(photoId: number): Promise<void> {
    const photo = this.photos.find((candidate) => candidate.photoId === photoId);
    if (!photo) return;
    this.openRow = photo;
    await this.viewer.open(photo.path);
  }

  /** Enter in the grid: open what is selected and go back to the edit view. */
  async openSelected(): Promise<void> {
    const photoId = this.selection.at(-1);
    if (photoId === undefined) return;
    this.gridVisible = false;
    await this.open(photoId);
  }

  /**
   * The row for the open photo, for panes that draw one photo rather than a page. Takes
   * it off the listed page when it is there, and asks the engine once when it is not.
   */
  async loadRow(photoId: number): Promise<void> {
    if (this.openRow?.photoId === photoId) return;
    const listed = this.photos.find((photo) => photo.photoId === photoId);
    if (listed) {
      this.openRow = listed;
      return;
    }
    try {
      this.openRow = await this.engine.call("catalog.get", { photoId });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async setRating(rating: number): Promise<void> {
    await Promise.all(
      this.selection.map((photoId) => this.engine.call("catalog.setRating", { photoId, rating })),
    );
  }

  async setFlag(flag: PhotoFlag): Promise<void> {
    await Promise.all(
      this.selection.map((photoId) => this.engine.call("catalog.setFlag", { photoId, flag })),
    );
  }

  /** The cell's own hover controls: this photo, whatever the selection is. */
  async rate(photoId: number, rating: number): Promise<void> {
    await this.engine.call("catalog.setRating", { photoId, rating });
  }

  async flagPhoto(photoId: number, flag: PhotoFlag): Promise<void> {
    await this.engine.call("catalog.setFlag", { photoId, flag });
  }

  /**
   * Delete on the selection: the rows leave the catalog, the files on disk do not. The
   * engine answers with a count and publishes `catalog.changed`, which re-lists the page.
   */
  async removeSelection(): Promise<void> {
    const photoIds = [...this.selection];
    if (photoIds.length === 0) return;
    try {
      const { removed } = await this.engine.call("catalog.remove", { photoIds });
      if (removed === 0) return;
      this.selection = [];
      // The thumbnails go with the `catalog.changed { reason: "remove" }` the engine
      // publishes for this call — the same path a removal from another socket takes.
      await this.reload();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Asks the engine to stop a job; its last `job.progress` is what updates the line. */
  async cancelJob(jobId: number): Promise<void> {
    try {
      await this.engine.call("job.cancel", { jobId });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async importPaths(paths: string[], recursive: boolean): Promise<void> {
    if (paths.length === 0) return;
    await this.engine.call("catalog.import", { paths: paths as [string, ...string[]], recursive });
  }

  async createCollection(name: string): Promise<void> {
    await this.engine.call("catalog.collectionSet", { name });
    await this.reload();
  }

  async renameCollection(collectionId: number, name: string): Promise<void> {
    await this.engine.call("catalog.collectionSet", { collectionId, name });
    await this.reload();
  }

  async deleteCollection(collectionId: number): Promise<void> {
    await this.engine.call("catalog.collectionSet", { collectionId, delete: true });
    if (this.filter.collectionId === collectionId) this.filter = {};
    await this.reload();
  }

  async addSelectionTo(collectionId: number): Promise<void> {
    if (this.selection.length === 0) return;
    await this.engine.call("catalog.collectionSet", { collectionId, add: [...this.selection] });
    await this.reload();
  }

  async removeSelectionFrom(collectionId: number): Promise<void> {
    if (this.selection.length === 0) return;
    await this.engine.call("catalog.collectionSet", { collectionId, remove: [...this.selection] });
    await this.reload();
  }

  /**
   * The thumbnails a pane's visible cells need, in one `catalog.thumbnails`: subscribe to
   * every LTHM frame first, ask once, keep the object URLs. Photos already held or already
   * asked for are skipped, so the scroll events that do not bring a new cell into reach
   * send nothing — and it is one call per window, never one per cell.
   *
   * `pane` is the caller's id. Two panes draw cells at once (the grid covers the viewer,
   * the filmstrip stays under it), and each one's window has to survive the other's
   * eviction pass. Every URL is revoked in `dispose`, every subscription dropped once its
   * frame arrived or the engine said it will not come.
   */
  needThumbnails(pane: string, visible: CatalogPhoto[]): void {
    this.shownThumbnails.set(pane, new SvelteSet(visible.map((photo) => thumbnailKey(photo))));
    const wanted = missingThumbnails(visible, [
      ...this.thumbnails.keys(),
      ...this.pendingThumbnails.keys(),
    ]);
    if (wanted.length === 0) return;
    for (const photo of wanted) {
      const key = thumbnailKey(photo);
      this.thumbnailKeys.set(photo.photoId, key);
      const unsubscribe = this.engine.onThumbnail(photo.photoId, (_header, jpeg) => {
        this.thumbnails.set(key, URL.createObjectURL(jpeg));
        this.dropPending(key);
        this.evictThumbnails();
      });
      this.pendingThumbnails.set(key, unsubscribe);
    }
    void this.engine
      .call("catalog.thumbnails", {
        photoIds: wanted.map((photo) => photo.photoId),
        size: thumbnailSize,
      })
      .then((result) => {
        // A photo the engine could not render sends no frame; stop waiting for one.
        for (const photoId of result.missing) this.dropPending(this.thumbnailKeys.get(photoId));
      })
      .catch(() => {
        for (const photo of wanted) this.dropPending(thumbnailKey(photo));
      });
  }

  /**
   * Drops the oldest thumbnails once the cache is over its bound, skipping anything a pane
   * says it is drawing. A `SvelteMap` keeps insertion order, so the front of it is what was
   * fetched longest ago — which, scrolling, is what is furthest from the screen.
   */
  private evictThumbnails(): void {
    for (const key of this.thumbnails.keys()) {
      if (this.thumbnails.size <= thumbnailCacheSize) return;
      if (this.isShown(key)) continue;
      const url = this.thumbnails.get(key);
      if (url) URL.revokeObjectURL(url);
      this.thumbnails.delete(key);
    }
  }

  private isShown(key: string): boolean {
    for (const keys of this.shownThumbnails.values()) {
      if (keys.has(key)) return true;
    }
    return false;
  }

  /** Frees the thumbnails of rows that are gone: the URL, the cache slot, the wait. */
  private forgetThumbnails(photoIds: number[]): void {
    for (const photoId of photoIds) {
      const key = this.thumbnailKeys.get(photoId);
      this.thumbnailKeys.delete(photoId);
      if (key === undefined) continue;
      const url = this.thumbnails.get(key);
      if (url) URL.revokeObjectURL(url);
      this.thumbnails.delete(key);
      this.dropPending(key);
    }
  }

  private dropPending(key: string | undefined): void {
    if (key === undefined) return;
    this.pendingThumbnails.get(key)?.();
    this.pendingThumbnails.delete(key);
  }

  /** An import can emit a burst of `catalog.changed`; one re-list per burst is enough. */
  private scheduleReload(): void {
    if (this.reloadTimer !== null) return;
    this.reloadTimer = this.timer(() => {
      this.reloadTimer = null;
      void this.reload();
    }, 60);
  }

  private trackJob(params: JobProgressParams): void {
    const others = this.jobs.filter((job) => job.jobId !== params.jobId);
    this.jobs = [...others, params];
    if (!params.finished) return;
    // A finished job stays on screen briefly, then the status line goes quiet again.
    this.timer(() => {
      this.jobs = this.jobs.filter((job) => job.jobId !== params.jobId);
    }, 4000);
  }

  private timer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      callback();
    }, delayMs);
    this.timers.add(handle);
    return handle;
  }
}

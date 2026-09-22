// The Planes column's own state: the op it edits, the detect job that is running, the
// preview raster it draws, and the batch that repeats the whole thing over a selection.
// Nothing here is edit state — the seed stroke and the three numbers are mask params in the
// engine's stack, and the trails raster is the engine's cache.
import type { ContentRect, EngineClient, PaneRegistry, ViewerService } from "@latent/contracts";
import type { CatalogState } from "@latent/plugin-catalog";
import { MaskPreviewQueue, tintPixels } from "@latent/plugin-masks";
import type { MaskPreviewParams, Op } from "@latent/protocol";
import {
  backendOf,
  defaultRepaintBackend,
  paramsOf,
  planesOp,
  PLANES_MODE,
  PLANES_OP,
  seedOf,
  trailsComponentOf,
  trailsMask,
  type BatchProgress,
  type RepaintBackend,
  type SeedPath,
  type TrailsParams,
} from "./planes";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PlanesState {
  error = $state("");
  /** The mask.detect job on the open photo, or null. */
  detectJob = $state<number | null>(null);
  /** The generative.run job that repaints what the mask covers. */
  removeJob = $state<number | null>(null);
  removeNote = $state("");
  showMask = $state(true);
  /** Whether "Apply to selection" also repaints, or only detects. */
  batchRemoves = $state(false);
  batch = $state<BatchProgress | null>(null);

  private readonly queue: MaskPreviewQueue;
  private readonly unsubscribe: (() => void)[] = [];
  /** The one job a batch is waiting on: it works a photo at a time, so there is never a
   *  second. Cleared by the notification that finishes it. */
  private waiting: { jobId: number; settle: (error: string) => void } | null = null;
  private raster: HTMLCanvasElement | null = null;
  private rasterContentRect: ContentRect | null = null;
  private previewSignature = "";
  private previewInFlight = false;
  private cancelled = false;

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
    private readonly panes: PaneRegistry,
    private readonly catalog: CatalogState,
  ) {
    this.queue = new MaskPreviewQueue(engine);
    this.unsubscribe.push(
      engine.on("job.progress", (params) => {
        if (!params.finished) {
          if (params.jobId === this.removeJob) this.removeNote = params.message ?? "";
          return;
        }
        const waiting = this.waiting;
        if (waiting?.jobId === params.jobId) {
          this.waiting = null;
          waiting.settle(params.error ?? "");
        }
        if (params.jobId === this.detectJob) {
          this.detectJob = null;
          this.error = params.error ?? "";
        }
        if (params.jobId === this.removeJob) {
          this.removeJob = null;
          this.removeNote = "";
          this.error = params.error ?? "";
        }
      }),
    );
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.queue.dispose();
    // A batch mid-flight would otherwise await a notification that can no longer arrive.
    this.waiting?.settle("the column closed");
    this.waiting = null;
  }

  /** The tool is open exactly when the rail is on it; the rail is the one truth. */
  get active(): boolean {
    return this.panes.mode === PLANES_MODE;
  }

  toggle(): void {
    this.panes.setMode(this.active ? "edit" : PLANES_MODE);
  }

  get op(): Op | undefined {
    return planesOp(this.viewer.stack);
  }

  get seed(): SeedPath | null {
    return seedOf(this.op);
  }

  get params(): TrailsParams {
    return paramsOf(this.op);
  }

  /** What repaints the trails. Local sky fill unless the op says otherwise. */
  get backend(): RepaintBackend {
    return backendOf(this.op);
  }

  async setBackend(value: RepaintBackend): Promise<void> {
    const op = this.op;
    if (!op) return;
    await this.viewer.setOpParams(op.id, { backend: value }, false);
  }

  get detecting(): boolean {
    return this.detectJob !== null || trailsComponentOf(this.op)?.state === "pending";
  }

  get removing(): boolean {
    return this.removeJob !== null;
  }

  get detected(): boolean {
    const state = trailsComponentOf(this.op)?.state;
    return state === "ready" || state === "stale";
  }

  /** Why the last detect failed, as the engine stored it on the component. */
  get failure(): string {
    const component = trailsComponentOf(this.op);
    if (component?.state !== "failed") return "";
    const stored = component.params?.error;
    return typeof stored === "string" && stored !== "" ? stored : this.error;
  }

  get rasterCanvas(): HTMLCanvasElement | null {
    return this.raster;
  }

  get rasterRect(): ContentRect | null {
    return this.rasterContentRect;
  }

  /**
   * A stroke on the viewer: drawn along the one trail everything else is measured against.
   * Creates the op the first time, then re-detects with the new seed.
   */
  async seedFrom(stroke: SeedPath): Promise<void> {
    const photoId = this.viewer.photoId;
    if (photoId === null) return;
    this.error = "";
    const existing = this.op;
    if (!existing) {
      const created = await this.createOp(stroke);
      if (!created) return;
      await this.detect();
      return;
    }
    await this.viewer.setMask(existing.id, trailsMask(stroke, this.params));
    await this.detect();
  }

  /** The three sliders. A committed move makes the raster stale; the engine never re-runs
   *  a detection on its own, so the column asks for one. */
  async setParam(name: keyof TrailsParams, value: number, transient: boolean): Promise<void> {
    const op = this.op;
    const seed = this.seed;
    if (!op || !seed) return;
    await this.viewer.setMask(
      op.id,
      trailsMask(seed, { ...this.params, [name]: value }),
      transient,
    );
    if (!transient) await this.detect();
  }

  async detect(): Promise<void> {
    const op = this.op;
    const photoId = this.viewer.photoId;
    if (!op || photoId === null) return;
    const component = trailsComponentOf(op);
    if (!component) return;
    this.error = "";
    try {
      const { jobId } = await this.engine.call("mask.detect", {
        photoId,
        opId: op.id,
        componentId: component.id,
      });
      this.detectJob = jobId;
    } catch (error) {
      this.error = messageOf(error);
    }
  }

  /** Repaints what the mask covers, through whichever generative backend is configured. */
  async removePlanes(): Promise<void> {
    const op = this.op;
    const photoId = this.viewer.photoId;
    if (!op || photoId === null || this.removing) return;
    this.error = "";
    this.removeNote = "starting";
    try {
      const { jobId } = await this.engine.call("generative.run", { photoId, opId: op.id });
      this.removeJob = jobId;
    } catch (error) {
      this.removeNote = "";
      this.error = messageOf(error);
    }
  }

  async cancel(): Promise<void> {
    const jobId = this.removeJob ?? this.detectJob;
    this.cancelled = true;
    if (jobId === null) return;
    await this.engine.call("job.cancel", { jobId });
  }

  // ---- the batch ---------------------------------------------------------------------

  /**
   * The same component on every selected photo. The component travels, the raster does not:
   * each photo runs its own `mask.detect`, so a plane that is somewhere else in the next
   * frame — which is the whole point of a sequence — is still found.
   *
   * One photo at a time, and each one is closed again: an open photo holds a GPU texture,
   * and two hundred of them is the VRAM of the machine.
   */
  async applyToSelection(): Promise<void> {
    const seed = this.seed;
    const photoIds = this.catalog.selection.filter((id) => id !== this.viewer.photoId);
    if (!seed || photoIds.length === 0 || this.batch) return;
    this.cancelled = false;
    this.error = "";
    const params = this.params;
    const backend = this.backend;
    this.batch = { done: 0, total: photoIds.length, current: "", failed: 0 };

    for (const photoId of photoIds) {
      if (this.cancelled) break;
      const failure = await this.applyToPhoto(photoId, seed, params, backend);
      const batch: BatchProgress | null = this.batch;
      if (!batch) break;
      this.batch = {
        ...batch,
        done: batch.done + 1,
        failed: batch.failed + (failure ? 1 : 0),
      };
      if (failure) this.error = failure;
    }
  }

  cancelBatch(): void {
    this.cancelled = true;
  }

  clearBatch(): void {
    this.batch = null;
  }

  /** Returns the failure, or "" when the photo was done. */
  private async applyToPhoto(
    photoId: number,
    seed: SeedPath,
    params: TrailsParams,
    backend: RepaintBackend,
  ): Promise<string> {
    let opened: number | null = null;
    try {
      const row = await this.engine.call("catalog.get", { photoId });
      const batch: BatchProgress | null = this.batch;
      if (batch) this.batch = { ...batch, current: row.filename };
      const photo = await this.engine.call("photo.open", { path: row.path });
      opened = photo.photoId;
      const stack = await this.engine.call("op.add", {
        photoId: photo.photoId,
        op: PLANES_OP,
        params: { backend },
        mask: trailsMask(seed, params),
      });
      const added = [...stack.stack].reverse().find((op) => op.op === PLANES_OP);
      if (!added) return `${row.filename}: the engine did not add the op`;
      const detect = await this.engine.call("mask.detect", {
        photoId: photo.photoId,
        opId: added.id,
        componentId: trailsComponentOf(added)?.id ?? "trails1",
      });
      const detectFailure = await this.awaitJob(detect.jobId);
      if (detectFailure) return `${row.filename}: ${detectFailure}`;
      if (!this.batchRemoves) return "";
      const run = await this.engine.call("generative.run", {
        photoId: photo.photoId,
        opId: added.id,
      });
      const runFailure = await this.awaitJob(run.jobId);
      if (runFailure) return `${row.filename}: ${runFailure}`;
      return "";
    } catch (error) {
      return messageOf(error);
    } finally {
      // The viewer's own photo is never closed under it; the batch skips it anyway.
      if (opened !== null && opened !== this.viewer.photoId) {
        await this.engine.call("photo.close", { photoId: opened }).catch(() => undefined);
      }
    }
  }

  /** Resolves with the job's error, or "" when it finished cleanly. */
  private awaitJob(jobId: number): Promise<string> {
    return new Promise<string>((settle) => {
      this.waiting = { jobId, settle };
    });
  }

  // ---- the preview -------------------------------------------------------------------

  /**
   * Re-asks for the mask raster when the op's mask changed or the engine moved the photo
   * inside the frame — a raster is view-space, so a zoom invalidates it. Reads reactive
   * state on purpose: the pane calls this from an `$effect`.
   */
  syncPreview(): void {
    const op = this.op;
    const signature = `${JSON.stringify(op?.mask ?? null)}@${this.viewer.frameGeometry}`;
    if (signature === this.previewSignature) return;
    this.previewSignature = signature;
    if (!op || !this.detected) {
      this.raster = null;
      this.rasterContentRect = null;
      this.viewer.overlay.redraw();
      return;
    }
    void this.requestPreview();
  }

  private async requestPreview(): Promise<void> {
    const op = this.op;
    const photoId = this.viewer.photoId;
    if (!op || photoId === null || this.previewInFlight) return;
    this.previewInFlight = true;
    const params: MaskPreviewParams = { photoId, opId: op.id };
    if (this.viewer.viewId !== null) params.viewId = this.viewer.viewId;
    try {
      const preview = await this.queue.request(params);
      if (preview) this.putRaster(preview.width, preview.height, preview.coverage);
      this.rasterContentRect = preview?.contentRect ?? null;
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.previewInFlight = false;
    }
  }

  private putRaster(width: number, height: number, coverage: Uint8Array): void {
    const canvas = this.rasterFor(width, height);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.putImageData(new ImageData(tintPixels(coverage, "red"), width, height), 0, 0);
    this.viewer.overlay.redraw();
  }

  private rasterFor(width: number, height: number): HTMLCanvasElement {
    const existing = this.raster;
    if (existing && existing.width === width && existing.height === height) return existing;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    this.raster = canvas;
    return canvas;
  }

  private async createOp(seed: SeedPath): Promise<boolean> {
    const photoId = this.viewer.photoId;
    if (photoId === null) return false;
    try {
      const stack = await this.engine.call("op.add", {
        photoId,
        op: PLANES_OP,
        params: { backend: defaultRepaintBackend },
        mask: trailsMask(seed, this.params),
      });
      const added = [...stack.stack].reverse().find((op) => op.op === PLANES_OP);
      if (added) this.viewer.selectOp(added.id);
      return added !== undefined;
    } catch (error) {
      this.error = messageOf(error);
      return false;
    }
  }
}

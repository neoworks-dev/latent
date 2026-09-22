// The Masks column's own state: which op and component are selected, what the overlay is
// showing, and the one preview raster it keeps. Nothing here is edit state — every
// component edit is a stack write and comes back from the engine; the raster comes back as
// an LMSK frame and is never built in the UI.
import type { ContentRect, EngineClient, ViewerService } from "@latent/contracts";
import type {
  Mask,
  MaskComponent,
  MaskComponentKind,
  MaskDetectParams,
  MaskPreviewParams,
  Op,
} from "@latent/protocol";
import { SvelteMap } from "svelte/reactivity";
import {
  addComponent,
  componentId as nextComponentId,
  defaultComponent,
  isAiKind,
  needsSeedGesture,
  kindSpec,
  layerOf,
  layersOf,
  maskSignature,
  nextTint,
  opById,
  patchComponent,
  patchComponentParams,
  removeComponent,
  tintPixels,
  type MaskTint,
  type MaskTool,
} from "./masks";
import { MaskPreviewQueue } from "./preview";
import { StrokeBuffer, strokeSpacing, type Point } from "./tools";

export class MasksState {
  overlayVisible = $state(true);
  tint = $state<MaskTint>("red");
  tool = $state<MaskTool>("none");
  selectedComponentId = $state<string | null>(null);
  /** Fraction of the frame the last preview covered — the pane's `data-mask-coverage`. */
  coverage = $state(0);
  /** Set while a preview is on the wire, so the pane can say so instead of flickering. */
  previewing = $state(false);
  brushSize = $state(0.08);
  brushFeather = $state(50);
  brushFlow = $state(100);
  brushErasing = $state(false);
  /** The prompt box of a `text` component, kept while it is being typed. */
  textPrompt = $state("");
  status = $state("");
  /** jobId → why that detect job failed; `MaskComponent` has no room for a message. */
  readonly jobErrors = new SvelteMap<number, string>();

  /** The tinted raster, drawn on the overlay. A canvas, not reactive state: it is pixels. */
  private raster: HTMLCanvasElement | null = null;
  private rasterContentRect: ContentRect | null = null;
  private readonly queue: MaskPreviewQueue;
  private readonly unsubscribeJobs: () => void;
  private previewSignature = "";
  private previewInFlight = false;
  private previewQueued = false;
  private lastCoverage: Uint8Array | null = null;
  private readonly strokes = new StrokeBuffer();
  private strokeHandle: number | null = null;
  private strokeComponentId: string | null = null;
  private strokeErasing = false;
  /** A `mask.stroke` is on the wire; the next segments wait in the buffer behind it. */
  private strokeInFlight = false;
  /**
   * The stroke under the pointer, in image points. The engine's raster is one round trip
   * behind the brush — 80–150 ms of it is the frame on the socket — so the overlay draws the
   * path itself until the preview that contains it lands. Feedback only: nothing is masked
   * by it, and it is dropped the moment the engine's own coverage arrives.
   */
  private live: Point[] = [];
  private liveStale = false;

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
  ) {
    this.queue = new MaskPreviewQueue(engine);
    this.unsubscribeJobs = engine.on("job.progress", (params) => {
      if (params.kind !== "mask" || !params.finished) return;
      if (params.error) this.jobErrors.set(params.jobId, params.error);
      else this.jobErrors.delete(params.jobId);
    });
  }

  dispose(): void {
    if (this.strokeHandle !== null) cancelAnimationFrame(this.strokeHandle);
    this.strokeHandle = null;
    this.unsubscribeJobs();
    this.queue.dispose();
  }

  /** Every layer of this photo, bottom-up: the list the column shows. */
  get layers(): Op[] {
    return layersOf(this.viewer.stack);
  }

  /**
   * The mask being edited: the one this panel selected, else the layer holding whatever the
   * Layers column points at. Undefined means the photo itself — no mask is selected, and
   * nothing here writes into one until the user picks it.
   */
  get layer(): Op | undefined {
    return layerOf(this.viewer.stack, this.viewer.maskTarget ?? this.viewer.selectedOpId);
  }

  /** The adjustments under the selected layer's mask, in the order they were added. */
  get adjustments(): Op[] {
    return this.layer?.ops ?? [];
  }

  get mask(): Mask | undefined {
    return this.layer?.mask;
  }

  get components(): MaskComponent[] {
    return this.mask?.components ?? [];
  }

  get selectedComponent(): MaskComponent | undefined {
    return this.components.find((component) => component.id === this.selectedComponentId);
  }

  /**
   * Why a component's last detect failed. The engine stores it in `params.error`; the job's
   * notification is the fallback for a failure that happened while this client was watching.
   */
  errorOf(component: MaskComponent): string | undefined {
    if (component.state !== "failed") return undefined;
    const stored = component.params?.error;
    if (typeof stored === "string" && stored !== "") return stored;
    if (component.jobId === undefined) return "detection failed";
    return this.jobErrors.get(component.jobId) ?? "detection failed";
  }

  toggleOverlay(): void {
    this.overlayVisible = !this.overlayVisible;
    this.viewer.overlay.redraw();
  }

  cycleTint(): void {
    this.tint = nextTint(this.tint);
    this.repaintRaster();
  }

  selectComponent(id: string | null): void {
    this.selectedComponentId = id;
    const component = this.components.find((entry) => entry.id === id);
    // Picking a component arms the tool that edits it, the way Lightroom re-arms the brush.
    this.tool = component ? kindSpec(component.kind).tool : "none";
  }

  setTool(tool: MaskTool): void {
    this.tool = tool;
  }

  /**
   * Clicking a mask leaves it selected and aims the Edit column at it: from here a slider
   * there writes into this layer rather than into the photo. Nothing deselects it but the
   * photo row or closing the panel — the whole point is to move those sliders next.
   */
  selectLayer(opId: string | null): void {
    this.viewer.selectOp(opId);
    this.viewer.setMaskTarget(opId);
    this.selectComponent(null);
  }

  /** Back to the photo itself: no mask selected, the Edit column global again. */
  selectPhoto(): void {
    this.viewer.selectOp(null);
    this.viewer.setMaskTarget(null);
    this.selectComponent(null);
  }

  /** The layer the Edit column is aimed at, which is only ever one this panel selected. */
  get targetId(): string | null {
    return this.viewer.maskTarget;
  }

  /**
   * A new layer with its first component — Lightroom's Create New Mask. The mask comes
   * first and the adjustments under it come later, which is the order a mask is actually
   * made in: nothing has to be adjusted before a region can be selected.
   */
  async createLayer(kind: MaskComponentKind): Promise<MaskComponent | null> {
    const layerId = await this.viewer.addGroup();
    if (!layerId) {
      this.status = "could not create the mask";
      return null;
    }
    this.selectLayer(layerId);
    return this.createComponent(kind);
  }

  async removeLayer(opId: string): Promise<void> {
    if (this.layer?.id === opId) this.selectPhoto();
    await this.viewer.removeOp(opId);
  }

  // Nothing here adds an adjustment: a slider in the Edit column does, because this panel
  // aims that column at the selected mask (`ViewerService.maskTarget`).

  async removeAdjustment(opId: string): Promise<void> {
    await this.viewer.removeOp(opId);
  }

  /**
   * Adds a component to the selected layer's mask, making the layer first when the photo
   * has none. AI kinds are rasterised by a job, so the write is followed by `mask.detect`;
   * `objects` waits for a box drawn on the overlay.
   */
  async createComponent(kind: MaskComponentKind): Promise<MaskComponent | null> {
    const op = this.layer ?? (await this.ensureLayer());
    if (!op) return null;
    const component = defaultComponent(kind, nextComponentId(op.mask, kind));
    if (kind === "text") component.params = { prompt: this.textPrompt };
    if (kind === "brush") {
      component.feather = this.brushFeather;
      component.params = { size: this.brushSize, flow: this.brushFlow };
    }
    await this.viewer.setMask(op.id, addComponent(op.mask, component));
    this.selectComponent(component.id);
    if (isAiKind(kind) && !needsSeedGesture(kind)) await this.detect(component.id);
    return component;
  }

  /** The layer every mask edit needs. Making one is the first thing the column ever does. */
  private async ensureLayer(): Promise<Op | undefined> {
    const existing = this.layer;
    if (existing) return existing;
    const layerId = await this.viewer.addGroup();
    if (!layerId) {
      this.status = "could not create the mask";
      return undefined;
    }
    this.selectLayer(layerId);
    return opById(this.viewer.stack, layerId);
  }

  async detect(componentId: string, hint?: Record<string, unknown>): Promise<void> {
    const op = this.layer;
    const photoId = this.viewer.photoId;
    if (!op || photoId === null) return;
    const params: MaskDetectParams = { photoId, opId: op.id, componentId };
    if (hint) params.hint = hint;
    try {
      await this.engine.call("mask.detect", params);
      this.status = "";
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * `transient` is a slider still being dragged: `op.update` takes the whole mask with the
   * flag set, so the drag is one history step and a tick is dropped while another write is
   * in flight rather than queueing behind it.
   */
  async patch(
    componentId: string,
    patch: Partial<MaskComponent>,
    transient = false,
  ): Promise<void> {
    const op = this.layer;
    if (!op?.mask) return;
    await this.viewer.setMask(op.id, patchComponent(op.mask, componentId, patch), transient);
  }

  async patchParams(
    componentId: string,
    params: Record<string, unknown>,
    transient = false,
  ): Promise<void> {
    const op = this.layer;
    if (!op?.mask) return;
    await this.viewer.setMask(op.id, patchComponentParams(op.mask, componentId, params), transient);
  }

  async remove(componentId: string): Promise<void> {
    const op = this.layer;
    if (!op?.mask) return;
    if (this.selectedComponentId === componentId) this.selectComponent(null);
    await this.viewer.setMask(op.id, removeComponent(op.mask, componentId));
  }

  // ---- strokes -------------------------------------------------------------------

  /** A pointer-down on a brush component. Segments go up transiently until the release. */
  beginStroke(componentId: string, erasing: boolean): void {
    this.strokeComponentId = componentId;
    this.strokeErasing = erasing;
    this.strokes.reset();
    this.live = [];
    this.liveStale = false;
  }

  /** The path the pointer has drawn since the press, for the overlay to paint meanwhile. */
  get livePoints(): readonly Point[] {
    return this.live;
  }

  addStrokePoint(point: Point): void {
    if (!this.strokeComponentId) return;
    // Painted straight away, whether or not the point is far enough to be worth sending.
    if (!this.strokeErasing) this.live.push(point);
    if (!this.strokes.push(point, strokeSpacing(this.brushSize))) return;
    if (this.strokeHandle !== null) return;
    // One call per animation frame at most: a fast mouse fires far above 60 Hz.
    this.strokeHandle = requestAnimationFrame(() => {
      this.strokeHandle = null;
      void this.flushStroke(true);
    });
  }

  /** Pointer-up: the last points plus the committed call that closes the undo step. */
  async endStroke(): Promise<void> {
    if (!this.strokeComponentId) return;
    if (this.strokeHandle !== null) cancelAnimationFrame(this.strokeHandle);
    this.strokeHandle = null;
    await this.flushStroke(false);
    this.strokeComponentId = null;
    this.strokes.reset();
    // The path stays on screen until the preview that holds it arrives; dropping it here
    // would blank the stroke for the round trip it takes to come back.
    this.liveStale = true;
  }

  private async flushStroke(transient: boolean): Promise<void> {
    const componentId = this.strokeComponentId;
    const op = this.layer;
    const photoId = this.viewer.photoId;
    if (!componentId || !op || photoId === null) return;
    // One segment on the wire at a time. Each one is answered with a stack, a frame and a
    // mask preview, which together outlast the 16 ms between animation frames: sending one
    // per frame regardless puts the brush behind the pointer by the whole backlog, and the
    // backlog grows for as long as the drag does. The points wait in the buffer instead and
    // go out together in the next call, which is also fewer, longer segments to rasterise.
    if (transient && this.strokeInFlight) return;
    const points = this.strokes.take();
    // Mid-drag with nothing new there is nothing to send. On release the call has to go out
    // even so — it is the non-transient one that snapshots, and without it the whole stroke
    // would stay transient and undo would take the edit before it as well. It repeats the
    // stroke's last point, which lands on pixels the brush already covered.
    if (points.length === 0 && transient) return;
    const sending = points.length > 0 ? points : this.anchorPoints();
    const [first, ...rest] = sending;
    if (!first) return;
    this.strokeInFlight = true;
    try {
      await this.engine.call("mask.stroke", {
        photoId,
        opId: op.id,
        componentId,
        points: [first, ...rest],
        erase: this.strokeErasing,
        size: this.brushSize,
        flow: this.brushFlow,
        transient,
      });
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.strokeInFlight = false;
    }
    // Whatever the pointer drew while that was out goes now rather than at the next
    // animation frame, so the brush keeps up with a drag that never pauses.
    if (transient && this.strokeComponentId !== null && this.strokes.pending > 0) {
      await this.flushStroke(true);
    }
  }

  /** The stroke's last point, for the call that commits it. Empty before the first point. */
  private anchorPoints(): Point[] {
    const anchor = this.strokes.anchor;
    if (!anchor) return [];
    return [anchor];
  }

  // ---- preview -------------------------------------------------------------------

  /** The raster the overlay draws, already tinted. Null until the first frame lands. */
  get rasterCanvas(): HTMLCanvasElement | null {
    return this.raster;
  }

  /**
   * The part of `rasterCanvas` that is photo, in raster pixels. The raster is letterboxed
   * like the frame it lies over, so blitting all of it onto the overlay's rect would
   * stretch the mask off the image. Null when the engine sent no rect: then it is all photo.
   */
  get rasterRect(): ContentRect | null {
    return this.rasterContentRect;
  }

  /**
   * Re-asks for the preview when the selected op's mask changed, or when the engine moved
   * the photo inside the frame: the raster is view-space and only holds the mask where that
   * frame showed it, so the one drawn at 4:1 covers a quarter of the photo once the view is
   * back to fit. Reads reactive state on purpose: the pane calls it from an `$effect`.
   */
  syncPreview(): void {
    const op = this.layer;
    const signature = `${maskSignature(op, this.selectedComponentId)}@${this.viewer.frameGeometry}`;
    if (signature === this.previewSignature) return;
    this.previewSignature = signature;
    if (!op?.mask || op.mask.components.length === 0) {
      this.raster = null;
      this.rasterContentRect = null;
      this.coverage = 0;
      this.viewer.overlay.redraw();
      return;
    }
    this.requestPreview();
  }

  /** One preview in flight, one queued behind it — the render loop's rule. */
  requestPreview(): void {
    const op = this.layer;
    const photoId = this.viewer.photoId;
    if (!op || photoId === null) return;
    if (this.previewInFlight) {
      this.previewQueued = true;
      return;
    }
    const component = this.selectedComponent;
    // A component that has no raster yet cannot be previewed on its own (-32602), so the
    // combined mask is what the overlay shows until its job lands.
    const componentId =
      component && component.state !== "pending" && component.state !== "failed"
        ? component.id
        : undefined;
    this.previewInFlight = true;
    this.previewing = true;
    const params: MaskPreviewParams = { photoId, opId: op.id };
    if (componentId) params.componentId = componentId;
    // Sized like the view it is laid over, so the raster maps onto the drawn frame.
    if (this.viewer.viewId !== null) params.viewId = this.viewer.viewId;
    void this.queue
      .request(params)
      .then((preview) => {
        if (!preview) return;
        this.coverage = preview.fraction;
        this.rasterContentRect = preview.contentRect;
        this.putRaster(preview.width, preview.height, preview.coverage);
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        this.previewInFlight = false;
        this.previewing = false;
        if (!this.previewQueued) return;
        this.previewQueued = false;
        this.requestPreview();
      });
  }

  private putRaster(width: number, height: number, coverage: Uint8Array): void {
    const canvas = this.rasterFor(width, height);
    const context = canvas.getContext("2d");
    if (!context) return;
    // This raster was rendered after the stroke was committed, so it holds it: the hand-drawn
    // path can go, and the two never both show.
    if (this.liveStale) {
      this.live = [];
      this.liveStale = false;
    }
    context.putImageData(new ImageData(tintPixels(coverage, this.tint), width, height), 0, 0);
    this.lastCoverage = coverage;
    this.viewer.overlay.redraw();
  }

  /** Re-tints the raster already on hand, so Shift+O costs no round trip. */
  private repaintRaster(): void {
    const canvas = this.raster;
    const coverage = this.lastCoverage;
    if (!canvas || !coverage) return;
    this.putRaster(canvas.width, canvas.height, coverage);
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
}

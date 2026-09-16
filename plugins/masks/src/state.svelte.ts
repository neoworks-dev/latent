// The Masks column's own state: which op and component are selected, what the overlay is
// showing, and the one preview raster it keeps. Nothing here is edit state — every
// component edit is a stack write and comes back from the engine; the raster comes back as
// an LMSK frame and is never built in the UI.
import type { EngineClient, ViewerService } from "@latent/contracts";
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
  kindSpec,
  lastMaskedOp,
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

  /** The op the column is pointed at: the selection, else the last layer in the stack. */
  get op(): Op | undefined {
    return opById(this.viewer.stack, this.viewer.selectedOpId) ?? lastMaskedOp(this.viewer.stack);
  }

  get mask(): Mask | undefined {
    return this.op?.mask;
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
   * Adds a component to the selected op's mask. AI kinds are rasterised by a job, so the
   * write is followed by `mask.detect`; `objects` waits for a box drawn on the overlay.
   */
  async createComponent(kind: MaskComponentKind): Promise<MaskComponent | null> {
    const op = this.op;
    if (!op) {
      this.status = "select an adjustment first";
      return null;
    }
    const component = defaultComponent(kind, nextComponentId(op.mask, kind));
    if (kind === "text") component.params = { prompt: this.textPrompt };
    if (kind === "brush") {
      component.feather = this.brushFeather;
      component.params = { size: this.brushSize, flow: this.brushFlow };
    }
    await this.viewer.setMask(op.id, addComponent(op.mask, component));
    this.selectComponent(component.id);
    if (isAiKind(kind) && kind !== "objects") await this.detect(component.id);
    return component;
  }

  async detect(componentId: string, hint?: Record<string, unknown>): Promise<void> {
    const op = this.op;
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
    const op = this.op;
    if (!op?.mask) return;
    await this.viewer.setMask(op.id, patchComponent(op.mask, componentId, patch), transient);
  }

  async patchParams(
    componentId: string,
    params: Record<string, unknown>,
    transient = false,
  ): Promise<void> {
    const op = this.op;
    if (!op?.mask) return;
    await this.viewer.setMask(op.id, patchComponentParams(op.mask, componentId, params), transient);
  }

  async remove(componentId: string): Promise<void> {
    const op = this.op;
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
  }

  addStrokePoint(point: Point): void {
    if (!this.strokeComponentId) return;
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
  }

  private async flushStroke(transient: boolean): Promise<void> {
    const componentId = this.strokeComponentId;
    const op = this.op;
    const photoId = this.viewer.photoId;
    if (!componentId || !op || photoId === null) return;
    const points = this.strokes.take();
    // Mid-drag with nothing new there is nothing to send. On release the call has to go out
    // even so — it is the non-transient one that snapshots, and without it the whole stroke
    // would stay transient and undo would take the edit before it as well. It repeats the
    // stroke's last point, which lands on pixels the brush already covered.
    if (points.length === 0 && transient) return;
    const sending = points.length > 0 ? points : this.anchorPoints();
    const [first, ...rest] = sending;
    if (!first) return;
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
   * Re-asks for the preview when the selected op's mask changed, and not otherwise. Reads
   * reactive state on purpose: the pane calls it from an `$effect`.
   */
  syncPreview(): void {
    const op = this.op;
    const signature = maskSignature(op, this.selectedComponentId);
    if (signature === this.previewSignature) return;
    this.previewSignature = signature;
    if (!op?.mask || op.mask.components.length === 0) {
      this.raster = null;
      this.coverage = 0;
      this.viewer.overlay.redraw();
      return;
    }
    this.requestPreview();
  }

  /** One preview in flight, one queued behind it — the render loop's rule. */
  requestPreview(): void {
    const op = this.op;
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

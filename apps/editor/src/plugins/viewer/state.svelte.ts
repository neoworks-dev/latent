import {
  type EngineClient,
  type EngineFrame,
  FIT_VIEWPORT,
  type FrameSink,
  type GeometryMode,
  type GeometryView,
  IDENTITY_IMAGE_TRANSFORM,
  type ImageTransform,
  oneToOneScale,
  panViewport,
  type ViewerService,
  type ViewportFrame,
  type ViewportState,
  zoomLabel,
  zoomViewport,
} from "@latent/contracts";
import type { Mask, Op, OpUpdateParams, StackGetResult, ViewRenderParams } from "@latent/protocol";
import { FrameTimingLog } from "../../lib/engine/frame-timing";
import { ViewerOverlayState } from "./overlay.svelte";

interface QueuedUpdate {
  opId: string;
  params: Record<string, unknown>;
  transient: boolean;
}

interface PendingAdd {
  op: string;
  request: Promise<void>;
}

/**
 * Client-side mirror of what the engine reports for the open photo. Not edit state: every
 * mutation goes to the engine and the mirror updates from its reply or `stack.changed`.
 * The only local state is in-flight bookkeeping — one render and one `op.update` at a
 * time, with the newest value replacing whatever is queued behind them.
 */
export class ViewerState implements ViewerService, GeometryView {
  photoId = $state<number | null>(null);
  viewId = $state<number | null>(null);
  stack = $state<Op[]>([]);
  revision = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  status = $state("no photo");
  latencyMs = $state(0);
  engineMs = $state(0);
  /** Which op the Masks and Layers columns are pointed at. View state, not edit state. */
  selectedOpId = $state<string | null>(null);
  /**
   * How the frames are rendered: `full` is the crop tool's uncropped image. View state —
   * it goes on the render call, never into the stack. Deliberately *not* `$state`: the
   * crop column sets it from an `$effect` on mount, and a signal read by the same effect
   * that writes it re-runs forever (effect_update_depth_exceeded).
   */
  geometry: GeometryMode = "stack";
  /**
   * Zoom and pan. View state as well: it rides on `view.render`, the engine holds it per
   * view, and nothing about it reaches the stack or the sidecar.
   */
  viewport = $state<ViewportState>(FIT_VIEWPORT);
  /** `Fit`, `100%`, `250%` — the status bar's readout. */
  zoom = $state("Fit");
  readonly overlay = new ViewerOverlayState();

  // The last frame the engine answered about, which is what a zoom is computed against.
  private frame: ViewportFrame = {
    contentRect: [0, 0, 1, 1],
    frameWidth: 1,
    frameHeight: 1,
    transform: IDENTITY_IMAGE_TRANSFORM,
    scale: 1,
  };
  private photoWidth = 0;

  private renderWidth = 1;
  private renderHeight = 1;
  private renderInFlight = false;
  private renderQueued = false;
  private renderSentAt = 0;
  private presentHandle: number | null = null;
  private tracedFrames = 0;
  private frameSink: FrameSink | null = null;
  private readonly timings = new FrameTimingLog();
  private updateInFlight = false;
  private readonly queuedUpdates: QueuedUpdate[] = [];
  private readonly addsInFlight: PendingAdd[] = [];
  private unsubscribeFrame: (() => void) | null = null;
  private readonly unsubscribeStack: () => void;
  private stackWrites: Promise<void> = Promise.resolve();
  private stackWriteBusy = false;

  /**
   * `traceEvery > 0` prints a p50/p95 stage breakdown every that many frames. Off by
   * default so a normal session allocates nothing per frame.
   */
  constructor(
    private readonly engine: EngineClient,
    private readonly traceEvery = 0,
  ) {
    this.unsubscribeStack = engine.on("stack.changed", (params) => {
      if (params.photoId !== this.photoId) return;
      // Our own writes already applied their reply; anything newer came from another
      // writer (script, MCP, a second socket) and needs a repaint, whatever `source` says.
      if (params.revision <= this.revision) return;
      this.applyStack(params);
      this.requestRender();
    });
  }

  dispose(): void {
    if (this.presentHandle !== null) cancelAnimationFrame(this.presentHandle);
    this.presentHandle = null;
    this.unsubscribeFrame?.();
    this.unsubscribeStack();
  }

  attachFrameSink(sink: FrameSink): () => void {
    this.frameSink = sink;
    // A fresh canvas is empty and the engine holds the only copy of the picture.
    this.requestRender();
    return () => {
      if (this.frameSink === sink) this.frameSink = null;
    };
  }

  /**
   * Straight off the socket: upload and draw in the same task the message arrived in, then
   * take the presentation mark on the next animation frame. Everything reactive — the
   * readout, the trace — happens there, after the pixels are already on their way out.
   */
  private paint(frame: EngineFrame): void {
    const marks = this.frameSink?.(frame);
    // The overlay letterboxes to the frame's aspect, so it follows the frame, not the box.
    this.overlay.setImageSize(frame.header.width, frame.header.height);
    const sent = this.renderSentAt;
    if (!marks || sent === 0) return;
    if (this.presentHandle !== null) cancelAnimationFrame(this.presentHandle);
    this.presentHandle = requestAnimationFrame(() => {
      this.presentHandle = null;
      const presented = performance.now();
      this.latencyMs = presented - sent;
      if (this.traceEvery <= 0) return;
      // The reply carrying renderMs lands between the frame and this callback, so
      // `engineMs` is already this frame's number.
      this.timings.record({
        sent,
        received: frame.receivedAt,
        parsed: frame.parsedAt,
        drawStarted: marks.drawStarted,
        uploaded: marks.uploaded,
        drawn: marks.drawn,
        presented,
        engine: this.engineMs,
      });
      this.tracedFrames++;
      if (this.tracedFrames % this.traceEvery !== 0) return;
      // The console is the whole point of `?frametrace`: the screenshot driver reads these
      // lines off the renderer to report the frame path's p50/p95.
      // oxlint-disable-next-line no-console
      console.log(this.timings.format());
    });
  }

  async open(path: string, width?: number, height?: number): Promise<void> {
    this.status = `opening ${path}`;
    // Callers that know the canvas size pass it; the filmstrip reuses the size the
    // canvas' ResizeObserver already reported through `resize`.
    if (width !== undefined) this.renderWidth = width;
    if (height !== undefined) this.renderHeight = height;
    await this.engine.whenOpen();
    const photo = await this.engine.call("photo.open", { path });
    this.photoId = photo.photoId;
    this.photoWidth = photo.width;
    // A new photo is a new frame: whatever the last one was zoomed to means nothing here.
    this.viewport = FIT_VIEWPORT;
    this.zoom = "Fit";
    // Switching photos: the previous view is the engine's to free, not ours to leak.
    const previousView = this.viewId;
    if (previousView !== null) await this.engine.call("view.close", { viewId: previousView });
    const view = await this.engine.call("view.open", {
      photoId: photo.photoId,
      width: this.renderWidth,
      height: this.renderHeight,
    });
    this.viewId = view.viewId;
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = this.engine.onFrame(view.viewId, (frame) => this.paint(frame));
    this.applyStack(await this.engine.call("stack.get", { photoId: photo.photoId }));
    this.status = `${photo.camera} ${photo.width}×${photo.height}`;
    this.requestRender();
  }

  resize(width: number, height: number): void {
    if (width === this.renderWidth && height === this.renderHeight) return;
    this.renderWidth = width;
    this.renderHeight = height;
    this.requestRender();
  }

  /**
   * Zoom about a point of the *canvas*, in its own CSS pixels — the wheel's cursor, or the
   * middle of the box for a keystroke. The frame is device pixels, so the anchor is scaled
   * by the same ratio the canvas is drawn at.
   */
  zoomTo(scale: number, anchorX?: number, anchorY?: number): void {
    const x = anchorX === undefined ? this.frame.frameWidth / 2 : anchorX * devicePixelRatio;
    const y = anchorY === undefined ? this.frame.frameHeight / 2 : anchorY * devicePixelRatio;
    this.setViewport(zoomViewport(this.frame, scale, x, y));
  }

  /** A step of the wheel or of `+`/`-`: a ratio, so every zoom level feels the same. */
  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    this.zoomTo(this.viewport.scale * factor, anchorX, anchorY);
  }

  /** Fit ↔ 1:1, what `Z` toggles. */
  toggleZoom(anchorX?: number, anchorY?: number): void {
    const oneToOne = oneToOneScale(this.frame, this.photoWidth);
    const fitted = this.viewport.fit || this.viewport.scale < oneToOne - 0.001;
    this.zoomTo(fitted ? oneToOne : 1, anchorX, anchorY);
  }

  zoomToFit(): void {
    this.setViewport(FIT_VIEWPORT);
  }

  zoomToActual(): void {
    this.zoomTo(oneToOneScale(this.frame, this.photoWidth));
  }

  /** A pan drag, in canvas CSS pixels: the picture follows the pointer. */
  panBy(dx: number, dy: number): void {
    this.setViewport(
      panViewport(this.frame, this.viewport, dx * devicePixelRatio, dy * devicePixelRatio),
    );
  }

  private setViewport(next: ViewportState): void {
    const current = this.viewport;
    if (
      next.fit === current.fit &&
      next.scale === current.scale &&
      next.centerX === current.centerX &&
      next.centerY === current.centerY
    ) {
      return;
    }
    this.viewport = next;
    this.requestRender();
  }

  /** The crop tool's switch: the next frames show the whole image, or the cropped one. */
  setGeometry(mode: GeometryMode): void {
    if (mode === this.geometry) return;
    this.geometry = mode;
    this.requestRender();
  }

  requestRender(): void {
    if (this.viewId === null) return;
    if (this.renderInFlight) {
      this.renderQueued = true;
      return;
    }
    this.renderInFlight = true;
    this.renderSentAt = performance.now();
    const params: ViewRenderParams = {
      viewId: this.viewId,
      width: this.renderWidth,
      height: this.renderHeight,
    };
    // Left out unless a tool asked for it, so an engine older than the field still answers.
    if (this.geometry !== "stack") params.geometry = this.geometry;
    // Always sent, because the field is sticky per view: leaving it out means "stay where
    // you are", so Ctrl+0 has to say `scale: 1` rather than say nothing. A scale of 1 with
    // no centre is fit, which is what every render did before the field existed.
    params.viewport = this.viewport.fit
      ? { scale: 1 }
      : {
          scale: this.viewport.scale,
          centerX: this.viewport.centerX,
          centerY: this.viewport.centerY,
        };
    void this.engine
      .call("view.render", params)
      .then((result) => {
        this.engineMs = result.renderMs + result.readbackMs;
        // Where the photo sits inside the frame the engine just sent, and how to get from
        // a mask coordinate to a frame pixel. An engine that answers with neither leaves
        // the overlay on its own letterbox of the frame, which is the uncropped case.
        this.overlay.setContentRect(result.contentRect ?? null);
        const transform = (result.imageTransform ?? null) as ImageTransform | null;
        this.overlay.setImageTransform(transform);
        this.frame = {
          contentRect: result.contentRect ?? [0, 0, result.width, result.height],
          frameWidth: result.width,
          frameHeight: result.height,
          transform: transform ?? IDENTITY_IMAGE_TRANSFORM,
          scale: result.viewport?.scale ?? 1,
        };
        // The engine clamps the pan and echoes what it used; showing what was asked for
        // instead would leave the readout a frame ahead of the picture.
        if (result.viewport) {
          this.viewport = {
            scale: result.viewport.scale ?? 1,
            centerX: result.viewport.centerX ?? 0.5,
            centerY: result.viewport.centerY ?? 0.5,
            fit: result.viewport.fit ?? true,
          };
        }
        this.zoom = zoomLabel(this.viewport, oneToOneScale(this.frame, this.photoWidth));
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        this.renderInFlight = false;
        if (this.renderQueued) {
          this.renderQueued = false;
          this.requestRender();
        }
      });
  }

  async setParam(op: string, params: Record<string, unknown>, transient: boolean): Promise<void> {
    if (this.photoId === null) return;
    // A drag can outrun the first reply; wait for the add so the second move updates
    // the new op instead of adding a duplicate.
    const pendingAdd = this.addsInFlight.find((entry) => entry.op === op);
    if (pendingAdd) await pendingAdd.request;
    const existing = this.stack.find((entry) => entry.op === op);
    if (existing) return this.updateOp(existing.id, params, transient);
    return this.addOp(op, params, transient);
  }

  setOpParams(opId: string, params: Record<string, unknown>, transient: boolean): Promise<void> {
    return this.updateOp(opId, params, transient);
  }

  selectOp(opId: string | null): void {
    this.selectedOpId = opId;
  }

  /**
   * Layer opacity, 0–100. `transient` is a readout still being dragged: no snapshot, and
   * the tick is dropped while another write is in flight so a drag cannot queue up.
   */
  setOpacity(opId: string, value: number, transient: boolean): Promise<void> {
    if (transient && this.stackWriteBusy) return Promise.resolve();
    return this.writeOp({ opId, params: {}, opacity: value, transient });
  }

  /**
   * Replaces one op's mask, or clears it with `null`. Never a merge: a mask is an ordered
   * list and merging two of them by index is not something a caller can reason about.
   */
  setMask(opId: string, mask: Mask | undefined, transient = false): Promise<void> {
    if (transient && this.stackWriteBusy) return Promise.resolve();
    return this.writeOp({ opId, params: {}, mask: mask ?? null, transient });
  }

  setEnabled(opId: string, enabled: boolean): Promise<void> {
    return this.writeOp({ opId, params: {}, enabled, transient: false });
  }

  /** Reorder, duplicate, delete: the whole stack in the order it should end up in. */
  setStack(stack: Op[]): Promise<void> {
    return this.writeStack(() => stack);
  }

  async undo(): Promise<void> {
    if (this.photoId === null || !this.canUndo) return;
    this.applyStack(await this.engine.call("history.undo", { photoId: this.photoId }));
    this.requestRender();
  }

  async redo(): Promise<void> {
    if (this.photoId === null || !this.canRedo) return;
    this.applyStack(await this.engine.call("history.redo", { photoId: this.photoId }));
    this.requestRender();
  }

  // The first tick of a drag adds the op transiently, so the whole drag undoes as one step.
  private addOp(op: string, params: Record<string, unknown>, transient: boolean): Promise<void> {
    const photoId = this.photoId;
    if (photoId === null) return Promise.resolve();
    const request = this.engine
      .call("op.add", { photoId, op, params, transient })
      .then((state) => {
        this.applyStack(state);
        this.requestRender();
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        const index = this.addsInFlight.findIndex((entry) => entry.op === op);
        if (index >= 0) this.addsInFlight.splice(index, 1);
      });
    this.addsInFlight.push({ op, request });
    return request;
  }

  private updateOp(
    opId: string,
    params: Record<string, unknown>,
    transient: boolean,
  ): Promise<void> {
    const queued = this.queuedUpdates.find((entry) => entry.opId === opId);
    if (queued) {
      Object.assign(queued.params, params);
      queued.transient = transient;
    } else {
      this.queuedUpdates.push({ opId, params: { ...params }, transient });
    }
    return this.flushUpdates();
  }

  /** Drains the queue; entries enqueued during an await are picked up by the same loop. */
  private async flushUpdates(): Promise<void> {
    if (this.updateInFlight) return;
    this.updateInFlight = true;
    try {
      while (this.queuedUpdates.length > 0) {
        const update = this.queuedUpdates.shift();
        const photoId = this.photoId;
        if (!update || photoId === null) break;
        const { opId, params, transient } = update;
        this.applyStack(await this.engine.call("op.update", { photoId, opId, params, transient }));
        this.requestRender();
      }
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.updateInFlight = false;
    }
  }

  /**
   * The layer half of `op.update` — mask, opacity, enabled — on the same one-at-a-time
   * chain as the whole-stack writes, so a reorder and a mask edit cannot cross.
   */
  private writeOp(update: Omit<OpUpdateParams, "photoId">): Promise<void> {
    this.stackWriteBusy = true;
    const run = this.stackWrites
      .then(async () => {
        const photoId = this.photoId;
        if (photoId === null) return;
        this.applyStack(await this.engine.call("op.update", { ...update, photoId }));
        this.requestRender();
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        if (this.stackWrites === run) this.stackWriteBusy = false;
      });
    this.stackWrites = run;
    return run;
  }

  /**
   * One whole-stack write at a time, each built from the mirror as it is when the call goes
   * out — two reorders in a row must not both start from the stack before the first one.
   */
  private writeStack(transform: (stack: Op[]) => Op[]): Promise<void> {
    this.stackWriteBusy = true;
    const run = this.stackWrites
      .then(async () => {
        const photoId = this.photoId;
        if (photoId === null) return;
        const stack = transform(this.stack);
        this.applyStack(await this.engine.call("stack.set", { photoId, stack }));
        this.requestRender();
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        if (this.stackWrites === run) this.stackWriteBusy = false;
      });
    this.stackWrites = run;
    return run;
  }

  private applyStack(state: StackGetResult): void {
    this.stack = state.stack;
    this.revision = state.revision;
    this.canUndo = state.canUndo;
    this.canRedo = state.canRedo;
    // An op that undo or a script took out of the stack cannot stay selected.
    const selected = this.selectedOpId;
    if (selected !== null && !state.stack.some((op) => op.id === selected)) {
      this.selectedOpId = null;
    }
  }
}

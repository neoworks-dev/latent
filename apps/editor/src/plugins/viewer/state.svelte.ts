import {
  baseLayerMap,
  clampViewportScale,
  contentRectFor,
  type EngineClient,
  type EngineFrame,
  FIT_VIEWPORT,
  type FrameLayer,
  type FrameSink,
  frameTransform,
  type GeometryMode,
  type GeometryView,
  IDENTITY_IMAGE_TRANSFORM,
  type ImageTransform,
  MIN_VIEWPORT_SCALE,
  oneToOneScale,
  panViewport,
  transformImageMatrix,
  type ViewerService,
  type ViewportFrame,
  type ViewportState,
  zoomLabel,
  zoomViewport,
} from "@latent/contracts";
import type {
  Histogram,
  Mask,
  Op,
  OpUpdateParams,
  StackGetResult,
  ViewRenderParams,
} from "@latent/protocol";
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
 * How often a live zoom or pan asks the engine for pixels. The gesture itself is on screen
 * immediately — the painter moves the frame it already has — so these renders only sharpen
 * it, and each one is a 4 MB frame whose transfer is the whole of the frame budget
 * (PROMPT.md 8.1). A trailing render always follows, so the picture a gesture settles on is
 * the engine's and not the painter's.
 */
const VIEWPORT_RENDER_INTERVAL_MS = 60;

/**
 * How long after a draft frame (view.render `draft`) the full frame follows, unless another
 * draft has been asked for since. Drafts go out while a slider or the view is being dragged;
 * this is what notices the drag has stopped, whatever the control did or did not send at
 * the end of it.
 */
const DRAFT_SETTLE_MS = 120;

/**
 * How long a zoomed view waits after its last frame before it renders the base layer again
 * (painter.ts). The base layer is only what a pan or a zoom out uncovers, so it can lag an
 * edit; rendering it during a drag would put a second frame on the wire behind every tick.
 */
const BASE_RENDER_DELAY_MS = 300;

/**
 * How long `adjusting` stays up after the last adjustment write: past the gap between two
 * ticks of a slow drag, short enough that the mask tint is back before the next slider.
 */
const ADJUSTING_HOLD_MS = 700;

/**
 * Field by field, never by identity: `viewport` is a `$state` proxy and the rest are the
 * plain objects it was assigned from, so `===` between the two is the equality mismatch
 * Svelte warns about and is false even when they hold the same numbers.
 */
function sameViewport(a: ViewportState, b: ViewportState): boolean {
  return (
    a.fit === b.fit && a.scale === b.scale && a.centerX === b.centerX && a.centerY === b.centerY
  );
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
  /**
   * The undo stack's cursor and depth. `revision` counts every write the engine took, drag
   * ticks included, so it is not what a "which step am I on" readout should show.
   */
  historyIndex = $state(0);
  historyDepth = $state(1);
  /**
   * The histogram of the frame on screen, straight off `view.render`. The one on
   * `stack.get` is measured from whatever the view drew last, which is the frame *before*
   * the edit being answered, so it is deliberately not read here.
   */
  histogram = $state<Histogram | null>(null);
  status = $state("no photo");
  latencyMs = $state(0);
  engineMs = $state(0);
  /** Which op the Masks and Layers columns are pointed at. View state, not edit state. */
  selectedOpId = $state<string | null>(null);
  /**
   * The layer the Edit column's sliders write into while the Masks panel holds a mask
   * selected (contracts ViewerService). View state: it decides where a write goes, not what
   * any op holds.
   */
  maskTarget = $state<string | null>(null);
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
  /**
   * The shell's floating cards, in CSS pixels. Deliberately not `$state`: the shell writes
   * it from an `$effect`, and the only reader is the render call.
   */
  private insets = { left: 0, top: 0, right: 0, bottom: 0 };
  /** `Fit`, `100%`, `250%` — the status bar's readout. */
  zoom = $state("Fit");
  /**
   * How often the engine has put the photo somewhere else in the frame. Bumped from the
   * render reply and never from a prediction: a client-side zoom is on screen before the
   * engine knows about it, and a view-space raster asked for in that moment would come back
   * rendered at the viewport the gesture has already left (contracts ViewerService).
   */
  frameGeometry = $state(0);
  /** An adjustment was written in the last `ADJUSTING_HOLD_MS` (contracts ViewerService). */
  adjusting = $state(false);
  private adjustingTimer: ReturnType<typeof setTimeout> | null = null;
  readonly overlay = new ViewerOverlayState();

  // The last frame the engine answered about. Not what is on screen once a gesture has
  // moved on from it — `shownFrame` is — but it is the reference every prediction below is
  // measured from, and the only thing here the engine has confirmed.
  private frame: ViewportFrame = {
    contentRect: [0, 0, 1, 1],
    frameWidth: 1,
    frameHeight: 1,
    transform: IDENTITY_IMAGE_TRANSFORM,
    scale: 1,
    insets: { left: 0, top: 0, right: 0, bottom: 0 },
  };
  /** Whether that frame came with a content rect and a matrix, or from an engine without. */
  private frameMapped = false;
  private photoWidth = 0;
  /** The viewport `this.frame` describes. */
  private frameViewport: ViewportState = FIT_VIEWPORT;
  /**
   * The viewport the pixels on the GPU were rendered at. The same thing one reply later,
   * and different from it only in the moment between the binary frame and the JSON that
   * describes it.
   */
  private textureViewport: ViewportState = FIT_VIEWPORT;
  /** The viewport the render in flight carries. */
  private sentViewport: ViewportState = FIT_VIEWPORT;
  private viewportRenderAt = 0;
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The second view on the photo, always fitted, whose frames are the painter's base layer
   * while the main view is zoomed. While the main view is fitted its own frames are the
   * base layer and this one renders nothing.
   */
  private baseViewId: number | null = null;
  /** image-normalised → pixel of the frame in the base layer, or no base layer yet. */
  private baseTransform: ImageTransform | null = null;
  /** The stack revision the base layer shows; -1 when it has to be rendered again. */
  private baseRevision = -1;
  private baseRenderInFlight = false;
  private baseTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeBaseFrame: (() => void) | null = null;

  private renderWidth = 1;
  private renderHeight = 1;
  /** The view size the render in flight asked for: what its frame is drawn over. */
  private sentWidth = 1;
  private sentHeight = 1;
  private renderInFlight = false;
  private renderQueued = false;
  /** Whether anything behind the render in flight asked for a full frame, not a draft. */
  private queuedFull = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
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
  private readonly unsubscribeResolution: () => void;
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
    // The photo was opened off the engine's cached preview and the real decode has now
    // landed behind it. Nothing about the stack changed, so only the pixels are stale.
    this.unsubscribeResolution = engine.on("photo.resolution", (params) => {
      if (params.photoId !== this.photoId) return;
      this.baseRevision = -1;
      this.requestRender();
    });
  }

  dispose(): void {
    if (this.presentHandle !== null) cancelAnimationFrame(this.presentHandle);
    this.presentHandle = null;
    if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
    this.viewportTimer = null;
    if (this.adjustingTimer !== null) clearTimeout(this.adjustingTimer);
    this.adjustingTimer = null;
    if (this.baseTimer !== null) clearTimeout(this.baseTimer);
    this.baseTimer = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.unsubscribeFrame?.();
    this.unsubscribeBaseFrame?.();
    this.unsubscribeStack();
    this.unsubscribeResolution();
  }

  /**
   * What is actually on screen: the engine's last frame, moved to wherever the viewport has
   * been dragged or zoomed to since. Every gesture measures against this rather than
   * against `frame` — an anchor taken against the stale rect zooms about the wrong point,
   * and a pan delta taken against it is applied twice.
   */
  private get shownFrame(): ViewportFrame {
    const moved = frameTransform(this.frame, this.frameViewport, this.viewport);
    return {
      contentRect: contentRectFor(this.frame, this.viewport),
      frameWidth: this.frame.frameWidth,
      frameHeight: this.frame.frameHeight,
      transform: transformImageMatrix(moved, this.frame.transform),
      scale: this.viewport.fit ? MIN_VIEWPORT_SCALE : clampViewportScale(this.viewport.scale),
      insets: this.frame.insets,
    };
  }

  /**
   * Where the painter's base layer lands on the canvas right now, as the map it samples by:
   * canvas pixel → base frame pixel. Without matrices from the engine there is nothing to
   * map through, and the base layer stays out.
   */
  private baseMap(): ImageTransform | null {
    if (!this.frameMapped || this.baseTransform === null) return null;
    return baseLayerMap(this.baseTransform, this.shownFrame.transform);
  }

  /** Both layers moved to the viewport the user is at, in one draw. */
  private placeLayers(): void {
    this.frameSink?.setTransform(
      frameTransform(this.frame, this.textureViewport, this.viewport),
      this.baseMap(),
    );
  }

  /**
   * Moves the frame already on the GPU to where the viewport now says it is, and moves the
   * overlay with it. This is the whole point of the client-side transform: a wheel notch or
   * a pan step is on screen in the event that caused it, and the engine's next frame only
   * replaces a blur with the real pixels.
   */
  private showViewport(): void {
    this.placeLayers();
    // Nothing has moved past the frame the engine answered about, so its own rect and matrix
    // are on the overlay already and they are exact where a prediction is only close.
    if (!this.frameMapped || sameViewport(this.viewport, this.frameViewport)) return;
    const shown = this.shownFrame;
    this.overlay.setContentRect(shown.contentRect);
    this.overlay.setImageTransform(shown.transform);
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
    // These pixels are the viewport that was in flight; whatever the user did while they
    // were on the wire is still the painter's to show. A frame of a different size is a
    // resize rather than a gesture, and `frame` is no longer a reference for either rect.
    const sized =
      this.sentWidth === this.frame.frameWidth && this.sentHeight === this.frame.frameHeight;
    this.textureViewport = sized ? this.sentViewport : this.viewport;
    // A fitted frame is the whole photo, which is exactly what the base layer is for, and a
    // zoomed one is the detail over it. The base layer needs the engine's matrices to be
    // mapped, so until the first reply has brought them every frame is detail.
    const layer: FrameLayer = this.sentViewport.fit && this.frameMapped ? "base" : "detail";
    if (layer === "base") {
      this.frameSink?.dropDetail();
      // The reply corrects this; until it lands, the frame it describes is predicted from
      // the one before, which is exact unless the view was resized in between.
      this.baseTransform = transformImageMatrix(
        frameTransform(this.frame, this.frameViewport, this.sentViewport),
        this.frame.transform,
      );
    }
    this.placeLayers();
    const view = { width: this.sentWidth, height: this.sentHeight };
    const marks = this.frameSink?.draw(frame, layer, view);
    // The overlay letterboxes to the frame's aspect, so it follows the view the frame was
    // rendered for — a draft's own pixels are half of it.
    this.overlay.setImageSize(view.width, view.height);
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
    // A new photo is a new frame: whatever the last one was zoomed to means nothing here,
    // and neither does the histogram of the picture that was on screen.
    this.viewport = FIT_VIEWPORT;
    this.frameViewport = FIT_VIEWPORT;
    this.textureViewport = FIT_VIEWPORT;
    this.zoom = "Fit";
    this.histogram = null;
    // Switching photos: the previous views are the engine's to free, not ours to leak.
    const previousView = this.viewId;
    if (previousView !== null) await this.engine.call("view.close", { viewId: previousView });
    const previousBase = this.baseViewId;
    if (previousBase !== null) await this.engine.call("view.close", { viewId: previousBase });
    this.baseViewId = null;
    this.baseTransform = null;
    this.baseRevision = -1;
    const view = await this.engine.call("view.open", {
      photoId: photo.photoId,
      width: this.renderWidth,
      height: this.renderHeight,
    });
    this.viewId = view.viewId;
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = this.engine.onFrame(view.viewId, (frame) => this.paint(frame));
    const baseView = await this.engine.call("view.open", {
      photoId: photo.photoId,
      width: this.renderWidth,
      height: this.renderHeight,
    });
    this.baseViewId = baseView.viewId;
    this.unsubscribeBaseFrame?.();
    this.unsubscribeBaseFrame = this.engine.onFrame(baseView.viewId, (frame) => {
      this.placeLayers();
      this.frameSink?.draw(frame, "base", {
        width: frame.header.width,
        height: frame.header.height,
      });
    });
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
    const shown = this.shownFrame;
    const x = anchorX === undefined ? shown.frameWidth / 2 : anchorX * devicePixelRatio;
    const y = anchorY === undefined ? shown.frameHeight / 2 : anchorY * devicePixelRatio;
    this.setViewport(zoomViewport(shown, scale, x, y));
  }

  /** A step of the wheel or of `+`/`-`: a ratio, so every zoom level feels the same. */
  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    this.zoomTo(this.viewport.scale * factor, anchorX, anchorY);
  }

  /** Fit ↔ 1:1, what `Z` toggles. */
  toggleZoom(anchorX?: number, anchorY?: number): void {
    const oneToOne = oneToOneScale(this.shownFrame, this.photoWidth);
    const fitted = this.viewport.fit || this.viewport.scale < oneToOne - 0.001;
    this.zoomTo(fitted ? oneToOne : 1, anchorX, anchorY);
  }

  zoomToFit(): void {
    this.setViewport(FIT_VIEWPORT);
  }

  zoomToActual(): void {
    this.zoomTo(oneToOneScale(this.shownFrame, this.photoWidth));
  }

  /**
   * A pan drag, in canvas CSS pixels: the picture follows the pointer. One move at a time
   * and no accumulator, because `shownFrame` already has every earlier move in it — the
   * frame the engine last sent does not, which is what the accumulator used to make up for.
   */
  panBy(dx: number, dy: number): void {
    this.setViewport(
      panViewport(this.shownFrame, this.viewport, dx * devicePixelRatio, dy * devicePixelRatio),
    );
  }

  private setViewport(next: ViewportState): void {
    if (sameViewport(next, this.viewport)) return;
    this.viewport = next;
    this.zoom = zoomLabel(next, oneToOneScale(this.shownFrame, this.photoWidth));
    this.showViewport();
    this.scheduleViewportRender();
  }

  /**
   * A viewport gesture asks the engine for pixels on an interval rather than per event: the
   * painter is already showing the move, so these renders sharpen it. The timer is always
   * rearmed, which makes the last one of a gesture its trailing render.
   */
  private scheduleViewportRender(): void {
    if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
    const due = this.viewportRenderAt + VIEWPORT_RENDER_INTERVAL_MS - performance.now();
    this.viewportTimer = setTimeout(
      () => {
        this.viewportTimer = null;
        this.requestRender(true);
      },
      Math.max(0, due),
    );
  }

  setInsets(insets: { left: number; top: number; right: number; bottom: number }): void {
    const current = this.insets;
    if (
      insets.left === current.left &&
      insets.top === current.top &&
      insets.right === current.right &&
      insets.bottom === current.bottom
    ) {
      return;
    }
    this.insets = { ...insets };
    this.requestRender();
  }

  /** The crop tool's switch: the next frames show the whole image, or the cropped one. */
  setGeometry(mode: GeometryMode): void {
    if (mode === this.geometry) return;
    this.geometry = mode;
    this.requestRender();
  }

  /**
   * `draft` is for a frame in the middle of a drag: half the pixels each way, so a quarter of
   * the bytes on the wire (view.render `draft`), with the full frame following
   * `DRAFT_SETTLE_MS` after the last one. Anything asking for a full frame wins over a draft
   * queued with it.
   */
  requestRender(draft = false): void {
    if (this.viewId === null) return;
    // Whatever the gesture had scheduled, this render carries the current viewport anyway.
    if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
    this.viewportTimer = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.viewportRenderAt = performance.now();
    if (this.renderInFlight) {
      this.renderQueued = true;
      if (!draft) this.queuedFull = true;
      return;
    }
    this.renderInFlight = true;
    this.renderSentAt = performance.now();
    this.sentWidth = this.renderWidth;
    this.sentHeight = this.renderHeight;
    const params: ViewRenderParams = {
      viewId: this.viewId,
      width: this.renderWidth,
      height: this.renderHeight,
    };
    // Left out of a full frame, so an engine older than the field still answers.
    if (draft) params.draft = true;
    // Left out unless a tool asked for it, so an engine older than the field still answers.
    if (this.geometry !== "stack") params.geometry = this.geometry;
    // The panels are in CSS pixels and the frame is in device pixels, so the insets are
    // scaled like every other size on this call.
    const insets = {
      left: Math.round(this.insets.left * devicePixelRatio),
      top: Math.round(this.insets.top * devicePixelRatio),
      right: Math.round(this.insets.right * devicePixelRatio),
      bottom: Math.round(this.insets.bottom * devicePixelRatio),
    };
    params.insets = insets;
    this.sentViewport = this.viewport;
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
        this.frameMapped = (result.contentRect ?? null) !== null && transform !== null;
        // The engine clamps the viewport and echoes what it used, so the echo — not what
        // was asked for — is what these pixels are, and the prediction every gesture is
        // measured against has to start from it.
        const rendered: ViewportState = result.viewport
          ? {
              scale: result.viewport.scale ?? 1,
              centerX: result.viewport.centerX ?? 0.5,
              centerY: result.viewport.centerY ?? 0.5,
              fit: result.viewport.fit ?? true,
            }
          : this.sentViewport;
        const rect = result.contentRect ?? [0, 0, result.width, result.height];
        const matrix = transform ?? IDENTITY_IMAGE_TRANSFORM;
        // A slider tick lands the photo on exactly the pixels it was on; a zoom, a pan, a
        // resize or a crop does not, and everything holding a raster of this frame has to
        // hear about it.
        const moved =
          result.width !== this.frame.frameWidth ||
          result.height !== this.frame.frameHeight ||
          rect.some((value, index) => value !== this.frame.contentRect[index]) ||
          matrix.some((value, index) => value !== this.frame.transform[index]);
        if (moved) this.frameGeometry += 1;
        this.frame = {
          contentRect: rect,
          frameWidth: result.width,
          frameHeight: result.height,
          transform: matrix,
          scale: rendered.scale,
          // The insets this frame was rendered with, so the next zoom or pan is clamped
          // against the same hole the engine placed the picture in.
          insets,
        };
        this.frameViewport = rendered;
        this.textureViewport = rendered;
        if (rendered.fit) {
          this.baseTransform = matrix;
          this.baseRevision = result.revision;
        } else if (this.baseRevision !== result.revision) {
          this.scheduleBaseRender();
        }
        // Taking the echo while a newer viewport is pending would drag the picture back to
        // where the gesture was a frame ago; the difference between the two is exactly what
        // the painter is showing, so leaving it alone is what keeps the drag smooth.
        if (!this.renderQueued && this.viewportTimer === null) this.viewport = rendered;
        this.zoom = zoomLabel(this.viewport, oneToOneScale(this.frame, this.photoWidth));
        this.showViewport();
        if (result.histogram) this.histogram = result.histogram;
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        this.renderInFlight = false;
        if (this.renderQueued) {
          const full = this.queuedFull;
          this.renderQueued = false;
          this.queuedFull = false;
          this.requestRender(!full);
          return;
        }
        if (!draft) return;
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          this.requestRender();
        }, DRAFT_SETTLE_MS);
      });
  }

  /**
   * The base layer again, once the main view has been quiet for `BASE_RENDER_DELAY_MS`. Each
   * zoomed frame rearms the timer, so a drag renders it once at the end and not per tick.
   */
  private scheduleBaseRender(): void {
    if (this.baseTimer !== null) clearTimeout(this.baseTimer);
    this.baseTimer = setTimeout(() => {
      this.baseTimer = null;
      this.renderBase();
    }, BASE_RENDER_DELAY_MS);
  }

  /**
   * A fitted frame of the base view, for the painter's base layer. It waits for the main
   * view's render rather than queueing behind it in the engine, which would put a whole
   * extra frame in front of the next slider tick.
   */
  private renderBase(): void {
    const viewId = this.baseViewId;
    if (viewId === null || this.baseRenderInFlight) return;
    if (this.viewport.fit) return;
    if (this.renderInFlight || this.renderQueued) {
      this.scheduleBaseRender();
      return;
    }
    this.baseRenderInFlight = true;
    const params: ViewRenderParams = {
      viewId,
      width: this.renderWidth,
      height: this.renderHeight,
      viewport: { scale: 1 },
    };
    if (this.geometry !== "stack") params.geometry = this.geometry;
    void this.engine
      .call("view.render", params)
      .then((result) => {
        // A photo switch while this was in flight closed the view it came from.
        if (viewId !== this.baseViewId) return;
        const transform = (result.imageTransform ?? null) as ImageTransform | null;
        if (transform === null) return;
        this.baseTransform = transform;
        this.baseRevision = result.revision;
        this.placeLayers();
        if (result.revision !== this.revision) this.scheduleBaseRender();
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        this.baseRenderInFlight = false;
      });
  }

  /**
   * Every write to what an op does — not to its mask — keeps `adjusting` up until the
   * writes stop. A drag ticks far inside the hold, and a click or a key nudge gets the same
   * brief window, so the mask tint is off for exactly as long as the user is judging pixels.
   */
  private markAdjusting(): void {
    this.adjusting = true;
    if (this.adjustingTimer !== null) clearTimeout(this.adjustingTimer);
    this.adjustingTimer = setTimeout(() => {
      this.adjustingTimer = null;
      this.adjusting = false;
    }, ADJUSTING_HOLD_MS);
  }

  async setParam(op: string, params: Record<string, unknown>, transient: boolean): Promise<void> {
    if (this.photoId === null) return;
    this.markAdjusting();
    // A mask is selected: the Edit column's sliders are that mask's, so the write goes into
    // its layer and adds the adjustment there rather than to the photo.
    const target = this.maskTarget;
    if (target !== null && this.stack.some((entry) => entry.id === target)) {
      return this.setGroupParam(target, op, params, transient);
    }
    // A drag can outrun the first reply; wait for the add so the second move updates
    // the new op instead of adding a duplicate.
    const pendingAdd = this.addsInFlight.find((entry) => entry.op === op);
    if (pendingAdd) await pendingAdd.request;
    const existing = this.stack.find((entry) => entry.op === op);
    if (existing) return this.updateOp(existing.id, params, transient);
    return this.addOp(op, params, transient);
  }

  setOpParams(opId: string, params: Record<string, unknown>, transient: boolean): Promise<void> {
    this.markAdjusting();
    return this.updateOp(opId, params, transient);
  }

  /** A new layer: an empty group, waiting for a mask and the adjustments under it. */
  async addGroup(): Promise<string | null> {
    const photoId = this.photoId;
    if (photoId === null) return null;
    try {
      const state = await this.engine.call("op.add", { photoId, op: "group" });
      this.applyStack(state);
      this.requestRender();
      return state.opId;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  /**
   * The layer's own `setParam`: the group's child with this op name, added to the group when
   * it is not there yet. A drag that starts on a slider the layer does not have is one add
   * followed by updates, the same shape `setParam` has for a global adjustment.
   */
  async setGroupParam(
    groupId: string,
    op: string,
    params: Record<string, unknown>,
    transient: boolean,
  ): Promise<void> {
    const photoId = this.photoId;
    if (photoId === null) return;
    this.markAdjusting();
    const pendingAdd = this.addsInFlight.find((entry) => entry.op === `${groupId}:${op}`);
    if (pendingAdd) await pendingAdd.request;
    const group = this.stack.find((entry) => entry.id === groupId);
    const existing = group?.ops?.find((entry) => entry.op === op);
    if (existing) return this.updateOp(existing.id, params, transient);
    const request = this.engine
      .call("op.add", { photoId, op, params, parentId: groupId, transient })
      .then((state) => {
        this.applyStack(state);
        this.requestRender(transient);
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        const index = this.addsInFlight.findIndex((entry) => entry.op === `${groupId}:${op}`);
        if (index >= 0) this.addsInFlight.splice(index, 1);
      });
    this.addsInFlight.push({ op: `${groupId}:${op}`, request });
    return request;
  }

  async removeOp(opId: string): Promise<void> {
    const photoId = this.photoId;
    if (photoId === null) return;
    try {
      this.applyStack(await this.engine.call("op.remove", { photoId, opId }));
      this.requestRender();
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  selectOp(opId: string | null): void {
    this.selectedOpId = opId;
  }

  setMaskTarget(opId: string | null): void {
    this.maskTarget = opId;
  }

  /**
   * Layer opacity, 0–100. `transient` is a readout still being dragged: no snapshot, and
   * the tick is dropped while another write is in flight so a drag cannot queue up.
   */
  setOpacity(opId: string, value: number, transient: boolean): Promise<void> {
    this.markAdjusting();
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

  /**
   * Reorder, duplicate, delete: the whole stack in the order it should end up in. `label`
   * is what the history row should call the step when the caller knows more than the diff
   * does — "Golden hour applied" rather than the name of whichever op sorts first.
   */
  setStack(stack: Op[], label?: string): Promise<void> {
    return this.writeStack(() => stack, label);
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
        this.requestRender(transient);
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
        this.requestRender(transient);
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
        this.requestRender(update.transient === true);
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
  private writeStack(transform: (stack: Op[]) => Op[], label?: string): Promise<void> {
    this.stackWriteBusy = true;
    const run = this.stackWrites
      .then(async () => {
        const photoId = this.photoId;
        if (photoId === null) return;
        const stack = transform(this.stack);
        this.applyStack(await this.engine.call("stack.set", { photoId, stack, label }));
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
    // Optional on the wire only so an older engine still typechecks; latentd and the mock
    // both send them.
    this.historyIndex = state.historyIndex ?? this.historyIndex;
    this.historyDepth = state.historyDepth ?? this.historyDepth;
    // An op that undo or a script took out of the stack cannot stay selected. A layer's
    // children are in the stack too, one level down (protocol Op.ops).
    const selected = this.selectedOpId;
    const present = state.stack.some(
      (op) => op.id === selected || (op.ops ?? []).some((child) => child.id === selected),
    );
    if (selected !== null && !present) this.selectedOpId = null;
    // A deleted layer must not keep catching the Edit column's writes.
    const target = this.maskTarget;
    if (target !== null && !state.stack.some((op) => op.id === target)) this.maskTarget = null;
  }
}

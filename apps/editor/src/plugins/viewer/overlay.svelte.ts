// The transparent canvas over the frame. The WebGL painter owns the pixels below it and
// never learns this exists; everything here is 2D canvas, pointer events and a rect.
//
// Coordinates. Two of them, and this is the only file that converts:
//
//   content  0..1 over the drawn image — the cropped, straightened, zoomed picture. A
//            handler's `x`/`y`, and the space the crop tool's handles live in.
//   image    0..1 over the *uncropped* photo. A handler's `imageX`/`imageY`, what every
//            mask component stores, and what `map` takes to canvas pixels and back. It
//            comes from the engine's `imageTransform`; without one the two coincide, which
//            is exactly true for a photo with no geometry on it.
//
// Painters see the content rect in the overlay canvas' own CSS-pixel space plus `map`.
import {
  applyImageTransform,
  containRect,
  type ContentRect,
  IDENTITY_IMAGE_TRANSFORM,
  type ImageTransform,
  imagePoint,
  invertImageTransform,
  type OverlayDraw,
  type OverlayMap,
  type OverlayPointer,
  type OverlayRect,
  type ViewerOverlay,
} from "@latent/contracts";

const EMPTY_RECT: OverlayRect = { x: 0, y: 0, width: 0, height: 0 };

export class ViewerOverlayState implements ViewerOverlay {
  /** The drawn image's box. Reactive so a pane can lay a cursor readout over it. */
  rect = $state<OverlayRect>(EMPTY_RECT);
  cursor = $state("default");
  /**
   * How many painters and handlers are attached. Reactive so the canvas can be taken off
   * the page entirely while no tool is using it: an empty accelerated 2D layer over the
   * viewer's WebGL layer is enough to stall Chromium's window capture, and a canvas nobody
   * draws on should not be eating pointer events either.
   */
  private attached = $state(0);
  // The plain twin of `attached`. `attachOverlay`/`onPointer` run inside a pane's `$effect`;
  // `attached += 1` there would read the signal it writes and re-run that effect forever
  // (effect_update_depth_exceeded). Count here, then assign — a write alone subscribes nothing.
  private attachedCount = 0;

  private context: CanvasRenderingContext2D | null = null;
  // A plain Set on purpose, and the one place this rule is wrong: `attachOverlay` is called
  // from an `$effect`, and a SvelteSet's `add` both reads and writes its signal — the effect
  // would re-run itself forever, detaching and reattaching the painter every flush.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly painters = new Set<OverlayDraw>();
  private readonly handlers: ((event: OverlayPointer) => boolean | void)[] = [];
  private readonly cursors: string[] = [];
  private frameHandle: number | null = null;
  private imageWidth = 0;
  private imageHeight = 0;
  private boxWidth = 0;
  private boxHeight = 0;
  private contentRect: ContentRect | null = null;
  // image -> frame pixel, straight from the engine, and the frame -> canvas scale that
  // turns it into image -> canvas. Both plain fields: `map` is read inside paint and
  // inside a pointer dispatch, neither of which is reactive.
  private transform: ImageTransform = IDENTITY_IMAGE_TRANSFORM;
  private inverse: ImageTransform = IDENTITY_IMAGE_TRANSFORM;
  private frameScale = 1;
  private frameOrigin = { x: 0, y: 0 };

  /** The canvas hands itself over on mount and takes itself back on unmount. */
  attachCanvas(canvas: HTMLCanvasElement): () => void {
    // CPU-rastered on purpose: the overlay draws a handful of shapes and one scaled mask
    // per repaint, and a second accelerated canvas layer over the frame costs more than it
    // pays for — it stalls the compositor's capture path on this machine.
    this.context = canvas.getContext("2d", { willReadFrequently: true });
    this.redraw();
    return () => {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
      this.context = null;
    };
  }

  /** The frame's pixel size: it decides the aspect the overlay letterboxes to. */
  setImageSize(width: number, height: number): void {
    if (width === this.imageWidth && height === this.imageHeight) return;
    this.imageWidth = width;
    this.imageHeight = height;
    this.measure();
  }

  /**
   * Where the engine put the photo inside the frame, in frame pixels (`view.render`'s
   * `contentRect`). Crop and rotate move it, and no client can derive it, so without it
   * the overlay can only assume the frame is all photo. `null` when the engine did not
   * send one.
   */
  setContentRect(rect: ContentRect | null): void {
    // A render result lands per frame, so an unchanged rect must not cost a repaint.
    const current = this.contentRect;
    if (rect === null && current === null) return;
    if (rect && current && rect.every((value, index) => value === current[index])) return;
    this.contentRect = rect;
    this.measure();
  }

  /**
   * The engine's `imageTransform` for the frame just drawn: image-normalised → frame pixel.
   * `null` from an engine that does not send one, which means the identity — the frame is
   * the whole photo. Cheap enough to take per frame; it only recomputes on a change.
   */
  setImageTransform(matrix: ImageTransform | null): void {
    const next = matrix ?? IDENTITY_IMAGE_TRANSFORM;
    if (next.every((value, index) => value === this.transform[index])) return;
    this.transform = next;
    this.inverse = invertImageTransform(next);
    this.redraw();
  }

  /**
   * Image ↔ canvas. The engine's matrix lands in *frame* pixels; the canvas shows that
   * frame letterboxed into the box, so one uniform scale and offset finishes the job.
   */
  get map(): OverlayMap {
    const toFrame = (x: number, y: number): { x: number; y: number } => {
      const point = applyImageTransform(this.transform, x, y);
      return {
        x: this.frameOrigin.x + point.x * this.frameScale,
        y: this.frameOrigin.y + point.y * this.frameScale,
      };
    };
    return {
      toCanvas: toFrame,
      toImage: (x: number, y: number) =>
        applyImageTransform(
          this.inverse,
          (x - this.frameOrigin.x) / this.frameScale,
          (y - this.frameOrigin.y) / this.frameScale,
        ),
      // The image's long edge in canvas pixels: what a brush diameter, which is a fraction
      // of that edge, is drawn with. Measured across the middle rather than at a corner,
      // so a keystone gives a sane average instead of its most distorted edge.
      scale: Math.max(
        Math.hypot(toFrame(1, 0.5).x - toFrame(0, 0.5).x, toFrame(1, 0.5).y - toFrame(0, 0.5).y),
        Math.hypot(toFrame(0.5, 1).x - toFrame(0.5, 0).x, toFrame(0.5, 1).y - toFrame(0.5, 0).y),
      ),
    };
  }

  /** The canvas' own CSS size, from the viewer's ResizeObserver. */
  setBoxSize(width: number, height: number): void {
    if (width === this.boxWidth && height === this.boxHeight) return;
    this.boxWidth = width;
    this.boxHeight = height;
    this.measure();
  }

  attachOverlay(draw: OverlayDraw): () => void {
    this.painters.add(draw);
    this.countAttached(1);
    this.redraw();
    return () => {
      this.painters.delete(draw);
      this.countAttached(-1);
      this.redraw();
    };
  }

  onPointer(handler: (event: OverlayPointer) => boolean | void): () => void {
    // Newest first: the tool that armed last gets the drag before the one under it.
    this.handlers.unshift(handler);
    this.countAttached(1);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
      this.countAttached(-1);
    };
  }

  private countAttached(delta: number): void {
    this.attachedCount += delta;
    this.attached = this.attachedCount;
  }

  setCursor(cursor: string): () => void {
    this.cursors.push(cursor);
    this.cursor = cursor;
    return () => {
      const index = this.cursors.indexOf(cursor);
      if (index >= 0) this.cursors.splice(index, 1);
      this.cursor = this.cursors.at(-1) ?? "default";
    };
  }

  /** True while something is drawing or listening: the canvas is only on the page then. */
  get active(): boolean {
    return this.attached > 0;
  }

  redraw(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.paint();
    });
  }

  /** Raw DOM event in, normalised event out, dispatched until a handler claims it. */
  dispatch(
    kind: OverlayPointer["kind"],
    event: PointerEvent | WheelEvent,
    box: { left: number; top: number },
  ): boolean {
    const canvasX = event.clientX - box.left;
    const canvasY = event.clientY - box.top;
    const point = imagePoint(canvasX, canvasY, this.rect);
    const image = this.map.toImage(canvasX, canvasY);
    const pointer: OverlayPointer = {
      kind,
      x: point.x,
      y: point.y,
      imageX: image.x,
      imageY: image.y,
      pointerId: event instanceof PointerEvent ? event.pointerId : 0,
      buttons: event.buttons,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      deltaY: event instanceof WheelEvent ? event.deltaY : 0,
    };
    for (const handler of [...this.handlers]) {
      if (handler(pointer) === true) return true;
    }
    return false;
  }

  private measure(): void {
    // The canvas letterboxes the whole frame into the box; the photo then sits inside that
    // at the engine's content rect, scaled by the same factor.
    const frame = containRect(this.imageWidth, this.imageHeight, this.boxWidth, this.boxHeight);
    const content = this.contentRect;
    if (!content || this.imageWidth <= 0 || frame.width <= 0) {
      this.frameScale = frame.width > 0 && this.imageWidth > 0 ? frame.width / this.imageWidth : 1;
      this.frameOrigin = { x: frame.x, y: frame.y };
      this.rect = frame;
      this.redraw();
      return;
    }
    const scale = frame.width / this.imageWidth;
    this.frameScale = scale;
    this.frameOrigin = { x: frame.x, y: frame.y };
    this.rect = {
      x: frame.x + content[0] * scale,
      y: frame.y + content[1] * scale,
      width: content[2] * scale,
      height: content[3] * scale,
    };
    this.redraw();
  }

  private paint(): void {
    const context = this.context;
    if (!context) return;
    const canvas = context.canvas;
    const ratio = devicePixelRatio;
    const width = Math.round(this.boxWidth * ratio);
    const height = Math.round(this.boxHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, this.boxWidth, this.boxHeight);
    const map = this.map;
    for (const draw of this.painters) draw(context, this.rect, map);
  }
}

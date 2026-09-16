// The transparent canvas over the frame. The WebGL painter owns the pixels below it and
// never learns this exists; everything here is 2D canvas, pointer events and a rect.
//
// Coordinates: handlers see image-normalised 0..1 points, painters see the content rect in
// the overlay canvas' own CSS-pixel space. Nothing outside this file converts between them.
import {
  containRect,
  imagePoint,
  type OverlayDraw,
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
    const point = imagePoint(event.clientX - box.left, event.clientY - box.top, this.rect);
    const pointer: OverlayPointer = {
      kind,
      x: point.x,
      y: point.y,
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
    this.rect = containRect(this.imageWidth, this.imageHeight, this.boxWidth, this.boxHeight);
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
    for (const draw of this.painters) draw(context, this.rect);
  }
}

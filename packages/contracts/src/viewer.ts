// The open photo as the engine reports it. Every field is a mirror of the engine's
// answer, never a local edit: a control calls `setParam`, the engine replies with the
// new stack, the mirror updates and a frame is requested. Nothing here is edit state.
import type { Mask, Op } from "@latent/protocol";
import type { EngineFrame } from "./engine";

/** When the painter touched a frame, in `performance.now()` terms. */
export interface FrameDrawMarks {
  drawStarted: number;
  uploaded: number;
  drawn: number;
}

/** Uploads and draws one frame, synchronously, and reports how long each part took. */
export type FrameSink = (frame: EngineFrame) => FrameDrawMarks;

/**
 * Where the photo actually sits inside the viewer's box, in CSS pixels of the overlay
 * canvas' own coordinate system. The frame is letterboxed (`object-contain`), so this is
 * never the whole box; a tool draws in here and nowhere else.
 */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where an image of `imageWidth`×`imageHeight` lands inside a `boxWidth`×`boxHeight` box
 * under `object-fit: contain` — the canvas' own letterbox rule, so the overlay sits on the
 * photo and not on the bars beside it. A box or an image with no area yields an empty rect
 * at the origin rather than a NaN one.
 */
export function containRect(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
): OverlayRect {
  if (imageWidth <= 0 || imageHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height };
}

/**
 * A point in the box, in image-normalised coordinates: 0..1 across the drawn image, and
 * outside that range when the pointer is on the letterbox. Tools clamp; the overlay does
 * not, so a drag that leaves the photo still reads as a direction.
 */
export function imagePoint(x: number, y: number, rect: OverlayRect): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return { x: (x - rect.x) / rect.width, y: (y - rect.y) / rect.height };
}

/** Draws on top of the frame. Called on every overlay repaint, never per engine frame. */
export type OverlayDraw = (context: CanvasRenderingContext2D, rect: OverlayRect) => void;

/**
 * A pointer over the photo, in image-normalised coordinates: `x`/`y` are 0..1 across the
 * drawn image and are outside that range when the pointer left it. `deltaY` is the wheel's,
 * zero otherwise.
 */
export interface OverlayPointer {
  kind: "down" | "move" | "up" | "cancel" | "wheel";
  x: number;
  y: number;
  pointerId: number;
  buttons: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  deltaY: number;
}

/**
 * The transparent canvas the viewer keeps over the frame, sized and positioned exactly on
 * the drawn image. Masks and crop draw here; the WebGL frame path never sees any of it.
 * A handler that returns true has consumed the event.
 */
export interface ViewerOverlay {
  /** The drawn image's rect. Reactive: it changes with the frame size and the viewport. */
  readonly rect: OverlayRect;
  /** Registers a painter and repaints. Returns the detach, which repaints again. */
  attachOverlay(draw: OverlayDraw): () => void;
  /** Pointer and wheel events over the image, newest handler first. Returns the removal. */
  onPointer(handler: (event: OverlayPointer) => boolean | void): () => void;
  /** Ask for a repaint; coalesced to one animation frame. */
  redraw(): void;
  /** CSS cursor while a tool owns the overlay. Returns the restore. */
  setCursor(cursor: string): () => void;
  /** The cursor the canvas should wear right now, newest `setCursor` wins. */
  readonly cursor: string;
  /** Whether anything is drawing on or listening to the overlay; it is off the page if not. */
  readonly active: boolean;

  // The three below belong to the canvas that hosts the overlay — the viewer's own
  // component calls them on mount and on every DOM event. A plugin uses the four above.

  /** The host canvas hands itself over; the inverse gives it back. */
  attachCanvas(canvas: HTMLCanvasElement): () => void;
  /** The host canvas' CSS size, so the letterbox rect can be computed. */
  setBoxSize(width: number, height: number): void;
  /** Raw DOM event in, normalised pointer out. True when a handler consumed it. */
  dispatch(
    kind: OverlayPointer["kind"],
    event: PointerEvent | WheelEvent,
    box: { left: number; top: number },
  ): boolean;
}

export interface ViewerService {
  readonly photoId: number | null;
  /** The open `view.open`, so a mask preview can be sized like the frame it lies over. */
  readonly viewId: number | null;
  /** Human-readable connection/photo state for the viewer's toolbar. */
  readonly status: string;
  /** `view.render` sent → frame on screen, in milliseconds. */
  readonly latencyMs: number;
  /** The engine's own share of `latencyMs`: `renderMs + readbackMs` of the last reply. */
  readonly engineMs: number;
  /**
   * The canvas hands over its painter; frames are drawn from the socket's message handler,
   * not through reactive state, which would land a scheduler flush later. Returns the
   * detach.
   */
  attachFrameSink(sink: FrameSink): () => void;
  readonly stack: Op[];
  /** Stack revision the engine last reported; it advances on every change it accepts. */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /**
   * Merge `params` into the op with this name, adding it to the stack when absent.
   * `transient` is true while a slider is dragged: no history snapshot, no sidecar.
   */
  setParam(op: string, params: Record<string, unknown>, transient: boolean): Promise<void>;
  /**
   * The same write aimed at one stack entry instead of the first op with that name — what a
   * local adjustment needs, where the same op appears twice, once masked and once not.
   */
  setOpParams(opId: string, params: Record<string, unknown>, transient: boolean): Promise<void>;
  /** Layer opacity of one op, 0–100. `transient` while the readout is being dragged. */
  setOpacity(opId: string, value: number, transient: boolean): Promise<void>;
  /**
   * Replaces one op's mask whole, or drops it with `undefined`. Never a merge — a mask is
   * an ordered list. Rasters, strokes and a component's `state` stay the engine's: they
   * round-trip untouched and `mask.stroke` is the only way to add a stroke.
   */
  setMask(opId: string, mask: Mask | undefined, transient?: boolean): Promise<void>;
  /** Enable or disable one op — the layer eye. */
  setEnabled(opId: string, enabled: boolean): Promise<void>;
  /** Reorders, duplicates or drops ops: the whole stack, in the order it should be in. */
  setStack(stack: Op[]): Promise<void>;
  /** The op the Masks and Layers columns are pointed at; null when nothing is selected. */
  readonly selectedOpId: string | null;
  selectOp(opId: string | null): void;
  /** The canvas' transparent overlay, for tools that draw on top of the frame. */
  readonly overlay: ViewerOverlay;
  /**
   * Opens a photo and a view for it, `width`×`height` in device pixels. Without a size the
   * viewer renders at the size its canvas last reported, which is what the filmstrip wants.
   */
  open(path: string, width?: number, height?: number): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Viewport changed: the next frame is rendered at this size, in device pixels. */
  resize(width: number, height: number): void;
  /** Coalesced: one render in flight, at most one queued behind it. */
  requestRender(): void;
}

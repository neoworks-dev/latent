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
 * `[x, y, width, height]` of the photo inside a proxy frame, in that frame's own pixels —
 * `view.render` and `mask.preview` both answer with one. The frame is letterboxed and crop,
 * rotate and the Transform sliders change the photo's aspect inside it, so this is the only
 * thing that says where the photo actually is; mask component coordinates are normalised
 * over it. Absent from an engine older than the field, which is what `containRect` is for.
 */
export type ContentRect = [number, number, number, number];

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

/**
 * `view.render`'s and `mask.preview`'s `imageTransform`: image-normalised → view pixel, a
 * row-major 3×3 applied to `(x, y, 1)` with a homogeneous divide. Projective, not affine —
 * the Transform sliders' keystone is — and it carries crop, straighten, rotate, flip and
 * the viewport's zoom and pan, so it is the one thing that relates what a mask stores to
 * what the canvas shows.
 */
export type ImageTransform = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** The uncropped photo laid straight into the frame: what an engine without the field means. */
export const IDENTITY_IMAGE_TRANSFORM: ImageTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `(x, y, 1)` through a 3×3, divided by w. A degenerate w yields the origin, never NaN. */
export function applyImageTransform(
  matrix: ImageTransform,
  x: number,
  y: number,
): { x: number; y: number } {
  const w = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / w,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / w,
  };
}

/** The other direction. A singular matrix answers with the identity rather than throwing. */
export function invertImageTransform(m: ImageTransform): ImageTransform {
  const c0 = m[4] * m[8] - m[5] * m[7];
  const c1 = m[5] * m[6] - m[3] * m[8];
  const c2 = m[3] * m[7] - m[4] * m[6];
  const determinant = m[0] * c0 + m[1] * c1 + m[2] * c2;
  if (Math.abs(determinant) < 1e-12) return IDENTITY_IMAGE_TRANSFORM;
  const k = 1 / determinant;
  return [
    c0 * k,
    (m[2] * m[7] - m[1] * m[8]) * k,
    (m[1] * m[5] - m[2] * m[4]) * k,
    c1 * k,
    (m[0] * m[8] - m[2] * m[6]) * k,
    (m[2] * m[3] - m[0] * m[5]) * k,
    c2 * k,
    (m[1] * m[6] - m[0] * m[7]) * k,
    (m[0] * m[4] - m[1] * m[3]) * k,
  ];
}

/**
 * Zoom and pan, exactly `view.render`'s `viewport`. `scale` 1 is fit-to-view; the centre is
 * the image-normalised point the view is centred on and means nothing while `fit` is set.
 * Not edit state — it never reaches the stack.
 */
export interface ViewportState {
  scale: number;
  centerX: number;
  centerY: number;
  fit: boolean;
}

export const FIT_VIEWPORT: ViewportState = { scale: 1, centerX: 0.5, centerY: 0.5, fit: true };

/** The engine's answer for the frame on screen: what the next zoom is computed against. */
export interface ViewportFrame {
  /** `[x, y, width, height]` of the photo inside the frame, in frame pixels. */
  contentRect: ContentRect;
  frameWidth: number;
  frameHeight: number;
  /** image-normalised → frame pixel, for the scale below. */
  transform: ImageTransform;
  /** The scale the rect and the matrix were rendered at. */
  scale: number;
}

export const MIN_VIEWPORT_SCALE = 1;
export const MAX_VIEWPORT_SCALE = 32;

export function clampViewportScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_VIEWPORT_SCALE;
  return Math.min(MAX_VIEWPORT_SCALE, Math.max(MIN_VIEWPORT_SCALE, scale));
}

/**
 * The engine's clamp, mirrored so the readout does not jump on the next frame: a rect wider
 * than the view is dragged only until its edge reaches the view's, and one that fits is
 * centred.
 */
function clampCentre(centre: number, extent: number, view: number): number {
  if (extent <= view) return 0.5;
  const margin = view / (2 * extent);
  return Math.min(1 - margin, Math.max(margin, centre));
}

/**
 * Zoom to `nextScale` about a point of the frame, keeping whatever is under that point
 * where it is — the gesture every image viewer has. `anchorX`/`anchorY` are frame pixels;
 * the frame's own centre is what a keyboard step passes.
 */
export function zoomViewport(
  frame: ViewportFrame,
  nextScale: number,
  anchorX: number,
  anchorY: number,
): ViewportState {
  const scale = clampViewportScale(nextScale);
  const [x, y, width, height] = frame.contentRect;
  if (width <= 0 || height <= 0 || frame.scale <= 0) return { ...FIT_VIEWPORT, scale };
  if (scale <= MIN_VIEWPORT_SCALE) return FIT_VIEWPORT;
  // Content-normalised: scale-independent, which is what makes this arithmetic short.
  const u = (anchorX - x) / width;
  const v = (anchorY - y) / height;
  const grown = scale / frame.scale;
  const nextWidth = width * grown;
  const nextHeight = height * grown;
  const centreU = clampCentre(
    u + (frame.frameWidth / 2 - anchorX) / nextWidth,
    nextWidth,
    frame.frameWidth,
  );
  const centreV = clampCentre(
    v + (frame.frameHeight / 2 - anchorY) / nextHeight,
    nextHeight,
    frame.frameHeight,
  );
  // Back to image space through the frame that is on screen: the content → image half of
  // the map does not depend on the zoom, so the current rect and matrix are enough.
  const centre = applyImageTransform(
    invertImageTransform(frame.transform),
    x + centreU * width,
    y + centreV * height,
  );
  return { scale, centerX: centre.x, centerY: centre.y, fit: false };
}

/**
 * A drag: the picture follows the pointer by `dx`/`dy` frame pixels, so the centre moves
 * against it. Not a zoom with a moved anchor — that is the identity, because holding a
 * point still at an unchanged scale is holding the whole picture still.
 */
export function panViewport(
  frame: ViewportFrame,
  current: ViewportState,
  dx: number,
  dy: number,
): ViewportState {
  if (current.fit) return current;
  const [x, y, width, height] = frame.contentRect;
  if (width <= 0 || height <= 0) return current;
  const centreU = clampCentre((frame.frameWidth / 2 - x - dx) / width, width, frame.frameWidth);
  const centreV = clampCentre((frame.frameHeight / 2 - y - dy) / height, height, frame.frameHeight);
  const centre = applyImageTransform(
    invertImageTransform(frame.transform),
    x + centreU * width,
    y + centreV * height,
  );
  return { scale: current.scale, centerX: centre.x, centerY: centre.y, fit: false };
}

/**
 * The scale at which one image pixel is one frame pixel. Read off the matrix rather than
 * off the crop, so a rotated or cropped photo answers correctly too.
 */
export function oneToOneScale(frame: ViewportFrame, photoWidth: number): number {
  const left = applyImageTransform(frame.transform, 0, 0.5);
  const right = applyImageTransform(frame.transform, 1, 0.5);
  const onScreen = Math.hypot(right.x - left.x, right.y - left.y);
  if (onScreen <= 0 || photoWidth <= 0) return MIN_VIEWPORT_SCALE;
  return clampViewportScale((frame.scale * photoWidth) / onScreen);
}

/** `Fit`, `100%`, `250%` — what the viewer's status bar shows. */
export function zoomLabel(viewport: ViewportState, oneToOne: number): string {
  if (viewport.fit) return "Fit";
  return `${Math.round((viewport.scale / oneToOne) * 100)}%`;
}

/**
 * Image coordinates ↔ the overlay canvas' CSS pixels. A painter is handed one of these and
 * uses nothing else: a mask component stores image-normalised points, and where those land
 * on screen depends on the crop, the straighten and the zoom, none of which a painter
 * should have to know about.
 */
export interface OverlayMap {
  /** A mask coordinate → a point to draw at. */
  toCanvas(x: number, y: number): { x: number; y: number };
  /** A point on the canvas → the mask coordinate under it. */
  toImage(x: number, y: number): { x: number; y: number };
  /**
   * The image's long edge in canvas pixels. A brush diameter is a fraction of that edge, so
   * this is what its on-screen radius is measured with. Approximate under a keystone, exact
   * under crop, straighten, rotate, flip and zoom.
   */
  readonly scale: number;
}

/** Draws on top of the frame. Called on every overlay repaint, never per engine frame. */
export type OverlayDraw = (
  context: CanvasRenderingContext2D,
  rect: OverlayRect,
  map: OverlayMap,
) => void;

/**
 * A pointer over the photo, in image-normalised coordinates: `x`/`y` are 0..1 across the
 * drawn image and are outside that range when the pointer left it. `deltaY` is the wheel's,
 * zero otherwise.
 */
export interface OverlayPointer {
  kind: "down" | "move" | "up" | "cancel" | "wheel";
  x: number;
  y: number;
  /**
   * The same pointer in image-normalised coordinates: 0..1 across the *uncropped* photo,
   * which is the space masks are stored in. `x`/`y` above stay what they always were —
   * 0..1 over the content rect, what the crop tool draws in — so the two agree exactly
   * when nothing is cropped and diverge as soon as something is.
   */
  imageX: number;
  imageY: number;
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
  /** Image ↔ canvas, from the engine's `imageTransform`. Painters get this as an argument. */
  readonly map: OverlayMap;
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
  /** The engine's `imageTransform` for the frame just drawn; `null` when it sent none. */
  setImageTransform(matrix: ImageTransform | null): void;
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
  /** Zoom and pan as the engine last confirmed them. Never edit state. */
  readonly viewport: ViewportState;
  /** `Fit`, `100%`, `250%`: the status bar's readout of the above. */
  readonly zoom: string;
  /** Zoom about a point of the canvas, in its CSS pixels; no point means its centre. */
  zoomTo(scale: number, anchorX?: number, anchorY?: number): void;
  /** A ratio step of the same, which is what the wheel and `+`/`-` do. */
  zoomBy(factor: number, anchorX?: number, anchorY?: number): void;
  /** Fit ↔ 1:1, the `Z` key. */
  toggleZoom(anchorX?: number, anchorY?: number): void;
  zoomToFit(): void;
  zoomToActual(): void;
  /** Drag the picture by this many canvas CSS pixels. */
  panBy(dx: number, dy: number): void;
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

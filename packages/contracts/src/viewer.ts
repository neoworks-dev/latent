// The open photo as the engine reports it. Every field is a mirror of the engine's
// answer, never a local edit: a control calls `setParam`, the engine replies with the
// new stack, the mirror updates and a frame is requested. Nothing here is edit state.
import type { Histogram, Mask, Op } from "@latent/protocol";
import type { EngineFrame } from "./engine";

/** When the painter touched a frame, in `performance.now()` terms. */
export interface FrameDrawMarks {
  drawStarted: number;
  uploaded: number;
  drawn: number;
}

/**
 * Scale and translation in frame pixels, applied to the frame already on the GPU: what a
 * zoom or a pan looks like before the engine has answered with pixels for it. Uniform,
 * because both axes of the content rect grow with the viewport's scale.
 */
export interface FrameTransform {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY_FRAME_TRANSFORM: FrameTransform = { scale: 1, x: 0, y: 0 };

/**
 * Which of the painter's two layers a frame goes into. `detail` is the frame of the current
 * zoom and pan; `base` is a fitted frame of the whole photo, drawn wherever the detail frame
 * does not reach, so a pan or a zoom out uncovers a softer picture rather than the letterbox.
 */
export type FrameLayer = "detail" | "base";

/**
 * The canvas' painter. `draw` uploads one engine frame into a layer and reports how long each
 * part took; `setTransform` redraws what is already uploaded under a client-side zoom or pan,
 * which is how a gesture reaches the screen in the event that caused it rather than a round
 * trip later. A frame is drawn under whatever transform was last set, so the caller sets it
 * first — usually back to the identity, because fresh pixels already carry the viewport.
 */
export interface FrameSink {
  draw(frame: EngineFrame, layer: FrameLayer): FrameDrawMarks;
  /**
   * `transform` moves the detail layer. `baseMap` takes a canvas pixel to a pixel of the
   * base layer's frame (`baseLayerMap`); `null` leaves the base layer out.
   */
  setTransform(transform: FrameTransform, baseMap: ImageTransform | null): void;
  /** Forgets the detail layer, so the base layer shows everywhere from the next draw on. */
  dropDetail(): void;
}

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

/** `a` after `b`: the matrix that takes a point through `b` first, then through `a`. */
export function multiplyImageTransforms(a: ImageTransform, b: ImageTransform): ImageTransform {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/**
 * A canvas pixel → the pixel of the base layer's frame showing the same point of the photo.
 * Both matrices go image → frame pixel, so the map runs back to the image through the one
 * on screen and forward through the base frame's. The two frames differ only in their
 * viewport, which is why lens distortion — absent from both matrices — cancels out.
 */
export function baseLayerMap(base: ImageTransform, shown: ImageTransform): ImageTransform {
  return multiplyImageTransforms(base, invertImageTransform(shown));
}

/**
 * A client-side zoom or pan folded into an `imageTransform`: the matrix the engine sent for
 * the frame on screen, moved to where the painter is currently showing that frame. The
 * bottom row is left alone — a scale and a translation in frame pixels do not touch the
 * projective part.
 */
export function transformImageMatrix(
  transform: FrameTransform,
  matrix: ImageTransform,
): ImageTransform {
  const { scale, x, y } = transform;
  return [
    scale * matrix[0] + x * matrix[6],
    scale * matrix[1] + x * matrix[7],
    scale * matrix[2] + x * matrix[8],
    scale * matrix[3] + y * matrix[6],
    scale * matrix[4] + y * matrix[7],
    scale * matrix[5] + y * matrix[8],
    matrix[6],
    matrix[7],
    matrix[8],
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
  /**
   * What the client floats over the frame, in frame pixels — the same insets `view.render`
   * was given. Zoom and pan are measured against the hole they leave rather than against
   * the whole frame, exactly as the engine places the rect: a picture bigger than the hole
   * can be dragged even while it is still smaller than the window.
   */
  insets: { left: number; top: number; right: number; bottom: number };
}

/** The hole the panels leave, as an origin and an extent on one axis. */
function inner(extent: number, start: number, end: number): { start: number; extent: number } {
  return { start, extent: Math.max(1, extent - start - end) };
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

/** Where the picture is aimed: the middle of the hole the panels leave, in frame pixels. */
function aim(frame: ViewportFrame): { x: number; y: number } {
  const horizontal = inner(frame.frameWidth, frame.insets.left, frame.insets.right);
  const vertical = inner(frame.frameHeight, frame.insets.top, frame.insets.bottom);
  return {
    x: horizontal.start + horizontal.extent / 2,
    y: vertical.start + vertical.extent / 2,
  };
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
  const middle = aim(frame);
  const horizontal = inner(frame.frameWidth, frame.insets.left, frame.insets.right);
  const vertical = inner(frame.frameHeight, frame.insets.top, frame.insets.bottom);
  const centreU = clampCentre(u + (middle.x - anchorX) / nextWidth, nextWidth, horizontal.extent);
  const centreV = clampCentre(v + (middle.y - anchorY) / nextHeight, nextHeight, vertical.extent);
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
  const middle = aim(frame);
  const horizontal = inner(frame.frameWidth, frame.insets.left, frame.insets.right);
  const vertical = inner(frame.frameHeight, frame.insets.top, frame.insets.bottom);
  const centreU = clampCentre((middle.x - x - dx) / width, width, horizontal.extent);
  const centreV = clampCentre((middle.y - y - dy) / height, height, vertical.extent);
  const centre = applyImageTransform(
    invertImageTransform(frame.transform),
    x + centreU * width,
    y + centreV * height,
  );
  return { scale: current.scale, centerX: centre.x, centerY: centre.y, fit: false };
}

/**
 * Where a rect of `extent` pixels sits on one axis — the mirror of `place()` in
 * engine/src/ops/geometry.cpp, floor and clamp included, so a predicted rect lands on the
 * pixel the engine will send rather than next to it.
 */
function place(
  view: number,
  extent: number,
  centre: number,
  fit: boolean,
  insetStart: number,
  insetEnd: number,
): number {
  const hole = Math.max(1, view - insetStart - insetEnd);
  if (fit || extent <= hole) return Math.floor(insetStart + (hole - extent) / 2);
  const wanted = insetStart + hole / 2 - centre * extent;
  return Math.round(Math.min(insetStart, Math.max(insetStart + hole - extent, wanted)));
}

/**
 * Where the photo would sit inside the frame under `viewport`, without asking the engine.
 * The rect grows linearly with the scale, so the frame on screen is reference enough: the
 * fit size is its own rect divided by the scale it was rendered at. Exact for the frame's
 * own viewport, which is what makes it safe to measure a client-side gesture against.
 */
export function contentRectFor(frame: ViewportFrame, viewport: ViewportState): ContentRect {
  const [x, y, width, height] = frame.contentRect;
  if (width <= 0 || height <= 0 || frame.scale <= 0) return frame.contentRect;
  const zoom = viewport.fit ? MIN_VIEWPORT_SCALE : clampViewportScale(viewport.scale);
  const nextWidth = Math.max(1, Math.round((width / frame.scale) * zoom));
  const nextHeight = Math.max(1, Math.round((height / frame.scale) * zoom));
  // The viewport's centre is an image coordinate and `place` wants a content-normalised
  // one. That half of the map does not depend on the zoom, so the frame on screen converts
  // it however far the viewport has moved since.
  const centre = applyImageTransform(frame.transform, viewport.centerX, viewport.centerY);
  const insets = frame.insets;
  return [
    place(
      frame.frameWidth,
      nextWidth,
      (centre.x - x) / width,
      viewport.fit,
      insets.left,
      insets.right,
    ),
    place(
      frame.frameHeight,
      nextHeight,
      (centre.y - y) / height,
      viewport.fit,
      insets.top,
      insets.bottom,
    ),
    nextWidth,
    nextHeight,
  ];
}

/**
 * What the painter has to do to the frame rendered under `from` to make it look like `to`.
 * Both rects are predicted from the same reference, so whatever the prediction gets wrong
 * cancels and the identity comes out whenever the two viewports agree.
 */
export function frameTransform(
  frame: ViewportFrame,
  from: ViewportState,
  to: ViewportState,
): FrameTransform {
  const [fromX, fromY, fromWidth] = contentRectFor(frame, from);
  const [toX, toY, toWidth] = contentRectFor(frame, to);
  if (fromWidth <= 0) return IDENTITY_FRAME_TRANSFORM;
  const scale = toWidth / fromWidth;
  return { scale, x: toX - scale * fromX, y: toY - scale * fromY };
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
   * Where the cursor sits in the undo stack, and how deep it is. Not `revision`: that
   * advances on every write the engine accepts, one per tick of a slider drag, while these
   * count undo steps — a whole drag is one of them.
   */
  readonly historyIndex: number;
  readonly historyDepth: number;
  /**
   * The engine's histogram of the last frame it sent, `null` before the first one. It
   * comes off `view.render` rather than off the stack: a stack write is answered before
   * the frame it causes, so the copy on `stack.get` is one render behind the edit.
   */
  readonly histogram: Histogram | null;
  /**
   * True while adjustments are being written — a slider drag, a click, a key nudge — and
   * briefly after the last one. Mask edits do not count. The Masks panel hides its tint
   * while this is up, the way Lightroom does, so the adjustment is judged on the pixels.
   */
  readonly adjusting: boolean;
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
  /**
   * A new layer: an empty group, `null` when the engine refused it. A mask lives on a group
   * and the adjustments that share it are its children (PROMPT.md 3.7), so this is the
   * first step of every mask the user creates — before any adjustment exists.
   */
  addGroup(): Promise<string | null>;
  /**
   * `setParam` aimed inside one layer: merges into that group's child with this op name,
   * adding the child when the layer does not have it yet. The mask and the opacity stay the
   * group's, so the write never carries either.
   */
  setGroupParam(
    groupId: string,
    op: string,
    params: Record<string, unknown>,
    transient: boolean,
  ): Promise<void>;
  /** Drops one entry — a child from its layer, or a layer with everything under it. */
  removeOp(opId: string): Promise<void>;
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
  /**
   * Reorders, duplicates or drops ops: the whole stack, in the order it should be in.
   * `label` names the history step for a caller that knows more than the diff can see — a
   * preset moves a dozen ops at once and "Golden hour applied" is what that step was.
   */
  setStack(stack: Op[], label?: string): Promise<void>;
  /** The op the Masks and Layers columns are pointed at; null when nothing is selected. */
  readonly selectedOpId: string | null;
  selectOp(opId: string | null): void;
  /**
   * The layer every unaimed write lands in. With one set, `setParam` — every slider of the
   * Edit column — goes into that group instead of the base stack, which is what selecting a
   * mask and then moving a slider means. Null edits the photo itself. Set by the Masks
   * panel while it is open, and cleared when it closes: a write that goes somewhere other
   * than the photo has to be visible on screen.
   */
  readonly maskTarget: string | null;
  setMaskTarget(opId: string | null): void;
  /** The canvas' transparent overlay, for tools that draw on top of the frame. */
  readonly overlay: ViewerOverlay;
  /** Zoom and pan as the engine last confirmed them. Never edit state. */
  readonly viewport: ViewportState;
  /**
   * Counts how often the engine has answered with the photo in a different place: a zoom, a
   * pan, a resize, a crop. A slider tick leaves it alone. Anything holding a view-space
   * raster of its own — `mask.preview`'s overlay — is stale when this moves and has to ask
   * the engine again, and only once this has moved does the engine hold the viewport that
   * raster has to be rendered at.
   */
  readonly frameGeometry: number;
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
  /**
   * What the shell floats over the canvas, in CSS pixels. A fitted photo is fitted into
   * the canvas minus these so no panel covers it; a zoomed one still fills the canvas and
   * runs on behind them. View state — it rides on `view.render` and never reaches the
   * stack.
   */
  setInsets(insets: { left: number; top: number; right: number; bottom: number }): void;
  /** Coalesced: one render in flight, at most one queued behind it. */
  requestRender(): void;
}

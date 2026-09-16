// The crop tool's arithmetic. Everything here is pure and works in the engine's own
// coordinates: the crop op's `left`/`top`/`right`/`bottom` are 0..1 over the *uncropped*
// image, and `angle` rotates the crop rectangle against that image.
//
// The rotation matches engine/src/pipeline/renderer.cpp `build_base` exactly. That pass
// walks destination pixels and asks where each came from, so a destination point (u, v)
// inside the crop maps to the source point
//
//   p = (left + u·w, top + v·h)               the crop box
//   q = (aspect·(p.x − cx), p.y − cy)         centred on the crop, aspect-corrected
//   r = R·q,  R = [[cos, sin], [−sin, cos]]   the straighten
//   s = (r.x / aspect + cx, r.y + cy)         back to image coordinates
//
// so the crop's four corners in image space are the centre plus a fixed offset per corner,
// and "the crop stays inside the image" is a statement about those offsets. `aspect` is
// always the *image's* width/height as it is displayed (after `rotate`), never the crop's.

export interface CropBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Point = [number, number];

/** The eight resize grips, the inside of the rect, and everything outside it. */
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move" | "straighten";

/** The whole image. What `crop` renders as, and what Reset writes. */
export const FULL_CROP: CropBox = { left: 0, top: 0, right: 1, bottom: 1 };

/** Straighten's range, from the op registry: `crop.angle` is a −45..45 slider. */
export const MAX_ANGLE = 45;

/** A crop can be small, but not so small that its handles overlap. */
const MIN_HALF_EXTENT = 0.015;

/** Corner and edge grips, as a fraction of each half-extent: which way they pull. */
const HANDLE_SIGNS: Record<string, Point> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

/** The eight grips in drawing order, corners first so a corner wins a shared pixel. */
export const CROP_HANDLES = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;

/** Wire values: a sidecar reads better with 0.2 than with 0.19999999999999996. */
function round(value: number): number {
  return Number(value.toFixed(4));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

interface Frame {
  cos: number;
  sin: number;
  aspect: number;
}

function frameOf(angle: number, aspect: number): Frame {
  const radians = (angle * Math.PI) / 180;
  return { cos: Math.cos(radians), sin: Math.sin(radians), aspect: Math.max(0.0001, aspect) };
}

/** Where one corner sits relative to the crop's centre, in image coordinates. */
function offsetOf(frame: Frame, signX: number, signY: number, halfX: number, halfY: number): Point {
  return [
    frame.cos * signX * halfX + (frame.sin * signY * halfY) / frame.aspect,
    -frame.sin * frame.aspect * signX * halfX + frame.cos * signY * halfY,
  ];
}

/**
 * Half the width and height of the rotated crop's bounding box, in image coordinates. The
 * four corner offsets are symmetric about the centre, so these two numbers are the whole
 * constraint: the centre has to stay at least this far from every edge of the image.
 */
function boundsOf(frame: Frame, halfX: number, halfY: number): Point {
  return [
    Math.abs(frame.cos) * halfX + (Math.abs(frame.sin) * halfY) / frame.aspect,
    Math.abs(frame.sin) * frame.aspect * halfX + Math.abs(frame.cos) * halfY,
  ];
}

function centreOf(box: CropBox): Point {
  return [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
}

function halvesOf(box: CropBox): Point {
  return [(box.right - box.left) / 2, (box.bottom - box.top) / 2];
}

// Never clamped into 0..1 here: a half-built rect is allowed to hang off the photo, and
// `constrainCrop` — which every write goes through — is what puts it back. Clamping early
// collapses a rect the pointer dragged past the edge instead of sliding it.
function boxOf(centre: Point, halfX: number, halfY: number): CropBox {
  return {
    left: round(centre[0] - halfX),
    top: round(centre[1] - halfY),
    right: round(centre[0] + halfX),
    bottom: round(centre[1] + halfY),
  };
}

/**
 * The hair of slack the rounding needs. Crop params go on the wire rounded to a
 * ten-thousandth, so a rect pushed to exactly the edge can round a fraction of a pixel
 * past it; the constraint keeps that much room and the check allows that much error.
 */
const EDGE_MARGIN = 0.0002;

/** The crop's four corners in image coordinates, clockwise from the top left. */
export function cropCorners(box: CropBox, angle: number, aspect: number): Point[] {
  const frame = frameOf(angle, aspect);
  const [cx, cy] = centreOf(box);
  const [halfX, halfY] = halvesOf(box);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map((sign) => {
    const [dx, dy] = offsetOf(frame, sign[0] ?? 0, sign[1] ?? 0, halfX, halfY);
    return [cx + dx, cy + dy] as Point;
  });
}

/**
 * A point inside the crop in image coordinates: `u` and `v` run 0..1 across it. The
 * corners are the four extremes; the thirds grid is this at 1/3 and 2/3.
 */
export function cropPoint(
  box: CropBox,
  angle: number,
  aspect: number,
  u: number,
  v: number,
): Point {
  const frame = frameOf(angle, aspect);
  const [cx, cy] = centreOf(box);
  const [halfX, halfY] = halvesOf(box);
  const [dx, dy] = offsetOf(frame, 2 * u - 1, 2 * v - 1, halfX, halfY);
  return [cx + dx, cy + dy];
}

/** The midpoint of each edge, in the same order: top, right, bottom, left. */
export function cropEdgePoints(box: CropBox, angle: number, aspect: number): Point[] {
  const frame = frameOf(angle, aspect);
  const [cx, cy] = centreOf(box);
  const [halfX, halfY] = halvesOf(box);
  return [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ].map((sign) => {
    const [dx, dy] = offsetOf(frame, sign[0] ?? 0, sign[1] ?? 0, halfX, halfY);
    return [cx + dx, cy + dy] as Point;
  });
}

/** The crop's aspect ratio as the exported picture will have it, width over height. */
export function cropRatio(box: CropBox, aspect: number): number {
  const [halfX, halfY] = halvesOf(box);
  if (halfY <= 0) return aspect;
  return (aspect * halfX) / halfY;
}

/** True when every corner of the rotated crop is still on the photo. */
export function cropInsideImage(box: CropBox, angle: number, aspect: number): boolean {
  const frame = frameOf(angle, aspect);
  const [cx, cy] = centreOf(box);
  const [halfX, halfY] = halvesOf(box);
  const [boundX, boundY] = boundsOf(frame, halfX, halfY);
  if (cx - boundX < -EDGE_MARGIN || cx + boundX > 1 + EDGE_MARGIN) return false;
  return cy - boundY >= -EDGE_MARGIN && cy + boundY <= 1 + EDGE_MARGIN;
}

/**
 * Pulls a crop back onto the photo: shrink it about `anchor` until the rotated rectangle
 * fits, then slide it in. Shrinking is uniform, so a locked aspect ratio survives it.
 * Without an anchor the rect shrinks about its own centre.
 */
export function constrainCrop(
  box: CropBox,
  angle: number,
  aspect: number,
  anchor?: Point,
): CropBox {
  const frame = frameOf(angle, aspect);
  let [halfX, halfY] = halvesOf(box);
  halfX = Math.max(MIN_HALF_EXTENT, halfX);
  halfY = Math.max(MIN_HALF_EXTENT, halfY);
  let [boundX, boundY] = boundsOf(frame, halfX, halfY);
  const room = 0.5 - EDGE_MARGIN;
  const shrink = Math.min(1, room / boundX, room / boundY);
  halfX *= shrink;
  halfY *= shrink;
  boundX *= shrink;
  boundY *= shrink;

  let centre = centreOf(box);
  if (anchor && shrink < 1) {
    // The grip the user is holding stays under the pointer; the rest of the rect moves.
    const toAnchor = [anchor[0] - centre[0], anchor[1] - centre[1]];
    centre = [anchor[0] - (toAnchor[0] ?? 0) * shrink, anchor[1] - (toAnchor[1] ?? 0) * shrink];
  }
  return boxOf(
    [
      clamp(centre[0], Math.min(boundX, 0.5), Math.max(1 - boundX, 0.5)),
      clamp(centre[1], Math.min(boundY, 0.5), Math.max(1 - boundY, 0.5)),
    ],
    halfX,
    halfY,
  );
}

export interface ResizeRequest {
  box: CropBox;
  angle: number;
  /** The image's own aspect, width over height, as it is displayed. */
  aspect: number;
  handle: CropHandle;
  /** Where the pointer is, in image coordinates. */
  pointer: Point;
  /** Locked output ratio, width over height. Undefined leaves the crop free. */
  ratio?: number;
}

/**
 * One grip dragged to `pointer`. The opposite corner — or the opposite edge — stays where
 * it is, which is what makes a rotated crop resize the way it looks like it should.
 */
export function resizeCrop(request: ResizeRequest): CropBox {
  const signs = HANDLE_SIGNS[request.handle];
  if (!signs) return request.box;
  const [signX, signY] = signs;
  const frame = frameOf(request.angle, request.aspect);
  const centre = centreOf(request.box);
  const [halfX, halfY] = halvesOf(request.box);

  const fixed = offsetOf(frame, -signX, -signY, halfX, halfY);
  const anchor: Point = [centre[0] + fixed[0], centre[1] + fixed[1]];
  const reachX = (request.pointer[0] - anchor[0]) / 2;
  const reachY = (request.pointer[1] - anchor[1]) / 2;
  // The crop's own axes are orthogonal in aspect-corrected space, so the pointer's reach
  // splits into the two extents without an inverse matrix.
  const alongX = frame.cos * reachX - (frame.sin * reachY) / frame.aspect;
  const alongY = frame.sin * frame.aspect * reachX + frame.cos * reachY;

  let nextX = signX === 0 ? halfX : Math.max(MIN_HALF_EXTENT, signX * alongX);
  let nextY = signY === 0 ? halfY : Math.max(MIN_HALF_EXTENT, signY * alongY);
  const ratio = request.ratio;
  if (ratio !== undefined && ratio > 0) {
    // An edge grip drives the other extent; a corner takes whichever of the two the
    // pointer pulled further, so the crop follows the hand rather than snapping back.
    const fromWidth = (request.aspect * nextX) / ratio;
    if (signX === 0) nextX = (ratio * nextY) / request.aspect;
    else if (signY === 0 || fromWidth >= nextY) nextY = fromWidth;
    else nextX = (ratio * nextY) / request.aspect;
  }

  const moved = offsetOf(frame, signX, signY, nextX, nextY);
  const nextCentre: Point = [anchor[0] + moved[0], anchor[1] + moved[1]];
  return constrainCrop(boxOf(nextCentre, nextX, nextY), request.angle, request.aspect, anchor);
}

/** The whole crop dragged by `delta`, in image coordinates. */
export function moveCrop(box: CropBox, angle: number, aspect: number, delta: Point): CropBox {
  const centre = centreOf(box);
  const [halfX, halfY] = halvesOf(box);
  return constrainCrop(
    boxOf([centre[0] + delta[0], centre[1] + delta[1]], halfX, halfY),
    angle,
    aspect,
  );
}

/**
 * The straighten drag: the user draws a line along something that should be level, and the
 * crop turns until that line is one of its axes. A line closer to vertical straightens the
 * verticals, which is why the answer folds into ±45°.
 */
export function straightenAngle(start: Point, end: Point, aspect: number): number {
  const dx = (end[0] - start[0]) * Math.max(0.0001, aspect);
  const dy = end[1] - start[1];
  if (Math.hypot(dx, dy) < 1e-4) return 0;
  let degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
  while (degrees > 90) degrees -= 180;
  while (degrees < -90) degrees += 180;
  if (degrees > MAX_ANGLE) degrees -= 90;
  if (degrees < -MAX_ANGLE) degrees += 90;
  return round(clamp(degrees, -MAX_ANGLE, MAX_ANGLE));
}

/** The pointer in the crop's own frame: ±half-extents inside it, more outside. */
function localPoint(point: Point, box: CropBox, frame: Frame): Point {
  const centre = centreOf(box);
  const dx = (point[0] - centre[0]) * frame.aspect;
  const dy = point[1] - centre[1];
  return [(frame.cos * dx - frame.sin * dy) / frame.aspect, frame.sin * dx + frame.cos * dy];
}

export interface HitTest {
  point: Point;
  box: CropBox;
  angle: number;
  aspect: number;
  /** The drawn image's size in CSS pixels: grips are a pixel radius, not a fraction. */
  width: number;
  height: number;
  /** How close the pointer has to be to a grip, in pixels. */
  tolerance: number;
}

/**
 * What the pointer is on. Corners beat edges, the inside is a move, and anywhere off the
 * crop is the straighten drag — Lightroom's rule.
 */
export function handleAt(test: HitTest): CropHandle {
  const pointer: Point = [test.point[0] * test.width, test.point[1] * test.height];
  const grips: Point[] = [
    ...cropCorners(test.box, test.angle, test.aspect),
    ...cropEdgePoints(test.box, test.angle, test.aspect),
  ];
  let closest = test.tolerance;
  let found: CropHandle | null = null;
  for (const [index, grip] of grips.entries()) {
    const distance = Math.hypot(
      grip[0] * test.width - pointer[0],
      grip[1] * test.height - pointer[1],
    );
    if (distance > closest) continue;
    closest = distance;
    found = CROP_HANDLES[index] ?? null;
  }
  if (found) return found;

  const frame = frameOf(test.angle, test.aspect);
  const [localX, localY] = localPoint(test.point, test.box, frame);
  const [halfX, halfY] = halvesOf(test.box);
  if (Math.abs(localX) <= halfX && Math.abs(localY) <= halfY) return "move";
  return "straighten";
}

/** The CSS cursor each grip wears. Rotated crops keep the unrotated arrows, as Lightroom. */
export function cursorFor(handle: CropHandle): string {
  if (handle === "move") return "move";
  if (handle === "straighten") return "crosshair";
  if (handle === "n" || handle === "s") return "ns-resize";
  if (handle === "e" || handle === "w") return "ew-resize";
  if (handle === "nw" || handle === "se") return "nwse-resize";
  return "nesw-resize";
}

export interface AspectPreset {
  id: string;
  label: string;
  /** Width over height, or undefined for the ones that are computed or free. */
  ratio?: number;
}

/**
 * Lightroom's Aspect menu. `original` is the photo's own ratio and `asShot` is the crop as
 * it stands, so both resolve against the picture rather than carrying a number.
 */
export const ASPECT_PRESETS: AspectPreset[] = [
  { id: "free", label: "Custom" },
  { id: "original", label: "Original" },
  { id: "asShot", label: "As Shot" },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "5:7", label: "5:7", ratio: 5 / 7 },
  { id: "2:3", label: "2:3", ratio: 2 / 3 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

/**
 * The ratio a preset asks for, width over height. `original` is the image's, `asShot` the
 * crop's at the moment it was picked, and `free` is no ratio at all. `swapped` is the
 * orientation toggle: the same ratio stood on its end.
 */
export function ratioOf(
  presetId: string,
  aspect: number,
  box: CropBox,
  swapped: boolean,
): number | undefined {
  const preset = ASPECT_PRESETS.find((entry) => entry.id === presetId);
  if (!preset || presetId === "free") return undefined;
  const base = presetId === "original" ? aspect : (preset.ratio ?? cropRatio(box, aspect));
  return swapped ? 1 / base : base;
}

/**
 * The biggest crop with this ratio that still fits, centred on the one it replaces. What
 * picking an aspect preset does, and what the orientation swap does with the flipped one.
 */
export function fitRatio(
  box: CropBox,
  angle: number,
  aspect: number,
  ratio: number | undefined,
): CropBox {
  if (ratio === undefined || ratio <= 0) return constrainCrop(box, angle, aspect);
  const centre = centreOf(box);
  const [halfX, halfY] = halvesOf(box);
  // Start from the current area, then let constrainCrop pull it in: a ratio that cannot
  // fit at this size shrinks uniformly instead of clipping one edge.
  const area = Math.max(halfX * halfY, MIN_HALF_EXTENT * MIN_HALF_EXTENT);
  const nextY = Math.sqrt((area * aspect) / ratio);
  const nextX = (ratio * nextY) / aspect;
  return constrainCrop(boxOf(centre, nextX, nextY), angle, aspect);
}

/** `X`: the crop turns on its side and keeps covering as much of the photo as it can. */
export function swapOrientation(box: CropBox, angle: number, aspect: number): CropBox {
  return fitRatio(box, angle, aspect, 1 / cropRatio(box, aspect));
}

export interface CropShortcutEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
}

export type CropAction = "toggleTool" | "leaveTool" | "swapOrientation";

/** `R` in and out, `Esc` out, `X` swaps the orientation. Never inside a text field. */
export function cropShortcut(event: CropShortcutEvent): CropAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (target?.isContentEditable) return null;
  const tag = target?.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  const key = event.key.toLowerCase();
  if (key === "r") return "toggleTool";
  if (event.key === "Escape") return "leaveTool";
  if (key === "x") return "swapOrientation";
  return null;
}

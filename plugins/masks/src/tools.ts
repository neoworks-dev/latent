// The tools' arithmetic: what a drag means, how a brush batches its points, how the
// bracket keys and the wheel move the size. All image-normalised (0..1) over the
// *uncropped* photo — the space a mask is stored in (protocol Mask.space) — and all pure,
// so the overlay component is left with drawing and the state object with calling the
// engine. Nothing here knows about the crop, the straighten or the zoom; the overlay's
// `map` is what turns one of these points into a pixel.
import type { OverlayMap } from "@latent/contracts";

export type Point = [number, number];

/**
 * Normalised coordinates are wire values: a sidecar reads better with 0.2 in it than with
 * 0.19999999999999996, and a ten-thousandth of an image is a fraction of a pixel.
 */
function round(value: number): number {
  return Number(value.toFixed(4));
}

export function clampPoint(point: Point): Point {
  return [round(Math.min(1, Math.max(0, point[0]))), round(Math.min(1, Math.max(0, point[1])))];
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** A radial from a drag: the press is the centre, the release a corner of its ellipse. */
export function radialFromDrag(start: Point, end: Point): Record<string, unknown> {
  const rx = round(Math.max(0.01, Math.abs(end[0] - start[0])));
  const ry = round(Math.max(0.01, Math.abs(end[1] - start[1])));
  return { center: clampPoint(start), radius: [rx, ry], angle: 0 };
}

/** A linear gradient from a drag: 0 % at the press, 100 % at the release. */
export function linearFromDrag(start: Point, end: Point): Record<string, unknown> {
  return { start: clampPoint(start), end: clampPoint(end) };
}

/** A box for `mask.detect`'s hint, normalised so the corners are in order. */
export function boxFromDrag(start: Point, end: Point): [number, number, number, number] {
  const [x0, y0] = clampPoint(start);
  const [x1, y1] = clampPoint(end);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Brush diameter as a fraction of the long edge; the range the engine's brush accepts. */
export const MIN_BRUSH_SIZE = 0.005;
export const MAX_BRUSH_SIZE = 0.8;

function clampSize(size: number): number {
  return Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, Number(size.toFixed(4))));
}

/** The wheel scales the brush rather than stepping it, so big and small feel the same. */
export function brushSizeAfterWheel(size: number, deltaY: number): number {
  if (deltaY === 0) return size;
  return clampSize(size * (deltaY > 0 ? 0.88 : 1.136));
}

/** `[` and `]`, one notch each. */
export function brushSizeAfterStep(size: number, direction: -1 | 1): number {
  return clampSize(size * (direction < 0 ? 0.8 : 1.25));
}

/**
 * The points of one pointer-down, thinned and handed out a frame at a time. A pointer move
 * fires far more often than 60 Hz on a good mouse and every point would otherwise be its
 * own `mask.stroke`; this keeps the segment whole and the calls at frame rate.
 */
export class StrokeBuffer {
  private points: Point[] = [];
  private last: Point | null = null;

  /**
   * Adds a point unless it is within `minDistance` of the previous one. Returns whether it
   * was taken, so a caller can skip a repaint it does not need.
   */
  push(point: Point, minDistance: number): boolean {
    const clamped = clampPoint(point);
    if (this.last && distance(this.last, clamped) < minDistance) return false;
    this.last = clamped;
    this.points.push(clamped);
    return true;
  }

  /** Empties the buffer into one segment. The last point stays the thinning anchor. */
  take(): Point[] {
    const taken = this.points;
    this.points = [];
    return taken;
  }

  get pending(): number {
    return this.points.length;
  }

  /** The newest point taken, so the call that commits a stroke has somewhere to land. */
  get anchor(): Point | null {
    return this.last;
  }

  /** Between strokes: the next pointer-down starts its own anchor. */
  reset(): void {
    this.points = [];
    this.last = null;
  }
}

/** How far apart two brush samples have to be, as a fraction of the brush's own size. */
export function strokeSpacing(brushSize: number): number {
  return Math.max(0.002, brushSize * 0.25);
}

export interface DragState {
  start: Point;
  current: Point;
}

/** How many segments an image-space curve is drawn with. A crop can magnify it a lot. */
const ELLIPSE_SEGMENTS = 64;

/**
 * An ellipse in image space, as points. Drawn as a polygon rather than with `ctx.ellipse`
 * because the map from image to canvas carries a crop, a straighten, a rotate and a
 * keystone: only a straight scale would let a canvas ellipse land on the right pixels.
 *
 * `angle` is applied in image-normalised space. The shader applies it in aspect-corrected
 * space, so the two agree exactly at the 0 every tool writes today and drift for a rotated
 * ellipse on a non-square photo; the engine's own tint is the authority either way.
 */
export function ellipsePoints(center: Point, radius: Point, angle = 0): Point[] {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points: Point[] = [];
  for (let step = 0; step < ELLIPSE_SEGMENTS; step++) {
    const t = (step / ELLIPSE_SEGMENTS) * Math.PI * 2;
    const x = radius[0] * Math.cos(t);
    const y = radius[1] * Math.sin(t);
    points.push([center[0] + x * cos - y * sin, center[1] + x * sin + y * cos]);
  }
  return points;
}

/** The four corners of an image-space box, in order, for the same reason. */
export function boxPoints(box: [number, number, number, number]): Point[] {
  return [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ];
}

/** Strokes a closed image-space polygon on the canvas. */
export function strokeImagePath(
  context: CanvasRenderingContext2D,
  map: OverlayMap,
  points: Point[],
  closed = true,
): void {
  const [first, ...rest] = points;
  if (!first) return;
  const start = map.toCanvas(first[0], first[1]);
  context.beginPath();
  context.moveTo(start.x, start.y);
  for (const point of rest) {
    const at = map.toCanvas(point[0], point[1]);
    context.lineTo(at.x, at.y);
  }
  if (closed) context.closePath();
  context.stroke();
}

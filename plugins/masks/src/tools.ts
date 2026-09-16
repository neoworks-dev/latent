// The tools' arithmetic: what a drag means, how a brush batches its points, how the
// bracket keys and the wheel move the size. All image-normalised (0..1) and all pure, so
// the overlay component is left with drawing and the state object with calling the engine.

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

/** An ellipse's on-screen box from its normalised params, for drawing and hit-testing. */
export function ellipseBox(
  center: Point,
  radius: Point,
  rect: { x: number; y: number; width: number; height: number },
): { cx: number; cy: number; rx: number; ry: number } {
  return {
    cx: rect.x + center[0] * rect.width,
    cy: rect.y + center[1] * rect.height,
    rx: radius[0] * rect.width,
    ry: radius[1] * rect.height,
  };
}

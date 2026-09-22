// Where the right column's cards live: docked in the column in some order, or floating
// loose over the viewer. Pure geometry and ordering — no DOM, no Svelte, so the rules are
// unit-tested directly and the component only has to move a pointer.
//
// Layout, never edit state: none of this reaches the op-stack or the sidecar.

/** The gap a snapped card keeps from the one it snapped to, in CSS pixels. */
export const SNAP_GAP = 8;

/** How near an edge has to come before it snaps, in CSS pixels. */
export const SNAP_DISTANCE = 12;

/** How far into the column a floating card must be dragged to dock again. */
export const DOCK_DISTANCE = 24;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A card that left the column: where it sits, and the size it had when it did. The height
 * is carried rather than measured on demand because the collision test needs every other
 * card's box, not just the one being dragged.
 */
export interface FloatingPanel {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a card sits. `docked` is the column, in `order`; `floating` is loose over the
 * viewer at a point of the window.
 */
export type PanelPlacement =
  { kind: "docked"; order: number } | { kind: "floating"; x: number; y: number; width: number };

/**
 * The docked ids in the order they should be drawn, with `id` moved to where `pointerY`
 * now is. Each entry of `midpoints` is the vertical middle of one docked card, in the same
 * order as `ids` and in window coordinates — a card is dragged past a neighbour once the
 * pointer crosses that neighbour's middle, which is the usual list-reorder rule.
 */
export function reorderDocked(
  ids: string[],
  id: string,
  pointerY: number,
  midpoints: number[],
): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  let to = dropIndexAt(pointerY, midpoints);
  // Crossing its own middle is not a move: the slot it vacates shifts everything above it.
  if (to > from) to -= 1;
  if (to === from) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  return next;
}

/**
 * The slot `pointerY` is over, given each docked card's vertical middle: 0 is above the
 * first card, `midpoints.length` below the last. What the drop indicator is drawn at, and
 * where a re-docked card is written into the order.
 */
export function dropIndexAt(pointerY: number, midpoints: number[]): number {
  let index = 0;
  while (index < midpoints.length && (midpoints[index] ?? 0) < pointerY) index += 1;
  return index;
}

/** How near the end of the column a drag has to come before it scrolls, in CSS pixels. */
export const AUTOSCROLL_MARGIN = 48;

/** The fastest it scrolls, in pixels per move event, right at the very edge. */
const AUTOSCROLL_SPEED = 14;

/**
 * How far the column should scroll for a drag at `pointerY`: negative up, positive down,
 * zero anywhere but the last {@link AUTOSCROLL_MARGIN} of either end. Ramped rather than
 * fixed so the edge of the margin creeps and the last pixel runs.
 */
export function autoScrollStep(
  pointerY: number,
  viewport: { top: number; bottom: number },
): number {
  const above = pointerY - viewport.top;
  const below = viewport.bottom - pointerY;
  if (above < AUTOSCROLL_MARGIN) {
    return (
      -AUTOSCROLL_SPEED * Math.min(1, Math.max(0, (AUTOSCROLL_MARGIN - above) / AUTOSCROLL_MARGIN))
    );
  }
  if (below < AUTOSCROLL_MARGIN) {
    return (
      AUTOSCROLL_SPEED * Math.min(1, Math.max(0, (AUTOSCROLL_MARGIN - below) / AUTOSCROLL_MARGIN))
    );
  }
  return 0;
}

/** Does a floating card dropped here belong back in the column? */
export function docksInto(rect: Rect, column: Rect | null): boolean {
  if (!column) return false;
  const overlapX =
    Math.min(rect.x + rect.width, column.x + column.width) - Math.max(rect.x, column.x);
  const overlapY =
    Math.min(rect.y + rect.height, column.y + column.height) - Math.max(rect.y, column.y);
  return overlapX >= DOCK_DISTANCE && overlapY >= DOCK_DISTANCE;
}

/** One candidate edge pairing: where the dragged edge is, and where it would land. */
interface Candidate {
  from: number;
  to: number;
}

function nearest(candidates: Candidate[]): number | null {
  let best: number | null = null;
  let distance = SNAP_DISTANCE;
  for (const candidate of candidates) {
    const gap = Math.abs(candidate.from - candidate.to);
    if (gap > distance) continue;
    distance = gap;
    best = candidate.to - candidate.from;
  }
  return best;
}

/**
 * The offset that snaps `rect` to whichever neighbour it came nearest, keeping {@link
 * SNAP_GAP} between them: side to side with the tops aligned, or stacked with the sides
 * aligned. Returns `{0, 0}` when nothing is near enough, so the caller can apply it blind.
 */
export function snapOffset(rect: Rect, others: Rect[]): { dx: number; dy: number } {
  const horizontal: Candidate[] = [];
  const vertical: Candidate[] = [];
  for (const other of others) {
    // Sides: the dragged card's left against the other's right, and the other way round.
    horizontal.push({ from: rect.x, to: other.x + other.width + SNAP_GAP });
    horizontal.push({ from: rect.x + rect.width, to: other.x - SNAP_GAP });
    // Edges flush, which is what makes a row of cards line up rather than stagger.
    horizontal.push({ from: rect.x, to: other.x });
    horizontal.push({ from: rect.x + rect.width, to: other.x + other.width });
    vertical.push({ from: rect.y, to: other.y + other.height + SNAP_GAP });
    vertical.push({ from: rect.y + rect.height, to: other.y - SNAP_GAP });
    vertical.push({ from: rect.y, to: other.y });
    vertical.push({ from: rect.y + rect.height, to: other.y + other.height });
  }
  return { dx: nearest(horizontal) ?? 0, dy: nearest(vertical) ?? 0 };
}

/**
 * Holds a floating card inside the window, whole. Not "mostly inside": a card half off the
 * top has its title bar — its only handle — out of reach, and one off the side is a panel
 * whose sliders cannot be read. A card taller or wider than the window is pinned to the
 * top left, which is the most of it that can be shown.
 */
export function clampToWindow(rect: Rect, window: { width: number; height: number }): Rect {
  return {
    ...rect,
    x: Math.max(0, Math.min(window.width - rect.width, rect.x)),
    y: Math.max(0, Math.min(window.height - rect.height, rect.y)),
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Pushes `rect` out of anything it is sitting on top of, along whichever axis needs the
 * smaller move, leaving {@link SNAP_GAP} between the two. Floating cards do not overlap
 * each other or the docked columns: a card that covers the filmstrip or the library is a
 * card whose own contents you cannot read either.
 *
 * Repeated until nothing overlaps, because pushing clear of one card can land on the next;
 * a handful of passes, then it gives up and leaves the card where it is rather than loop.
 */
export function pushApart(rect: Rect, others: Rect[]): Rect {
  let moved = rect;
  for (let pass = 0; pass < 4; pass++) {
    const hit = others.find((other) => overlaps(moved, other));
    if (!hit) return moved;
    // The four ways out, as signed moves; the shortest wins.
    const left = hit.x - SNAP_GAP - (moved.x + moved.width);
    const right = hit.x + hit.width + SNAP_GAP - moved.x;
    const up = hit.y - SNAP_GAP - (moved.y + moved.height);
    const down = hit.y + hit.height + SNAP_GAP - moved.y;
    const dx = Math.abs(left) < Math.abs(right) ? left : right;
    const dy = Math.abs(up) < Math.abs(down) ? up : down;
    moved =
      Math.abs(dx) <= Math.abs(dy) ? { ...moved, x: moved.x + dx } : { ...moved, y: moved.y + dy };
  }
  return moved;
}

import { describe, expect, test } from "bun:test";
import {
  AUTOSCROLL_MARGIN,
  autoScrollStep,
  clampToWindow,
  DOCK_DISTANCE,
  docksInto,
  dropIndexAt,
  pushApart,
  reorderDocked,
  SNAP_DISTANCE,
  SNAP_GAP,
  snapOffset,
  type Rect,
} from "../src/panels";

function rect(x: number, y: number, width = 320, height = 200): Rect {
  return { x, y, width, height };
}

describe("reordering the column", () => {
  // Three cards, 100 tall, stacked from y = 0: their middles are at 50, 150 and 250.
  const ids = ["histogram", "edit", "curve"];
  const middles = [50, 150, 250];

  test("a card dragged past a neighbour's middle swaps with it", () => {
    expect(reorderDocked(ids, "histogram", 160, middles)).toEqual(["edit", "histogram", "curve"]);
    expect(reorderDocked(ids, "curve", 40, middles)).toEqual(["curve", "histogram", "edit"]);
  });

  test("a card held over its own slot does not move", () => {
    expect(reorderDocked(ids, "edit", 150, middles)).toBe(ids);
    expect(reorderDocked(ids, "histogram", 40, middles)).toBe(ids);
  });

  test("an id the column does not hold is left alone", () => {
    expect(reorderDocked(ids, "nothing", 400, middles)).toBe(ids);
  });

  test("dragged past the last middle it lands at the bottom", () => {
    expect(reorderDocked(ids, "histogram", 900, middles)).toEqual(["edit", "curve", "histogram"]);
  });
});

describe("snapping a floating card", () => {
  const neighbour = rect(500, 300);

  test("a near edge snaps with the gap between the two", () => {
    // The dragged card's right edge is 4 px short of the neighbour's left: it lands a gap away.
    const dragged = rect(500 - 320 - SNAP_GAP - 4, 300);
    const { dx, dy } = snapOffset(dragged, [neighbour]);
    expect(dragged.x + dx + dragged.width).toBe(neighbour.x - SNAP_GAP);
    expect(dy).toBe(0);
  });

  test("stacked cards line their sides up", () => {
    const dragged = rect(500 + 3, 300 + 200 + SNAP_GAP + 2);
    const { dx, dy } = snapOffset(dragged, [neighbour]);
    expect(dragged.x + dx).toBe(neighbour.x);
    expect(dragged.y + dy).toBe(neighbour.y + neighbour.height + SNAP_GAP);
  });

  test("nothing within reach is no offset at all", () => {
    expect(snapOffset(rect(0, 0), [neighbour])).toEqual({ dx: 0, dy: 0 });
    expect(snapOffset(rect(0, 0), [])).toEqual({ dx: 0, dy: 0 });
  });

  test("the nearest edge wins when two are in reach", () => {
    const close = rect(200, 300);
    const dragged = rect(200 + 320 + SNAP_GAP - 1, 300);
    const { dx } = snapOffset(dragged, [close, neighbour]);
    // One px from `close`'s gap, ten from `neighbour`'s: it takes the one-pixel move.
    expect(Math.abs(dx)).toBeLessThanOrEqual(SNAP_DISTANCE);
    expect(dragged.x + dx).toBe(close.x + close.width + SNAP_GAP);
  });
});

describe("docking back into the column", () => {
  const column = rect(1600, 8, 320, 900);

  test("a card dropped over the column goes back in", () => {
    expect(docksInto(rect(1600 - 320 + DOCK_DISTANCE, 100), column)).toBe(true);
    expect(docksInto(rect(1610, 100), column)).toBe(true);
  });

  test("a card dropped clear of it stays floating", () => {
    expect(docksInto(rect(400, 100), column)).toBe(false);
    // Touching by less than the threshold is a near miss, not a drop.
    expect(docksInto(rect(1600 - 320 + 2, 100), column)).toBe(false);
    // Nothing to dock into: the column is hidden.
    expect(docksInto(rect(1610, 100), null)).toBe(false);
  });
});

describe("keeping a floating card inside the window", () => {
  const window = { width: 1920, height: 1080 };

  test("no edge of it is allowed off the screen", () => {
    expect(clampToWindow(rect(-1000, 100), window).x).toBe(0);
    expect(clampToWindow(rect(5000, 100), window).x).toBe(1920 - 320);
    expect(clampToWindow(rect(100, -500), window).y).toBe(0);
    expect(clampToWindow(rect(100, 5000), window).y).toBe(1080 - 200);
  });

  test("a card bigger than the window is pinned to its top left", () => {
    const huge = rect(400, 400, 3000, 2000);
    expect(clampToWindow(huge, window)).toMatchObject({ x: 0, y: 0 });
  });

  test("a card already on screen is left where it is", () => {
    expect(clampToWindow(rect(800, 400), window)).toEqual(rect(800, 400));
  });
});

describe("keeping floating cards off the docked ones", () => {
  const filmstrip = rect(8, 900, 1900, 160);

  test("a card dropped on the filmstrip is pushed clear of it, gap and all", () => {
    // Overlapping its top edge by 40 px: the shortest way out is straight up.
    const covering = rect(400, 900 - 200 + 40);
    const clear = pushApart(covering, [filmstrip]);
    expect(clear.y + clear.height).toBe(filmstrip.y - SNAP_GAP);
    expect(clear.x).toBe(covering.x);
  });

  test("it leaves along whichever axis is the shorter way out", () => {
    const column = rect(1600, 8, 320, 900);
    // Ten px into the column's left edge, but hundreds from its top: it goes sideways.
    const covering = rect(1600 - 320 + 10, 400);
    const clear = pushApart(covering, [column]);
    expect(clear.x + clear.width).toBe(column.x - SNAP_GAP);
    expect(clear.y).toBe(covering.y);
  });

  test("a card that sits clear of everything is not moved at all", () => {
    const free = rect(600, 300);
    expect(pushApart(free, [filmstrip])).toEqual(free);
    expect(pushApart(free, [])).toEqual(free);
  });

  test("pushed out of one and onto the next, it keeps going", () => {
    const library = rect(0, 0, 400, 1000);
    const footer = rect(0, 900, 1900, 160);
    // In the corner where the two meet: sideways off the library, then up off the footer.
    const clear = pushApart(rect(380, 850, 200, 200), [library, footer]);
    const hits = [library, footer].filter(
      (dock) =>
        clear.x < dock.x + dock.width &&
        dock.x < clear.x + clear.width &&
        clear.y < dock.y + dock.height &&
        dock.y < clear.y + clear.height,
    );
    expect(hits).toEqual([]);
    expect(clear.x).toBe(library.x + library.width + SNAP_GAP);
    expect(clear.y + clear.height).toBe(footer.y - SNAP_GAP);
  });

  test("nowhere to go is left alone rather than looped over", () => {
    // Two full-height columns 20 px apart cannot take a 200 px card between them; the
    // push gives up instead of bouncing the card between the pair for ever.
    const left = rect(0, 0, 400, 1000);
    const right = rect(420, 0, 400, 1000);
    expect(() => pushApart(rect(380, 100, 200, 200), [left, right])).not.toThrow();
  });
});

describe("the slot a drop would land in", () => {
  // Three 100-tall cards from y = 0: middles at 50, 150, 250.
  const middles = [50, 150, 250];

  test("counts the middles the pointer has passed", () => {
    expect(dropIndexAt(10, middles)).toBe(0);
    expect(dropIndexAt(60, middles)).toBe(1);
    expect(dropIndexAt(160, middles)).toBe(2);
    // Below the last card: after everything, which is a slot too.
    expect(dropIndexAt(900, middles)).toBe(3);
  });

  test("an empty column has the one slot", () => {
    expect(dropIndexAt(400, [])).toBe(0);
  });
});

describe("auto-scrolling the column", () => {
  const viewport = { top: 100, bottom: 900 };

  test("the middle of the column does not scroll", () => {
    expect(autoScrollStep(500, viewport)).toBe(0);
    expect(autoScrollStep(100 + AUTOSCROLL_MARGIN, viewport)).toBe(0);
    expect(autoScrollStep(900 - AUTOSCROLL_MARGIN, viewport)).toBe(0);
  });

  test("either end pulls, and pulls harder the nearer the edge", () => {
    const nearTop = autoScrollStep(100 + AUTOSCROLL_MARGIN / 2, viewport);
    const atTop = autoScrollStep(100, viewport);
    expect(nearTop).toBeLessThan(0);
    expect(atTop).toBeLessThan(nearTop);

    const nearBottom = autoScrollStep(900 - AUTOSCROLL_MARGIN / 2, viewport);
    const atBottom = autoScrollStep(900, viewport);
    expect(nearBottom).toBeGreaterThan(0);
    expect(atBottom).toBeGreaterThan(nearBottom);
  });

  test("dragged past the end it does not scroll faster than at the end", () => {
    expect(autoScrollStep(-500, viewport)).toBe(autoScrollStep(100, viewport));
    expect(autoScrollStep(5000, viewport)).toBe(autoScrollStep(900, viewport));
  });
});

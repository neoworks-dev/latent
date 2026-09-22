// Where the right column's cards are: docked in the column in an order the user can drag,
// or floating loose over the viewer. The shell draws it; the rules are in `../../panels`.
//
// Layout, never edit state: nothing here reaches the op-stack or the sidecar. It is kept
// in the browser's own storage rather than in the catalog for the same reason — where a
// panel sits is this machine's business, not the photo's. A stored id whose pane no longer
// registers is simply not drawn; the column's own `order` is the default until a drag.
import {
  clampToWindow,
  docksInto,
  dropIndexAt,
  pushApart,
  reorderDocked,
  snapOffset,
  type FloatingPanel,
  type Rect,
} from "../../panels";

/** Where the placements are kept between runs. Layout only — no edit state goes here. */
const STORAGE_KEY = "latent.panel-layout.v1";

interface StoredLayout {
  floating: FloatingPanel[];
  order: string[];
  collapsed?: string[];
}

/** A drag in progress: which card, and where the pointer took hold of it. */
interface Grab {
  id: string;
  pointerId: number;
  /** Pointer offset inside the card, so it does not jump to its corner on pick-up. */
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  /** True once the card left the column; a docked drag only reorders. */
  floating: boolean;
}

export class PanelLayout {
  /** Cards that left the column, in the order they were detached. */
  floating = $state<FloatingPanel[]>([]);
  /** The docked ids, once something has been dragged; empty means "the column's own order". */
  order = $state<string[]>([]);
  /** The card being dragged, for the drop shadow and the cursor. */
  dragging = $state<string | null>(null);
  /**
   * Where a floating card held over the column would land: the slot the drop indicator is
   * drawn in, `null` when nothing is hovering it. A card dragged *within* the column has
   * no indicator — it moves through the order as it goes, which shows the same thing.
   */
  dropIndex = $state<number | null>(null);
  /** Cards folded to their title bar. Persisted with the placements. */
  collapsed = $state<string[]>([]);

  private grab: Grab | null = null;
  /** The column's own rect, so a floating card knows where "back in" is. */
  private column: Rect | null = null;
  /** Every other docked card — the library, the filmstrip — for the overlap test. */
  private docks: Rect[] = [];

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null,
    /** One key per column: the two columns are dragged independently. */
    private readonly storageKey: string = STORAGE_KEY,
  ) {
    const stored = this.read();
    if (!stored) return;
    this.floating = stored.floating;
    this.order = stored.order;
    this.collapsed = stored.collapsed ?? [];
  }

  setColumnRect(rect: Rect | null): void {
    this.column = rect;
  }

  /** The rects a floating card may not cover: the column, the left rail, the footer. */
  setDockRects(rects: Rect[]): void {
    this.docks = rects;
  }

  isFloating(id: string): boolean {
    return this.floating.some((panel) => panel.id === id);
  }

  /** The docked ids in the order they should be drawn: the dragged order, or the given one. */
  docked(ids: string[]): string[] {
    const placed = ids.filter((id) => !this.isFloating(id));
    if (this.order.length === 0) return placed;
    const known = this.order.filter((id) => placed.includes(id));
    // A pane registered after the last drag has no place in the remembered order; it keeps
    // the one the registry gave it, at the end.
    return [...known, ...placed.filter((id) => !known.includes(id))];
  }

  /**
   * A press on a card's title bar. `rect` is the card as it sits now, in window
   * coordinates, so a detach can start exactly where the docked card was.
   */
  begin(id: string, pointerId: number, pointerX: number, pointerY: number, rect: Rect): void {
    this.grab = {
      id,
      pointerId,
      grabX: pointerX - rect.x,
      grabY: pointerY - rect.y,
      width: rect.width,
      height: rect.height,
      floating: this.isFloating(id),
    };
    this.dragging = id;
  }

  /**
   * The pointer moved. A docked card reorders the column until it is dragged clear of it,
   * at which point it detaches and follows the pointer; a floating one always follows.
   * `midpoints` are the docked cards' vertical middles, in the order `docked()` returned.
   */
  move(
    pointerId: number,
    pointerX: number,
    pointerY: number,
    docked: string[],
    midpoints: number[],
  ): void {
    const grab = this.grab;
    if (!grab || grab.pointerId !== pointerId) return;
    const rect = {
      x: pointerX - grab.grabX,
      y: pointerY - grab.grabY,
      width: grab.width,
      height: grab.height,
    };
    if (!grab.floating) {
      // Still over the column: this is a reorder, not a detach. The card moves through the
      // order as the pointer goes, so there is nothing for an indicator to add.
      if (docksInto(rect, this.column)) {
        this.dropIndex = null;
        this.order = reorderDocked(this.docked(docked), grab.id, pointerY, midpoints);
        return;
      }
      grab.floating = true;
      this.floating = [
        ...this.floating,
        { id: grab.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ];
    }
    // Held back over the column: show the slot it would drop into.
    this.dropIndex = docksInto(rect, this.column) ? dropIndexAt(pointerY, midpoints) : null;
    this.place(grab.id, rect);
  }

  /**
   * The press ended. A floating card dropped on the column goes back into it *where it was
   * dropped*: the id is written into the order at the slot the pointer was over, so a card
   * let go halfway down the column lands halfway down it rather than at the top.
   */
  end(pointerId: number, docked: string[], midpoints: number[], pointerY: number): void {
    const grab = this.grab;
    this.grab = null;
    this.dragging = null;
    this.dropIndex = null;
    if (!grab || grab.pointerId !== pointerId || !grab.floating) return;
    const panel = this.floating.find((entry) => entry.id === grab.id);
    if (!panel) return;
    const rect = { x: panel.x, y: panel.y, width: panel.width, height: panel.height };
    if (docksInto(rect, this.column)) {
      this.floating = this.floating.filter((entry) => entry.id !== grab.id);
      // `docked` is the column without this card; putting it back on the end and asking
      // for the reorder is the same question the column's own drags ask.
      this.order = reorderDocked([...this.docked(docked), grab.id], grab.id, pointerY, midpoints);
    }
    this.save();
  }

  /**
   * Re-settles every floating card: back inside the window and off the docked ones. Called
   * when the window resizes and once the cards a stored layout named have been measured —
   * a layout saved on a larger screen would otherwise put one off the edge.
   */
  reflow(measured: readonly { id: string; height: number }[]): void {
    if (this.floating.length === 0 || this.grab) return;
    for (const panel of this.floating) {
      const height = measured.find((entry) => entry.id === panel.id)?.height;
      if (height === undefined) continue;
      this.place(panel.id, { x: panel.x, y: panel.y, width: panel.width, height });
    }
    this.save();
  }

  isCollapsed(id: string): boolean {
    return this.collapsed.includes(id);
  }

  /** Folds a card to its title bar, or opens it again. */
  toggleCollapsed(id: string): void {
    this.collapsed = this.isCollapsed(id)
      ? this.collapsed.filter((entry) => entry !== id)
      : [...this.collapsed, id];
    this.save();
  }

  /** Puts a floating card back in the column from outside a drag — the card's own button. */
  dock(id: string): void {
    this.floating = this.floating.filter((entry) => entry.id !== id);
    this.save();
  }

  private read(): StoredLayout | null {
    const raw = this.storage?.getItem(this.storageKey);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const { floating, order } = parsed as Partial<StoredLayout>;
      // A stored layout names panes by id; one that no longer registers is dropped by the
      // shell when it resolves the ids, so nothing has to be validated against a registry
      // that does not exist yet at construction time.
      if (!Array.isArray(floating) || !Array.isArray(order)) return null;
      const { collapsed } = parsed as Partial<StoredLayout>;
      if (!Array.isArray(collapsed)) return { floating, order };
      return { floating, order, collapsed };
    } catch {
      // A layout written by an older build, or hand-edited into nonsense: start docked.
      return null;
    }
  }

  private save(): void {
    this.storage?.setItem(
      this.storageKey,
      JSON.stringify({ floating: this.floating, order: this.order, collapsed: this.collapsed }),
    );
  }

  /**
   * Moves one floating card: snapped to whatever it came near, kept inside the window, and
   * pushed back out of anything it landed on. Everything docked counts as a neighbour, so
   * a card snaps to the filmstrip and the library and never covers either.
   */
  private place(id: string, rect: Rect): void {
    // Each neighbour's own box, not the dragged card's height stamped onto all of them:
    // two cards of different heights would otherwise pass straight through each other.
    const others = this.floating
      .filter((panel) => panel.id !== id)
      .map((panel) => ({ x: panel.x, y: panel.y, width: panel.width, height: panel.height }));
    const neighbours = [...others, ...this.docks];
    const offset = snapOffset(rect, neighbours);
    const snapped = { ...rect, x: rect.x + offset.dx, y: rect.y + offset.dy };
    // Clamped last: a push out of a dock can aim a card off the edge of the window, and
    // the window is the harder constraint of the two.
    const clear = clampToWindow(pushApart(snapped, neighbours), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    // Nothing moved: assigning anyway would wake every reader of `floating`, and the
    // shell's ResizeObserver settles cards from inside one of those reactions.
    const current = this.floating.find((panel) => panel.id === id);
    if (
      current &&
      current.x === clear.x &&
      current.y === clear.y &&
      current.height === rect.height
    ) {
      return;
    }
    this.floating = this.floating.map((panel) =>
      panel.id === id ? { ...panel, x: clear.x, y: clear.y, height: rect.height } : panel,
    );
  }
}

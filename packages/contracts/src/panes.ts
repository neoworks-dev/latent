import type { Component } from "svelte";

/**
 * A pane is one region of the single window: the viewer, a panel column, the filmstrip.
 * Plugins register definitions; where a pane lands is the shell's business.
 */
export interface PaneDefinition {
  id: string;
  title: string;
  /**
   * Which shell region the pane belongs to. `rail` is not a column: the rail draws a button
   * for the pane and opens it as a flyout beside itself, which is what a panel needs that
   * has to stay open while the Edit column is being used — Masks is one.
   */
  region: "center" | "right" | "bottom" | "left" | "rail";
  order?: number;
  /**
   * Rail mode this pane belongs to — "edit", "info", later "crop", "masks". A pane
   * without one is not mode-specific and shows whatever the rail is on.
   */
  mode?: string;
  /**
   * Draw the pane without the card's title bar. For a pane that is already a list of
   * headed sections — the Edit column is one — a second heading above it says nothing.
   * It also gives up the drag handle, so such a pane neither reorders nor detaches.
   */
  untitled?: boolean;
  /**
   * Drawn in the card's title bar, right of the heading: the pane's own controls. A
   * generated panel puts its Reset there, so the card keeps one header rather than
   * growing a second one under the first.
   */
  headerActions?: Component<{ paneId: string }>;
  component: Component<{ paneId: string }>;
}

/**
 * What the shell floats over the viewer, in CSS pixels: the cards' own edges. The viewer
 * hands it to the engine as `view.render`'s insets, so a fitted photo sits in the hole
 * between the panels while a zoomed one runs on behind them. Layout, never edit state.
 */
export interface SafeArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PaneRegistry {
  register(definition: PaneDefinition): () => void;
  list(region?: PaneDefinition["region"]): PaneDefinition[];
  /**
   * The rail mode the right column is showing. The shell draws it; a plugin reads it to
   * know whether it is on screen, and sets it to hand over — the mask badge in the Edit
   * column switches to "masks" the way Lightroom's does.
   */
  readonly mode: string;
  setMode(mode: string): void;
  /**
   * The `rail` pane whose flyout is open, null when none is. It is not a mode: the flyout
   * stays open across every mode, because the point of it is to edit a mask with the Edit
   * column's own sliders. A plugin sets it to hand over — the Edit column's mask badge does.
   */
  readonly railPane: string | null;
  setRailPane(id: string | null): void;
  /** The area the floating cards leave clear. The shell measures it; the viewer reads it. */
  readonly safeArea: SafeArea;
  setSafeArea(area: SafeArea): void;
}

/** The panes a rail mode shows: its own, plus everything that is not mode-specific. */
export function panesForMode<Pane extends { mode?: string }>(panes: Pane[], mode: string): Pane[] {
  return panes.filter((pane) => pane.mode === undefined || pane.mode === mode);
}

/** The rail modes the registered panes ask for, in the order the panes were registered. */
export function paneModes<Pane extends { mode?: string }>(panes: Pane[]): string[] {
  const modes: string[] = [];
  for (const pane of panes) {
    if (pane.mode === undefined || modes.includes(pane.mode)) continue;
    modes.push(pane.mode);
  }
  return modes;
}

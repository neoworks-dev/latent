import type { Component } from "svelte";

/**
 * A pane is one region of the single window: the viewer, a panel column, the filmstrip.
 * Plugins register definitions; where a pane lands is the shell's business.
 */
export interface PaneDefinition {
  id: string;
  title: string;
  /** Which shell region the pane belongs to. */
  region: "center" | "right" | "bottom" | "left";
  order?: number;
  /**
   * Rail mode this pane belongs to — "edit", "info", later "crop", "masks". A pane
   * without one is not mode-specific and shows whatever the rail is on.
   */
  mode?: string;
  component: Component<{ paneId: string }>;
}

export interface PaneRegistry {
  register(definition: PaneDefinition): () => void;
  list(region?: PaneDefinition["region"]): PaneDefinition[];
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

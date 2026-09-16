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
  component: Component<{ paneId: string }>;
}

export interface PaneRegistry {
  register(definition: PaneDefinition): () => void;
  list(region?: PaneDefinition["region"]): PaneDefinition[];
}

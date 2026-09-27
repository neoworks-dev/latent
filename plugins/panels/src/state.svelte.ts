import type { OpDefinition } from "@latent/protocol";
import { groupBySection, type Highlight, type PanelGroup } from "./panels";

/**
 * What `ops.describe` returned, grouped for the panel column, plus which sections are
 * folded. Never edit state — the fold is view state and belongs to the UI, the values
 * do not and come from the engine on every read.
 */
export class PanelsState {
  ops = $state<OpDefinition[]>([]);
  groups = $derived<PanelGroup[]>(groupBySection(this.ops));

  /**
   * A control someone pointed at — the Assistant's "Highlights 0 → −80" — for the rows it
   * names to scroll into view and flash. `param` null is every row of the op. Rows that
   * mount later (a mode switch, a flyout opening) still catch it while it is fresh.
   */
  highlighted = $state<Highlight | null>(null);

  highlight(target: Omit<Highlight, "at">): void {
    this.highlighted = { ...target, at: Date.now() };
  }

  /** Sections are open until folded, so a section the engine adds later shows up open. */
  private folded = $state<Record<string, boolean>>({});

  isOpen(section: string): boolean {
    return this.folded[section] !== true;
  }

  toggle(section: string): void {
    this.folded[section] = this.isOpen(section);
  }
}

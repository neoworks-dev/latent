import type { OpDefinition } from "@latent/protocol";
import { groupBySection, type PanelGroup } from "./panels";

/**
 * What `ops.describe` returned, grouped for the panel column, plus which sections are
 * folded. Never edit state — the fold is view state and belongs to the UI, the values
 * do not and come from the engine on every read.
 */
export class PanelsState {
  ops = $state<OpDefinition[]>([]);
  groups = $derived<PanelGroup[]>(groupBySection(this.ops));

  /** Sections are open until folded, so a section the engine adds later shows up open. */
  private folded = $state<Record<string, boolean>>({});

  isOpen(section: string): boolean {
    return this.folded[section] !== true;
  }

  toggle(section: string): void {
    this.folded[section] = this.isOpen(section);
  }
}

import type { OpDefinition } from "@latent/protocol";
import { groupByPanel, type PanelGroup } from "./panels";

/** What `ops.describe` returned, grouped for the panel column. Never edit state. */
export class PanelsState {
  ops = $state<OpDefinition[]>([]);
  groups = $derived<PanelGroup[]>(groupByPanel(this.ops));

  opsFor(panel: string): OpDefinition[] {
    const group = this.groups.find((candidate) => candidate.panel === panel);
    if (!group) return [];
    return group.ops;
  }
}

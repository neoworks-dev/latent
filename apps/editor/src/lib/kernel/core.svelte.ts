// Core services mounted by the shell before any feature plugin: the engine connection
// and the pane registry. Feature plugins `inject` these by key.
import type { PaneDefinition, PaneRegistry, SafeArea } from "@latent/contracts";
import type { Context, Plugin } from "@neoworks/extension-system";
import { WebSocketEngineClient } from "../engine/client";

class ReactivePaneRegistry implements PaneRegistry {
  panes = $state<PaneDefinition[]>([]);
  /** The rail mode, held here rather than in the shell so a plugin can hand over to one. */
  mode = $state("edit");
  /** The open rail flyout. Outlives the mode: Masks is edited with the Edit column open. */
  railPane = $state<string | null>(null);
  /** What the floating cards cover; the shell measures it, the viewer fits inside it. */
  safeArea = $state<SafeArea>({ left: 0, top: 0, right: 0, bottom: 0 });

  setMode(mode: string): void {
    this.mode = mode;
  }

  setRailPane(id: string | null): void {
    this.railPane = id;
  }

  setSafeArea(area: SafeArea): void {
    this.safeArea = { ...area };
  }

  register(definition: PaneDefinition): () => void {
    this.panes = [...this.panes, definition];
    return () => {
      this.panes = this.panes.filter((pane) => pane !== definition);
    };
  }

  list(region?: PaneDefinition["region"]): PaneDefinition[] {
    const panes = region ? this.panes.filter((pane) => pane.region === region) : this.panes;
    return [...panes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
}

export const enginePlugin: Plugin.Object<{ url: string }> = {
  name: "engine",
  apply(ctx: Context, config) {
    ctx.effect(() => {
      const client = new WebSocketEngineClient(config.url);
      const dispose = ctx.provide("engine", client);
      return () => {
        dispose();
        client.dispose();
      };
    }, "engine-websocket");
  },
};

export const panesPlugin: Plugin.Object<void> = {
  name: "panes",
  apply(ctx: Context) {
    ctx.provide("panes", new ReactivePaneRegistry());
  },
};

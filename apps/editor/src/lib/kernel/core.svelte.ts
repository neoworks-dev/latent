// Core services mounted by the shell before any feature plugin: the engine connection
// and the pane registry. Feature plugins `inject` these by key.
import type { PaneDefinition, PaneRegistry } from "@latent/contracts";
import type { Context, Plugin } from "@neoworks/extension-system";
import { WebSocketEngineClient } from "../engine/client";

class ReactivePaneRegistry implements PaneRegistry {
  panes = $state<PaneDefinition[]>([]);

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

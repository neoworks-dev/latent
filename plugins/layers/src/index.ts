// Layers: the op-stack as a layer list. There are no pixel layers in Latent — a layer is
// one op with a mask, an opacity and an enable, which is what this column edits.
import type { Context, Plugin } from "@neoworks/extension-system";
import LayersPane from "./LayersPane.svelte";
import { LayersState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    layers: LayersState;
  }
}

export const layersPlugin: Plugin.Object<void> = {
  name: "layers",
  inject: ["engine", "panes", "viewer", "panels"],
  apply(ctx: Context) {
    const state = new LayersState(ctx.engine, ctx.viewer);
    ctx.provide("layers", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "layers",
        title: "Layers",
        region: "right",
        order: 10,
        mode: "layers",
        component: LayersPane,
      }),
    );
  },
};

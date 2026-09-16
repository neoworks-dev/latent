// The viewer: one canvas showing the engine's frames for the open photo, and the mirror
// of the engine's stack that every panel writes through. The panels themselves are
// generated from ops.describe by @latent/plugin-panels.
import type { Context, Plugin } from "@neoworks/extension-system";
import { ViewerState } from "./state.svelte";
import Viewer from "./Viewer.svelte";

export const viewerPlugin: Plugin.Object<void> = {
  name: "viewer",
  inject: ["engine", "panes"],
  apply(ctx: Context) {
    const state = new ViewerState(ctx.engine);
    ctx.provide("viewer", state);
    ctx.effect(() =>
      ctx.panes.register({ id: "viewer", title: "Viewer", region: "center", component: Viewer }),
    );
    ctx.effect(() => () => state.dispose());
  },
};

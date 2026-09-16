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
    // Dev hook: `?frametrace=<n>` prints a p50/p95 stage breakdown every n frames.
    const trace = Number(new URLSearchParams(location.search).get("frametrace") ?? 0);
    const state = new ViewerState(ctx.engine, Number.isFinite(trace) ? trace : 0);
    ctx.provide("viewer", state);
    // The same object under a second key: how the frame is rendered is the crop tool's
    // business and not something a panel writing ops should be able to reach.
    ctx.provide("geometryView", state);
    ctx.effect(() =>
      ctx.panes.register({ id: "viewer", title: "Viewer", region: "center", component: Viewer }),
    );
    ctx.effect(() => () => state.dispose());
  },
};

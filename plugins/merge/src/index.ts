// Photo Merge: HDR, Panorama and HDR Panorama. The merge itself is engine work — this
// plugin collects Lightroom's options, shows the preview the engine rendered, and follows
// the job. No pixels are made here and no catalog row is written here.
//
// The library asks for a merge by emitting `catalog/merge`; this plugin is the listener.
// The event is declared and emitted by `@latent/plugin-catalog`, so the catalog knows
// nothing about this package and the dependency edge stays catalog ← merge.
import type { Context, Plugin } from "@neoworks/extension-system";
import MergeDialog from "./MergeDialog.svelte";
import { MergeState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    merge: MergeState;
  }
}

export const mergePlugin: Plugin.Object<void> = {
  name: "merge",
  inject: ["engine", "panes", "catalog", "viewer"],
  apply(ctx: Context) {
    const state = new MergeState(ctx.engine, ctx.catalog, ctx.viewer);
    ctx.provide("merge", state);
    ctx.effect(() => () => state.dispose());

    // A centre pane, like the catalog's grid: it draws nothing while closed and covers the
    // viewer when open, so the shell needs no notion of a modal.
    ctx.effect(() =>
      ctx.panes.register({
        id: "merge",
        title: "Photo Merge",
        region: "center",
        order: 20,
        component: MergeDialog,
      }),
    );

    ctx.on("catalog/merge", (kind, photoIds) => state.openDialog(kind, photoIds));
  },
};

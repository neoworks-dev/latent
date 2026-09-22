// Masks: the rail mode, the column, and the tools the viewer's overlay draws. The mask
// itself lives on the op in the engine's stack — this plugin edits parameters and asks for
// rasters, and never holds a pixel of its own beyond the preview it was sent.
import type { Context, Plugin } from "@neoworks/extension-system";
import MaskActions from "./MaskActions.svelte";
import MasksPane from "./MasksPane.svelte";
import { MasksState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    masks: MasksState;
  }
}

export const masksPlugin: Plugin.Object<void> = {
  name: "masks",
  inject: ["engine", "panes", "viewer", "panels"],
  apply(ctx: Context) {
    const state = new MasksState(ctx.engine, ctx.viewer);
    ctx.provide("masks", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      // Not a column and not a mode: the panel hangs off the rail and stays open while the
      // Edit column is used, because a selected mask is what those sliders write into.
      ctx.panes.register({
        id: "masks",
        title: "Masks",
        region: "rail",
        order: 10,
        headerActions: MaskActions,
        component: MasksPane,
      }),
    );
  },
};

// The Layers column shows a thumbnail per mask and has to serialise its previews with
// everything else asking for one; the queue is the only correct way to pair an LMSK frame
// with the call that asked for it.
export { MaskPreviewQueue, type MaskPreview } from "./preview";
export { default as KindIcon } from "./KindIcon.svelte";
export { maskSignature, tintPixels, tintStyle, type MaskTint } from "./masks";

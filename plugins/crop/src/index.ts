// Crop: the rail mode, the column, and the overlay the viewer draws it on. The crop lives
// in the engine's stack as the `crop`, `rotate` and `flip` ops — this plugin is a tool that
// writes them, and holds no geometry of its own.
import type { Context, Plugin } from "@neoworks/extension-system";
import CropPane from "./CropPane.svelte";
import { cropShortcut } from "./crop";
import { CropState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    crop: CropState;
  }
}

export const cropPlugin: Plugin.Object<void> = {
  name: "crop",
  inject: ["engine", "panes", "viewer", "geometryView"],
  apply(ctx: Context) {
    const state = new CropState(ctx.viewer, ctx.geometryView, ctx.panes);
    ctx.provide("crop", state);
    ctx.effect(() =>
      ctx.panes.register({
        id: "crop",
        title: "Crop",
        region: "right",
        order: 10,
        mode: "crop",
        component: CropPane,
      }),
    );

    // `R` is the way in as well as the way out, so it cannot live in the column the way
    // Esc and X do — the column is not mounted when the tool is closed.
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const action = cropShortcut({
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          target,
        });
        if (action !== "toggleTool") return;
        event.preventDefault();
        state.toggle();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, "crop-shortcut");
  },
};

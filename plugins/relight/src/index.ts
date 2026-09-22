// Relight (PROMPT.md 3.8): a rail mode whose column estimates the scene's depth, adds
// `relight` ops to the stack, and drags them over the photo. The light and its depth map
// both live in the engine — this plugin writes params and starts jobs, and never holds a
// pixel.
import type { Context, Plugin } from "@neoworks/extension-system";
import { keyEvent, relightShortcut } from "./relight";
import RelightPane from "./RelightPane.svelte";
import { RelightState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    relight: RelightState;
  }
}

export const relightPlugin: Plugin.Object<void> = {
  name: "relight",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new RelightState(ctx.engine, ctx.viewer, ctx.panes);
    ctx.provide("relight", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "relight",
        title: "Relight",
        region: "right",
        order: 10,
        mode: "relight",
        component: RelightPane,
      }),
    );

    // `L` is the way in as well as the way out, so it cannot live in the column the way Esc
    // does — the column is not mounted when the tool is closed.
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (relightShortcut(keyEvent(event)) !== "toggleTool") return;
        event.preventDefault();
        state.toggle();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, "relight-shortcut");
  },
};

export { RELIGHT_MODE, RelightState } from "./state.svelte";
export { lightsIn, RELIGHT_OP } from "./relight";

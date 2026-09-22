// AI Upscale (issue #52): a rail mode whose column adds one `upscale` op, runs it
// through the engine's generative backend and shows what came back. The raster and its
// input hash live in the engine — this plugin writes params and starts jobs, and never
// holds a pixel.
import type { Context, Plugin } from "@neoworks/extension-system";
import { UPSCALE_MODE } from "./upscale";
import UpscalePane from "./UpscalePane.svelte";
import { UpscaleState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    upscale: UpscaleState;
  }
}

export const upscalePlugin: Plugin.Object<void> = {
  name: "upscale",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new UpscaleState(ctx.engine, ctx.viewer);
    ctx.provide("upscale", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "upscale",
        title: "AI Upscale",
        region: "right",
        order: 12,
        mode: UPSCALE_MODE,
        component: UpscalePane,
      }),
    );
  },
};

export { UpscaleState } from "./state.svelte";
export {
  canRun,
  factorNumber,
  factorOf,
  factors,
  graphReady,
  isUpscaleOp,
  missingGraphMessage,
  sizeNote,
  UPSCALE_MODE,
  UPSCALE_OP,
  type Factor,
} from "./upscale";

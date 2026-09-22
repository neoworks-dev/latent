// The Denoise column (issue #51): the two ways to take noise out of a frame, side by
// side. `denoise` is a model raster run through the engine's generative backend — the
// raster and its input hash live in the engine, and this plugin writes params and starts
// jobs without ever holding a pixel. `manual_denoise` is the wavelet filter in the render
// pass, which is four numbers and no job at all.
import type { Context, Plugin } from "@neoworks/extension-system";
import { DENOISE_MODE } from "./denoise";
import DenoisePane from "./DenoisePane.svelte";
import { DenoiseState, ManualDenoiseState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    denoise: DenoiseState;
    manualDenoise: ManualDenoiseState;
  }
}

export const denoisePlugin: Plugin.Object<void> = {
  name: "denoise",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new DenoiseState(ctx.engine, ctx.viewer);
    ctx.provide("denoise", state);
    ctx.provide("manualDenoise", new ManualDenoiseState(ctx.engine, ctx.viewer));
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "denoise",
        title: "Denoise",
        region: "right",
        order: 11,
        mode: DENOISE_MODE,
        component: DenoisePane,
      }),
    );
  },
};

export { DenoiseState, ManualDenoiseState } from "./state.svelte";
export {
  canRun,
  DENOISE_INPUT_SIZE,
  DENOISE_MODE,
  DENOISE_OP,
  graphReady,
  isDenoiseOp,
  LOCAL_DENOISE_INPUT_SIZE,
  LOCAL_DENOISE_MODEL,
  localDenoiseReady,
  MANUAL_DENOISE_OP,
  manualNote,
  manualSpecs,
  manualValue,
  missingGraphMessage,
  resolutionNote,
  strengthSpec,
} from "./denoise";

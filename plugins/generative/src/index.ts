// Generative ops (PROMPT.md 3.5): a rail mode whose column adds a fill or a remove over the
// selected mask, runs it through the engine's backend, and shows what came back. The op and
// its result live in the engine's stack — this plugin edits params and starts jobs, and
// never holds a pixel.
import type { Context, Plugin } from "@neoworks/extension-system";
import GenerativePane from "./GenerativePane.svelte";
import { GenerativeState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    generative: GenerativeState;
  }
}

export const generativePlugin: Plugin.Object<void> = {
  // `masks` is injected rather than reimplemented: the region a fill repaints is an ordinary
  // op mask, and the Masks column is where one is made.
  inject: ["engine", "panes", "viewer", "masks"],
  name: "generative",
  apply(ctx: Context) {
    const state = new GenerativeState(ctx.engine, ctx.viewer);
    ctx.provide("generative", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "generative",
        title: "Generative",
        region: "right",
        order: 10,
        mode: "generative",
        component: GenerativePane,
      }),
    );
  },
};

export {
  failureMessage,
  generativeOps,
  isGenerativeOp,
  modelOptions,
  opLabels,
  statusLine,
} from "./generative";

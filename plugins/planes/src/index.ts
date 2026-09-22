// Planes: a rail mode where one aircraft trail is drawn along, the engine finds every other
// streak like it, repaints them, and then repeats the search over the rest of the sequence.
// The seed stroke and the three numbers are mask params in the engine's stack — this plugin
// writes params and starts jobs, and never holds a pixel.
import type { Context, Plugin } from "@neoworks/extension-system";
import PlanesPane from "./PlanesPane.svelte";
import { PlanesState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    planes: PlanesState;
  }
}

export const planesPlugin: Plugin.Object<void> = {
  name: "planes",
  inject: ["engine", "panes", "viewer", "catalog"],
  apply(ctx: Context) {
    const state = new PlanesState(ctx.engine, ctx.viewer, ctx.panes, ctx.catalog);
    ctx.provide("planes", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "planes",
        title: "Planes",
        region: "right",
        order: 11,
        mode: "planes",
        component: PlanesPane,
      }),
    );
  },
};

export { PlanesState } from "./state.svelte";
export {
  backendOf,
  batchLabel,
  defaultRepaintBackend,
  detectLabel,
  isRepaintBackend,
  repaintBackends,
  paramsOf,
  planesOp,
  PLANES_MODE,
  PLANES_OP,
  seedFromStroke,
  seedLength,
  seedIsUsable,
  seedOf,
  trailsComponent,
  trailsComponentOf,
  trailsMask,
  TRAILS_KIND,
} from "./planes";

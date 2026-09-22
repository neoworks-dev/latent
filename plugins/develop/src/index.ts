// The left column: where you are in the photo, what you can apply to it, and what has been
// done to it. Three panes, none of which holds edit state — the navigator reads the
// viewer's viewport, a preset is a set of values waiting to be written, and the history is
// the engine's own undo stack read back over `history.list`.
import type { Context, Plugin } from "@neoworks/extension-system";
import History from "./History.svelte";
import Navigator from "./Navigator.svelte";
import Presets from "./Presets.svelte";
import { DevelopState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    develop: DevelopState;
  }
}

export { historyRow, historyRows, type HistoryRow } from "./history";
export {
  applyPreset,
  builtinPresets,
  capturePreset,
  presetGroups,
  presetSize,
  readPresets,
  type Preset,
  type PresetGroup,
} from "./presets";
export { panForPoint, visibleRect, type ViewRect } from "./navigator";

export const developPlugin: Plugin.Object<void> = {
  name: "develop",
  inject: ["catalog", "engine", "panels", "panes", "viewer"],
  apply(ctx: Context) {
    ctx.provide("develop", new DevelopState(ctx.engine, localStorage));

    ctx.effect(() =>
      ctx.panes.register({
        id: "navigator",
        title: "Navigator",
        region: "left",
        order: 0,
        component: Navigator,
      }),
    );
    ctx.effect(() =>
      ctx.panes.register({
        id: "presets",
        title: "Presets",
        region: "left",
        order: 10,
        component: Presets,
      }),
    );
    ctx.effect(() =>
      ctx.panes.register({
        id: "history",
        title: "History",
        region: "left",
        order: 20,
        component: History,
      }),
    );
  },
};

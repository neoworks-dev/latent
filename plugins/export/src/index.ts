// Export: the rail mode that writes the current edit to disk. It holds no pixels and no
// edit state — it fills in `export.run`'s params, starts the job and watches its progress.
import type { Context, Plugin } from "@neoworks/extension-system";
import ExportPane from "./ExportPane.svelte";
import { ExportState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    export: ExportState;
  }
}

export const exportPlugin: Plugin.Object<void> = {
  name: "export",
  // `catalog` for the library selection: an export covers what is selected, or the open
  // photo when nothing is.
  inject: ["engine", "panes", "viewer", "catalog"],
  apply(ctx: Context) {
    const state = new ExportState(ctx.engine, ctx.catalog, ctx.viewer);
    ctx.provide("export", state);
    ctx.effect(() => () => state.dispose());
    ctx.effect(() =>
      ctx.panes.register({
        id: "export",
        title: "Export",
        region: "right",
        order: 10,
        mode: "export",
        component: ExportPane,
      }),
    );
  },
};

export { ExportState } from "./state.svelte";
export {
  colorSpaceChoices,
  defaultSettings,
  exportParams,
  exportPhotoIds,
  formatChoices,
  jobLabel,
  jobPercent,
  settingsProblem,
  sharpenChoices,
  type ExportSettings,
} from "./export";

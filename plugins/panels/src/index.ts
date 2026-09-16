// Generated panels: on connect the plugin asks the engine what it can do (`ops.describe`)
// and builds the Edit column from the answer — one collapsible section per Lightroom
// panel, one control per parameter. There is no hardcoded op list here.
import type { Context, Plugin } from "@neoworks/extension-system";
import GeneratedPanel from "./GeneratedPanel.svelte";
import { historyShortcut } from "./panels";
import { PanelsState } from "./state.svelte";
import StackStatus from "./StackStatus.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    panels: PanelsState;
  }
}

export const panelsPlugin: Plugin.Object<void> = {
  name: "panels",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new PanelsState();
    ctx.provide("panels", state);

    // One pane, not one per panel: Lightroom's Edit column is a single scroller whose
    // section headers stick to its top, which a pane per group cannot do.
    ctx.effect(async () => {
      await ctx.engine.whenOpen();
      const described = await ctx.engine.call("ops.describe", {});
      state.ops = described.ops;
      const pane = ctx.panes.register({
        id: "edit",
        title: "Edit",
        region: "right",
        order: 10,
        // The Edit column is the rail's "edit" mode; Info and the later modes replace it.
        mode: "edit",
        component: GeneratedPanel,
      });
      return () => {
        pane();
        state.ops = [];
      };
    }, "generated-panels");

    ctx.effect(() =>
      ctx.panes.register({
        id: "stack-status",
        title: "Stack",
        region: "right",
        order: 0,
        component: StackStatus,
      }),
    );

    // History shortcuts. A `commands` registry is Phase 1; until it exists this is the
    // one raw listener, registered with its inverse like everything else.
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        const action = historyShortcut(event);
        if (!action) return;
        event.preventDefault();
        if (action === "redo") void ctx.viewer.redo();
        else void ctx.viewer.undo();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, "history-shortcuts");
  },
};

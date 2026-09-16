// Generated panels: on connect the plugin asks the engine what it can do (`ops.describe`)
// and builds one right-hand section per Lightroom panel, one control per parameter. There
// is no hardcoded op list here — the engine's answer is the UI.
import type { Context, Plugin } from "@neoworks/extension-system";
import GeneratedPanel from "./GeneratedPanel.svelte";
import { groupByPanel, historyShortcut } from "./panels";
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

    ctx.effect(async () => {
      await ctx.engine.whenOpen();
      const described = await ctx.engine.call("ops.describe", {});
      state.ops = described.ops;
      const panes = groupByPanel(described.ops).map((group, index) =>
        ctx.panes.register({
          id: group.panel,
          title: group.label,
          region: "right",
          order: 10 + index * 10,
          component: GeneratedPanel,
        }),
      );
      return () => {
        for (const dispose of panes) dispose();
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

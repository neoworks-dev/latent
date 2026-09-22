// Generated panels: on connect the plugin asks the engine what it can do (`ops.describe`)
// and builds the Edit column from the answer — one collapsible section per Lightroom
// panel, one control per parameter. There is no hardcoded op list here.
import type { Context, Plugin } from "@neoworks/extension-system";
import GeneratedPanel from "./GeneratedPanel.svelte";
import { historyShortcut } from "./panels";
import SectionActions from "./SectionActions.svelte";
import { PanelsState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    panels: PanelsState;
  }
}

// The controls the hand-built columns reuse: the Masks pane draws the selected layer's own
// sliders with GeneratedPanel, and its component rows use the same boxed slider and
// readout as the Edit column rather than a second pair that drifts from it.
export { default as GeneratedPanel } from "./GeneratedPanel.svelte";
export { default as BoxedSlider } from "./BoxedSlider.svelte";
export { default as ValueField } from "./ValueField.svelte";
export { sliderRange, type SliderRange } from "./panels";
// The History pane prints a step in the units of the control that made it, so the
// formatting and the labelling are the panel column's, not a second copy of them.
export { formatValue, paramLabel, rowLabel } from "./panels";
// A preset can carry a tone curve, so it names the curve's own point type.
export { type CurvePoint } from "./curve";

export const panelsPlugin: Plugin.Object<void> = {
  name: "panels",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new PanelsState();
    ctx.provide("panels", state);

    // One pane per described section — `edit:light`, `edit:color` — rather than one for
    // the whole column. A card is the unit the shell can fold, reorder and drag out of the
    // column, so a section that is not a card can do none of those things.
    ctx.effect(async () => {
      await ctx.engine.whenOpen();
      const described = await ctx.engine.call("ops.describe", {});
      state.ops = described.ops;
      const panes = state.groups.map((group, index) =>
        ctx.panes.register({
          id: `edit:${group.key}`,
          title: group.label,
          region: "right",
          // Ten apart, in the order `ops.describe` put the sections in, so the histogram
          // (0) stays above them and a later drag can slot a card between any two.
          order: 10 + index * 10,
          // The Edit column is the rail's "edit" mode; Info and the later modes replace it.
          mode: "edit",
          headerActions: SectionActions,
          component: GeneratedPanel,
        }),
      );
      return () => {
        for (const pane of panes) pane();
        state.ops = [];
      };
    }, "generated-panels");

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

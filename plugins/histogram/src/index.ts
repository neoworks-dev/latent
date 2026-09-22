// The histogram: the engine's count of the frame on screen, at the top of the right
// column. It owns no state — the numbers ride on `view.render` and live in the viewer —
// so the plugin is one pane registration and nothing else.
import type { Context, Plugin } from "@neoworks/extension-system";
import HistogramPane from "./HistogramPane.svelte";

export {
  BOX,
  channelPath,
  clippingLabel,
  clippingOf,
  type Channel,
  type Clipping,
} from "./histogram";

export const histogramPlugin: Plugin.Object<void> = {
  name: "histogram",
  inject: ["panes", "viewer"],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.panes.register({
        id: "histogram",
        title: "Histogram",
        region: "right",
        // Above the stack readout (order 5), and with no `mode`: Lightroom keeps the
        // histogram at the top of the column whichever tool the rail is on.
        order: 0,
        component: HistogramPane,
      }),
    );
  },
};

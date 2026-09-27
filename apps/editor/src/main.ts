import "./app.css";
import { assistantPlugin } from "@latent/plugin-assistant";
import { catalogPlugin } from "@latent/plugin-catalog";
import { consolePlugin } from "@latent/plugin-console";
import { cropPlugin } from "@latent/plugin-crop";
import { denoisePlugin } from "@latent/plugin-denoise";
import { developPlugin } from "@latent/plugin-develop";
import { exportPlugin } from "@latent/plugin-export";
import { generativePlugin } from "@latent/plugin-generative";
import { histogramPlugin } from "@latent/plugin-histogram";
import { layersPlugin } from "@latent/plugin-layers";
import { masksPlugin } from "@latent/plugin-masks";
import { mergePlugin } from "@latent/plugin-merge";
import { panelsPlugin } from "@latent/plugin-panels";
import { planesPlugin } from "@latent/plugin-planes";
import { relightPlugin } from "@latent/plugin-relight";
import { upscalePlugin } from "@latent/plugin-upscale";
import { Context } from "@neoworks/extension-system";
import { mount } from "svelte";
import Shell from "./Shell.svelte";
import { enginePlugin, panesPlugin } from "./lib/kernel/core.svelte";
import { viewerPlugin } from "./plugins/viewer";

async function engineUrl(): Promise<string> {
  const fromBridge = await window.latentDesktop?.engineEndpoint();
  if (fromBridge) return fromBridge;
  const fromQuery = new URLSearchParams(location.search).get("engine");
  if (fromQuery) return fromQuery;
  throw new Error("no engine endpoint: run inside Electron or pass ?engine=ws://127.0.0.1:<port>");
}

const root = new Context();
void root.plugin(panesPlugin);
void root.plugin(enginePlugin, { url: await engineUrl() });
void root.plugin(viewerPlugin);
void root.plugin(panelsPlugin);
// The histogram sits above the panels in every rail mode and reads the viewer's numbers.
void root.plugin(histogramPlugin);
// Crop between Edit and Masks, which is the order Lightroom's rail has them in: the rail
// shows the modes in the order the panes registered.
void root.plugin(cropPlugin);
// Masks before Layers: the layer rows draw their thumbnails through the masks plugin's
// preview queue, and the rail shows the modes in the order the panes registered.
void root.plugin(masksPlugin);
// After Masks, which it injects: a fill's region is an ordinary op mask, made over there.
void root.plugin(generativePlugin);
// The two whole-frame model ops, in the order they render: a denoise raster is the input to
// everything above it, and an upscaler amplifies noise the denoise would have removed.
void root.plugin(denoisePlugin);
void root.plugin(upscalePlugin);
// Relight after the generative columns: all of them are AI tools over a photo rather than
// sliders, and the rail shows the modes in the order the panes registered.
void root.plugin(relightPlugin);
void root.plugin(layersPlugin);
void root.plugin(catalogPlugin);
// After the catalog: Photo Merge injects it, and the library is where a merge is asked for.
void root.plugin(mergePlugin);
// After the catalog too: the Planes column applies one detection to the whole selection.
void root.plugin(planesPlugin);
// Export last in the rail, after the catalog it reads its selection from.
void root.plugin(exportPlugin);
void root.plugin(consolePlugin);
// Beside the console: the other way of driving the engine by words rather than sliders.
void root.plugin(assistantPlugin);
// The left column. After the catalog, whose thumbnails the navigator draws, and after the
// panels, whose op descriptions the history rows are labelled and formatted with.
void root.plugin(developPlugin);

const target = document.getElementById("app");
if (!target) throw new Error("index.html is missing #app");
mount(Shell, { target, props: { kernel: root } });

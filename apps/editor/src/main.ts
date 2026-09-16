import "./app.css";
import { catalogPlugin } from "@latent/plugin-catalog";
import { consolePlugin } from "@latent/plugin-console";
import { panelsPlugin } from "@latent/plugin-panels";
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
void root.plugin(catalogPlugin);
void root.plugin(consolePlugin);

const target = document.getElementById("app");
if (!target) throw new Error("index.html is missing #app");
mount(Shell, { target, props: { kernel: root } });

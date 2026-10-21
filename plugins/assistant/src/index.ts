// The Assistant: select a region of the photo and tell an agent what to change there. The agent
// runs in the neo suite daemon (neo, or Claude Code and Codex as its guests), Latent registers
// there as an app, and the agent edits through the engine's MCP server, so its writes arrive as
// `stack.changed` with source `mcp` like any other writer's. This plugin holds the conversation
// and nothing else.
import type { Context, Plugin } from "@neoworks/extension-system";
import { ASSISTANT_MODE } from "./assistant";
import AssistantPane from "./AssistantPane.svelte";
import SelectionChat from "./SelectionChat.svelte";
import type { DaemonAddress } from "@neoworks-dev/neo-sdk";
import { AssistantState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    assistant: AssistantState;
  }
}

/** The daemon from the desktop bridge, or `?daemon=http://…&daemonToken=…` in a browser tab. */
async function daemonAddress(): Promise<DaemonAddress | null> {
  const fromBridge = await window.latentDesktop?.daemonAddress();
  if (fromBridge) return fromBridge;
  const query = new URLSearchParams(location.search);
  const url = query.get("daemon");
  const token = query.get("daemonToken");
  if (!url || !token) return null;
  return { url, token };
}

export const assistantPlugin: Plugin.Object<void> = {
  name: "assistant",
  // `panels` for the chat's change rows: their labels, and the flash a click sends there.
  inject: ["engine", "panes", "viewer", "panels"],
  apply(ctx: Context) {
    const state = new AssistantState(ctx.engine, ctx.viewer, localStorage);
    ctx.provide("assistant", state);
    // The daemon connection and any open session go with the plugin.
    ctx.effect(() => {
      void state.connect(daemonAddress);
      return () => state.dispose();
    }, "assistant-connection");

    ctx.effect(() =>
      ctx.panes.register({
        id: "assistant",
        title: "Assistant",
        region: "right",
        mode: ASSISTANT_MODE,
        order: 10,
        component: AssistantPane,
      }),
    );
    // Over the viewer rather than in the column: the chat sits next to what it is about.
    ctx.effect(() =>
      ctx.panes.register({
        id: "assistant-chat",
        title: "Assistant chat",
        region: "center",
        order: 50,
        component: SelectionChat,
      }),
    );
  },
};

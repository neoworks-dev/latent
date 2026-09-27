// The Assistant: select a region of the photo and tell an agent — Claude Code, Codex or pi,
// on the user's own subscription — what to change there. The agent runs in the harness
// sidecar (`@neoworks/harness`) that the desktop app starts next to latentd, and edits
// through the engine's MCP server, so its writes arrive as `stack.changed` with source
// `mcp` like any other writer's. This plugin holds the conversation and nothing else.
import type { Context, Plugin } from "@neoworks/extension-system";
import { ASSISTANT_MODE } from "./assistant";
import AssistantPane from "./AssistantPane.svelte";
import SelectionChat from "./SelectionChat.svelte";
import { AssistantState, type HarnessEndpoint } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    assistant: AssistantState;
  }
}

/** The sidecar from the desktop bridge, or `?harness=ws://…&harnessToken=…` in a browser tab. */
async function harnessEndpoint(): Promise<HarnessEndpoint | null> {
  const fromBridge = await window.latentDesktop?.harnessEndpoint();
  if (fromBridge) return fromBridge;
  const query = new URLSearchParams(location.search);
  const url = query.get("harness");
  const token = query.get("harnessToken");
  if (!url || !token) return null;
  return { url, token };
}

export const assistantPlugin: Plugin.Object<void> = {
  name: "assistant",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new AssistantState(ctx.engine, ctx.viewer, localStorage);
    ctx.provide("assistant", state);
    // The sidecar connection and any open session go with the plugin.
    ctx.effect(() => {
      void harnessEndpoint().then((endpoint) => state.connect(endpoint));
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

// The Python console: a bottom pane that ships code to the engine's embedded interpreter
// and prints what it answers. The UI holds no interpreter and no edit state — a script's
// effect on the stack arrives as `stack.changed` with source `python`, like any other writer.
import type { Context, Plugin } from "@neoworks/extension-system";
import Console from "./Console.svelte";
import { clearsConsole, togglesConsole } from "./console";
import { ConsoleState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    console: ConsoleState;
  }
}

export const consolePlugin: Plugin.Object<void> = {
  name: "console",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new ConsoleState(ctx.engine, ctx.viewer);
    ctx.provide("console", state);
    // The state subscribes to python.output, python.finished and stack.changed; unloading
    // the plugin drops all three listeners.
    ctx.effect(() => () => state.dispose());

    ctx.effect(() =>
      ctx.panes.register({
        id: "console",
        title: "Python",
        region: "bottom",
        order: 20,
        component: Console,
      }),
    );

    // Ctrl+` toggles the pane and Ctrl+L clears it, both while the textarea has focus.
    // One raw listener, with its inverse.
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (clearsConsole(event)) {
          event.preventDefault();
          state.clear();
          return;
        }
        if (!togglesConsole(event)) return;
        event.preventDefault();
        state.toggle();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, "console-shortcut");
  },
};

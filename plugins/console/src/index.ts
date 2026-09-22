// The Python console: a right-column tab that ships code to the engine's embedded
// interpreter and prints what it answers. The UI holds no interpreter and no edit state —
// a script's effect on the stack arrives as `stack.changed` with source `python`, like any
// other writer.
import type { Context, Plugin } from "@neoworks/extension-system";
import Console from "./Console.svelte";
import { clearsConsole, CONSOLE_MODE, togglesConsole } from "./console";
import ConsoleActions from "./ConsoleActions.svelte";
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
        // A rail tab of its own rather than a bar across the bottom: a scrollback and a
        // script box are worth a column, and the footer they used to sit in is the one
        // strip every other pane has to share.
        region: "right",
        mode: CONSOLE_MODE,
        order: 10,
        headerActions: ConsoleActions,
        component: Console,
      }),
    );

    // Ctrl+` switches the rail to the console and back to wherever it was, and Ctrl+L
    // clears it, both while the textarea has focus. One raw listener, with its inverse.
    ctx.effect(() => {
      let previousMode = ctx.panes.mode;
      const onKeyDown = (event: KeyboardEvent): void => {
        if (clearsConsole(event)) {
          event.preventDefault();
          state.clear();
          return;
        }
        if (!togglesConsole(event)) return;
        event.preventDefault();
        if (ctx.panes.mode === CONSOLE_MODE) {
          ctx.panes.setMode(previousMode);
          return;
        }
        previousMode = ctx.panes.mode;
        ctx.panes.setMode(CONSOLE_MODE);
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, "console-shortcut");
  },
};

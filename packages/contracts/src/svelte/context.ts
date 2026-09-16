import type { Context } from "@neoworks/extension-system";
import { getContext, setContext } from "svelte";

// Symbol.for keeps the key stable if the bundler instantiates this module twice.
const contextKey = Symbol.for("@latent/contracts:kernel-context");

/** Called once by the shell before any component that resolves services renders. */
export function provideKernelContext(context: Context): void {
  setContext(contextKey, context);
}

/** Kernel context for any component below the shell, app-owned or plugin-contributed. */
export function kernelContext(): Context {
  const context = getContext<Context | undefined>(contextKey);
  if (!context)
    throw new Error("no kernel context: the shell must call provideKernelContext() first");
  return context;
}

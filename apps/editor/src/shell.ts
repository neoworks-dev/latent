// Pure shell logic: which chrome a keystroke leaves on screen. The shell component holds
// the state and draws the regions; this decides. No DOM, no Svelte — unit-tested directly.
import type { PaneDefinition } from "@latent/contracts";

/**
 * How much of the window is chrome rather than photo. Lightroom's Tab hides the side
 * panes and keeps the tools; Shift+Tab takes everything off.
 */
export type ShellChrome = "all" | "sides" | "none";

export interface ShellKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
}

/** Tab and Shift+Tab only; a keystroke aimed at a text field is that field's. */
export function shellShortcut(event: ShellKeyEvent): { shift: boolean } | null {
  if (event.key !== "Tab") return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (target?.isContentEditable) return null;
  const tag = target?.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  return { shift: event.shiftKey };
}

/** Tab toggles the side panes, Shift+Tab toggles everything, both from wherever they are. */
export function nextChrome(current: ShellChrome, shift: boolean): ShellChrome {
  if (shift) return current === "none" ? "all" : "none";
  return current === "all" ? "sides" : "all";
}

/** `sides` is the left column and the bottom row; `none` keeps only the centre. */
export function showsRegion(chrome: ShellChrome, region: PaneDefinition["region"]): boolean {
  if (chrome === "all") return true;
  if (chrome === "none") return region === "center";
  return region === "center" || region === "right";
}

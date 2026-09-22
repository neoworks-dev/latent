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

/**
 * The floating cards' sizes, in CSS pixels. The grid's tracks and the viewer's safe area
 * are both built from these, so a column cannot be one width in the layout and another in
 * the rect the picture is fitted into.
 */
export const PANE_LAYOUT = {
  /** The gap between cards, and between a card and the edge of the window. */
  gutter: 8,
  left: 260,
  right: 320,
  /** The mode rail, right of the right column. */
  rail: 44,
  /** A rail pane's flyout, opened to the left of the rail — the Masks panel. */
  flyout: 300,
} as const;

export interface SafeArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the picture may sit while it is fitted: the window minus whatever floats over it.
 * Zoomed in the frame runs edge to edge and behind the cards — that is the point of them
 * floating — but a fitted photo belongs in the hole between them, not under a panel.
 * `bottomHeight` is the footer's measured height, since the filmstrip's is its content's.
 */
export function viewerSafeArea(
  chrome: ShellChrome,
  hasLeft: boolean,
  bottomHeight: number,
  hasFlyout = false,
): SafeArea {
  const { gutter, left, right, rail, flyout } = PANE_LAYOUT;
  const showsSide = (region: PaneDefinition["region"]): boolean => showsRegion(chrome, region);
  // The flyout hangs off the rail, so it is only on screen while the rail is.
  const flyoutWidth = hasFlyout && showsSide("right") ? flyout + gutter : 0;
  return {
    left: hasLeft && showsSide("left") ? gutter * 2 + left : gutter,
    // Nothing floats along the top edge: the viewer's readouts live in the footer.
    top: gutter,
    right: showsSide("right") ? gutter * 3 + right + rail + flyoutWidth : gutter,
    bottom: showsSide("bottom") && bottomHeight > 0 ? gutter * 2 + bottomHeight : gutter,
  };
}

/** `sides` is the left column and the bottom row; `none` keeps only the centre. */
export function showsRegion(chrome: ShellChrome, region: PaneDefinition["region"]): boolean {
  if (chrome === "all") return true;
  if (chrome === "none") return region === "center";
  return region === "center" || region === "right";
}

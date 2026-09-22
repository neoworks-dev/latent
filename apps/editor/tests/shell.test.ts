import { describe, expect, test } from "bun:test";
import {
  nextChrome,
  PANE_LAYOUT,
  shellShortcut,
  showsRegion,
  viewerSafeArea,
  type ShellKeyEvent,
} from "../src/shell";

function key(overrides: Partial<ShellKeyEvent> = {}): ShellKeyEvent {
  return {
    key: "Tab",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    ...overrides,
  };
}

describe("shell shortcuts", () => {
  test("Tab and Shift+Tab, nothing else", () => {
    expect(shellShortcut(key())).toEqual({ shift: false });
    expect(shellShortcut(key({ shiftKey: true }))).toEqual({ shift: true });
    expect(shellShortcut(key({ key: "f" }))).toBe(null);
    expect(shellShortcut(key({ ctrlKey: true }))).toBe(null);
  });

  test("Tab inside a text field is that field's", () => {
    expect(shellShortcut(key({ target: { tagName: "INPUT", isContentEditable: false } }))).toBe(
      null,
    );
    expect(shellShortcut(key({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(null);
    expect(shellShortcut(key({ target: { tagName: "BUTTON", isContentEditable: false } }))).toEqual(
      { shift: false },
    );
  });
});

describe("chrome", () => {
  test("Tab toggles the side panes, Shift+Tab toggles everything", () => {
    expect(nextChrome("all", false)).toBe("sides");
    expect(nextChrome("sides", false)).toBe("all");
    expect(nextChrome("all", true)).toBe("none");
    expect(nextChrome("none", true)).toBe("all");
    // Shift+Tab out of a half-hidden shell goes all the way off, not back to full.
    expect(nextChrome("sides", true)).toBe("none");
    // Tab out of a fully hidden shell brings the tools back.
    expect(nextChrome("none", false)).toBe("all");
  });

  test("the centre region is never hidden", () => {
    expect(showsRegion("all", "left")).toBe(true);
    expect(showsRegion("sides", "left")).toBe(false);
    expect(showsRegion("sides", "bottom")).toBe(false);
    expect(showsRegion("sides", "right")).toBe(true);
    expect(showsRegion("none", "right")).toBe(false);
    expect(showsRegion("none", "center")).toBe(true);
  });
});

describe("the viewer's safe area", () => {
  test("is the window minus the cards that float over it", () => {
    const { gutter, left, right, rail } = PANE_LAYOUT;
    expect(viewerSafeArea("all", true, 96)).toEqual({
      left: gutter * 2 + left,
      top: gutter,
      right: gutter * 3 + right + rail,
      bottom: gutter * 2 + 96,
    });
  });

  test("a hidden card leaves only the gutter behind", () => {
    const { gutter, right, rail } = PANE_LAYOUT;
    // Tab: the left column and the filmstrip go, the right one stays.
    expect(viewerSafeArea("sides", true, 96)).toEqual({
      left: gutter,
      top: gutter,
      right: gutter * 3 + right + rail,
      bottom: gutter,
    });
    // Shift+Tab: nothing floats, so the fitted photo has the whole window but the gutter.
    expect(viewerSafeArea("none", true, 96)).toEqual({
      left: gutter,
      top: gutter,
      right: gutter,
      bottom: gutter,
    });
    // No pane registered for the left region at all.
    expect(viewerSafeArea("all", false, 96).left).toBe(gutter);
    // A footer that has not been measured yet is not a gap to keep clear.
    expect(viewerSafeArea("all", true, 0).bottom).toBe(gutter);
  });

  test("an open rail flyout takes its own width off the right", () => {
    const { gutter, right, rail, flyout } = PANE_LAYOUT;
    expect(viewerSafeArea("all", true, 96, true).right).toBe(
      gutter * 3 + right + rail + flyout + gutter,
    );
    // The flyout hangs off the rail, so hiding the rail hides it too.
    expect(viewerSafeArea("none", true, 96, true).right).toBe(gutter);
  });
});

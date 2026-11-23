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

  test("the header stays with the tools and goes with Shift+Tab", () => {
    expect(showsRegion("all", "header")).toBe(true);
    expect(showsRegion("sides", "header")).toBe(true);
    expect(showsRegion("none", "header")).toBe(false);
  });
});

describe("the viewer's safe area", () => {
  test("is the whole viewer: the panels sit outside it", () => {
    const none = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(viewerSafeArea("all")).toEqual(none);
    expect(viewerSafeArea("sides")).toEqual(none);
    expect(viewerSafeArea("none")).toEqual(none);
  });

  test("an open rail flyout takes its own width and margins off the right", () => {
    const { gutter, flyout } = PANE_LAYOUT;
    expect(viewerSafeArea("all", true).right).toBe(flyout + gutter * 2);
    // The flyout is part of the rail's region, so hiding the rail hides it too.
    expect(viewerSafeArea("none", true).right).toBe(0);
  });
});

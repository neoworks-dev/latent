import { describe, expect, test } from "bun:test";
import { nextChrome, shellShortcut, showsRegion, type ShellKeyEvent } from "../src/shell";

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

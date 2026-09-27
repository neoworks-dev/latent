import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@neoworks/harness/client";
import {
  applyUpdate,
  asksFirst,
  boxFromDrag,
  buildPrompt,
  chatPosition,
  dockedPosition,
  latentToolName,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  type TranscriptItem,
} from "../src/assistant";

describe("selection", () => {
  test("a drag in any direction becomes an ordered box, clamped to the photo", () => {
    expect(boxFromDrag([0.8, 0.9], [0.2, -0.1])).toEqual([0.2, 0, 0.8, 0.9]);
  });

  test("a click is not a selection", () => {
    expect(boxFromDrag([0.5, 0.5], [0.505, 0.6])).toBeNull();
  });

  test("the prompt carries the photo and the box in image space", () => {
    expect(buildPrompt("  make it darker ", 7, [0.1, 0.2, 0.3, 0.4])).toBe(
      'make it darker\n\n<selection photo_id="7" box="[0.1000, 0.2000, 0.3000, 0.4000]" />',
    );
  });

  test("the whole photo has no box, and references are counted", () => {
    expect(buildPrompt("warmer", 7, "photo")).toBe(
      'warmer\n\n<selection photo_id="7" whole_photo="true" />',
    );
    expect(buildPrompt("match this look", 7, "photo", 2)).toBe(
      'match this look\n\n<selection photo_id="7" whole_photo="true" />\n\nAttached: 2 reference images.',
    );
  });
});

describe("approvals", () => {
  test("finds the Latent tool however the harness titles the call", () => {
    expect(latentToolName("mcp__latent__run_python")).toBe("run_python");
    expect(latentToolName("latent.export")).toBe("export");
    expect(latentToolName("export (latent)")).toBe("export");
    expect(latentToolName("Bash")).toBeNull();
  });

  test("writes of files and new photos ask; reads and undoable edits do not", () => {
    expect(asksFirst("mcp__latent__run_python")).toBe(false);
    expect(asksFirst("mcp__latent__render_preview")).toBe(false);
    expect(asksFirst("mcp__latent__merge_preview")).toBe(false);
    expect(asksFirst("mcp__latent__export")).toBe(true);
    expect(asksFirst("mcp__latent__merge_hdr")).toBe(true);
    expect(asksFirst("something else")).toBe(true);
  });
});

describe("settings", () => {
  test("round-trip through storage, with defaults for what is missing", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    expect(loadSettings(storage)).toEqual({ harness: "claude", model: "", effort: "" });
    saveSettings(storage, { harness: "pi", model: "openai-codex/gpt-6-luna", effort: "low" });
    expect(loadSettings(storage)).toEqual({
      harness: "pi",
      model: "openai-codex/gpt-6-luna",
      effort: "low",
    });
    values.set(SETTINGS_KEY, "{not json");
    expect(loadSettings(storage).harness).toBe("claude");
  });
});

describe("transcript", () => {
  const chunk = (text: string): SessionUpdate => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });

  test("text chunks join into one reply per turn", () => {
    let items: TranscriptItem[] = [{ kind: "user", text: "darker" }];
    items = applyUpdate(items, chunk("Done, "));
    items = applyUpdate(items, chunk("the dragon is darker."));
    expect(items).toEqual([
      { kind: "user", text: "darker" },
      { kind: "assistant", text: "Done, the dragon is darker." },
    ]);
  });

  test("tool calls show up and settle", () => {
    let items: TranscriptItem[] = [];
    items = applyUpdate(items, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "mcp__latent__run_python",
    });
    items = applyUpdate(items, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    expect(items).toEqual([
      { kind: "tool", id: "t1", title: "mcp__latent__run_python", status: "done" },
    ]);
  });
});

describe("chat position", () => {
  const viewer = { width: 1000, height: 800 };
  const chat = { width: 300, height: 200 };
  const noPanels = { left: 0, top: 0, right: 0, bottom: 0 };

  test("under the selection when it fits", () => {
    expect(
      chatPosition({ left: 100, top: 100, right: 300, bottom: 300 }, chat, viewer, noPanels),
    ).toEqual({ left: 100, top: 308 });
  });

  test("above it near the bottom edge", () => {
    expect(
      chatPosition({ left: 100, top: 500, right: 300, bottom: 700 }, chat, viewer, noPanels),
    ).toEqual({ left: 100, top: 292 });
  });

  test("clear of the floating panels", () => {
    const panels = { left: 0, top: 0, right: 320, bottom: 0 };
    expect(
      chatPosition({ left: 600, top: 100, right: 700, bottom: 200 }, chat, viewer, panels).left,
    ).toBe(372);
  });

  test("a whole-photo chat docks at the bottom, centred in the free area", () => {
    expect(dockedPosition(chat, viewer, noPanels)).toEqual({ left: 350, top: 592 });
    expect(dockedPosition(chat, viewer, { left: 0, top: 0, right: 320, bottom: 40 })).toEqual({
      left: 190,
      top: 552,
    });
  });
});

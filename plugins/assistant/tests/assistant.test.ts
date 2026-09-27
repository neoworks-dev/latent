import { describe, expect, test } from "bun:test";
import type { HistoryStep, OpDefinition } from "@latent/protocol";
import type { SessionUpdate } from "@neoworks/harness/client";
import {
  agentJobLabel,
  applyUpdate,
  asksFirst,
  boxFromDrag,
  buildPrompt,
  changeRows,
  chatPosition,
  chatWidth,
  dockedPosition,
  jobOutcome,
  jobsFinishedPrompt,
  latentToolName,
  loadConversation,
  loadPlacement,
  loadSettings,
  netChangeRows,
  placedPosition,
  PLACEMENT_KEY,
  saveConversation,
  saveSettings,
  SETTINGS_KEY,
  toolInput,
  toolLabel,
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

  test("a tool keeps what it was given and what it answered", () => {
    let items: TranscriptItem[] = [];
    items = applyUpdate(items, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "mcp__latent__render_preview",
      rawInput: { max_size: 512 },
    });
    items = applyUpdate(items, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "failed",
      content: [
        { type: "content", content: { type: "text", text: "no photo open" } },
        { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/jpeg" } },
      ],
    });
    expect(items).toEqual([
      {
        kind: "tool",
        id: "t1",
        title: "mcp__latent__render_preview",
        status: "failed",
        input: { max_size: 512 },
        output: "no photo open",
        image: "data:image/jpeg;base64,AAAA",
      },
    ]);
  });

  test("a tool is named in words, its script shown as itself", () => {
    expect(toolLabel("mcp__latent__run_python")).toBe("Ran a script");
    expect(
      toolLabel("mcp__latent__run_python", { code: "…", explanation: " Lift the shadows " }),
    ).toBe("Lift the shadows");
    expect(toolLabel("mcp__latent__render_preview", { region: [0, 0, 0.5, 0.5] })).toBe(
      "Zoomed in",
    );
    expect(toolLabel("Bash")).toBe("Bash");
    expect(toolInput({ code: "latent.photo.develop.exposure = 0.3" })).toBe(
      "latent.photo.develop.exposure = 0.3",
    );
    expect(toolInput({ max_size: 512 })).toBe('{\n  "max_size": 512\n}');
    expect(toolInput({})).toBeNull();
    expect(toolInput(undefined)).toBeNull();
  });
});

describe("changes", () => {
  const ops: OpDefinition[] = [
    {
      name: "highlights",
      label: "Highlights",
      panel: "light",
      params: [
        {
          name: "value",
          label: "Highlights",
          type: "number",
          min: -100,
          max: 100,
          step: 1,
          default: 0,
        },
      ],
    },
    {
      name: "white_balance",
      label: "White Balance",
      panel: "color",
      params: [
        { name: "temp", label: "Temp", type: "number", min: -100, max: 100, step: 1, default: 0 },
        { name: "tint", label: "Tint", type: "number", min: -150, max: 150, step: 1, default: 0 },
      ],
    },
  ];

  test("one row per parameter that moved, from the default when the op did not hold it", () => {
    const steps: HistoryStep[] = [
      {
        index: 3,
        kind: "batch",
        entries: [
          { kind: "update", op: "highlights", opId: "op1", changes: [{ param: "value", to: -80 }] },
          {
            kind: "update",
            op: "white_balance",
            opId: "op2",
            changes: [{ param: "tint", from: 0, to: 12 }],
          },
        ],
      },
      { index: 4, kind: "add", op: "group", opId: "op3" },
      { index: 5, kind: "reorder" },
    ];
    expect(changeRows(steps, ops)).toEqual([
      { opId: "op1", op: "highlights", param: "value", title: "Highlights", detail: "0 → −80" },
      { opId: "op2", op: "white_balance", param: "tint", title: "Tint", detail: "0 → +12" },
      { opId: "op3", op: "group", param: null, title: "Layer", detail: "added" },
    ]);
  });
});

describe("jobs", () => {
  test("only detection, generative runs and depth are the agent's to wait on", () => {
    expect(agentJobLabel("mask")).toBe("mask detection");
    expect(agentJobLabel("export")).toBeNull();
  });

  test("the wake-up says how each job went", () => {
    const base = { jobId: 1, done: 1, total: 1, finished: true } as const;
    const outcomes = [
      jobOutcome({ ...base, kind: "mask", state: "done" }),
      jobOutcome({ ...base, kind: "generative", state: "error", error: "ComfyUI is down" }),
    ];
    expect(outcomes).toEqual(["mask detection finished", "generative run failed: ComfyUI is down"]);
    expect(jobsFinishedPrompt(outcomes)).toBe(
      "<jobs_finished>\n- mask detection finished\n- generative run failed: ComfyUI is down\n</jobs_finished>\n\nContinue.",
    );
  });
});

describe("turn summary", () => {
  const ops: OpDefinition[] = [
    {
      name: "highlights",
      label: "Highlights",
      panel: "light",
      params: [
        {
          name: "value",
          label: "Highlights",
          type: "number",
          min: -100,
          max: 100,
          step: 1,
          default: 0,
        },
      ],
    },
    {
      name: "shadows",
      label: "Shadows",
      panel: "light",
      params: [
        {
          name: "value",
          label: "Shadows",
          type: "number",
          min: -100,
          max: 100,
          step: 1,
          default: 0,
        },
      ],
    },
  ];

  test("each parameter once, from where the turn found it to where it left it", () => {
    const steps: HistoryStep[] = [
      {
        index: 4,
        kind: "update",
        op: "highlights",
        opId: "h",
        changes: [{ param: "value", to: -40 }],
      },
      {
        index: 5,
        kind: "update",
        op: "shadows",
        opId: "s",
        changes: [{ param: "value", from: 10, to: 30 }],
      },
      {
        index: 6,
        kind: "update",
        op: "highlights",
        opId: "h",
        changes: [{ param: "value", from: -40, to: -80 }],
      },
      {
        index: 7,
        kind: "update",
        op: "shadows",
        opId: "s",
        changes: [{ param: "value", from: 30, to: 10 }],
      },
      { index: 8, kind: "add", op: "group", opId: "g" },
    ];
    expect(netChangeRows(steps, ops)).toEqual([
      { opId: "h", op: "highlights", param: "value", title: "Highlights", detail: "0 → −80" },
      { opId: "g", op: "group", param: null, title: "Layer", detail: "added" },
    ]);
  });
});

describe("placement", () => {
  const viewer = { width: 1200, height: 800 };
  const noPanels = { left: 0, top: 0, right: 0, bottom: 0 };

  test("the chat's width follows the free area, within readable bounds", () => {
    expect(chatWidth(viewer, noPanels)).toBe(540);
    expect(chatWidth({ width: 3000 }, noPanels)).toBe(640);
    expect(chatWidth({ width: 900 }, { left: 0, top: 0, right: 320, bottom: 0 })).toBe(380);
  });

  test("a dropped chat stays put, pulled back inside when it grows or the window shrinks", () => {
    const chat = { width: 400, height: 300 };
    expect(placedPosition({ left: 100, top: 100 }, chat, viewer, noPanels)).toEqual({
      left: 100,
      top: 100,
    });
    expect(placedPosition({ left: 1000, top: 700 }, chat, viewer, noPanels)).toEqual({
      left: 800,
      top: 500,
    });
    // The safe area already ends in the shell's gutter: nothing is added on top of it.
    const gutter = { left: 12, top: 12, right: 12, bottom: 12 };
    expect(placedPosition({ left: -50, top: -50 }, chat, viewer, gutter)).toEqual({
      left: 12,
      top: 12,
    });
  });

  test("a stored placement survives a reload; junk is ignored", () => {
    const values = new Map<string, string>([[PLACEMENT_KEY, '{"left":10,"top":20}']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null };
    expect(loadPlacement(storage)).toEqual({ left: 10, top: 20 });
    values.set(PLACEMENT_KEY, "null");
    expect(loadPlacement(storage)).toBeNull();
    values.set(PLACEMENT_KEY, '{"left":"x"}');
    expect(loadPlacement(storage)).toBeNull();
  });
});

describe("conversations", () => {
  const memory = (): Pick<Storage, "getItem" | "setItem"> => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  };

  test("one per photo, without the pictures, forgotten on /clear", () => {
    const storage = memory();
    saveConversation(storage, 12, {
      sessionId: "s1",
      harness: "claude",
      costUsd: 0.1,
      items: [
        { kind: "user", text: "warmer", images: ["data:image/png;base64,AA"] },
        { kind: "tool", id: "t1", title: "render_preview", status: "done", image: "data:x" },
      ],
    });
    saveConversation(storage, 3, { sessionId: "s2", harness: "pi", costUsd: null, items: [] });
    expect(loadConversation(storage, 12)).toEqual({
      sessionId: "s1",
      harness: "claude",
      costUsd: 0.1,
      items: [
        { kind: "user", text: "warmer" },
        { kind: "tool", id: "t1", title: "render_preview", status: "done" },
      ],
    });
    saveConversation(storage, 12, null);
    expect(loadConversation(storage, 12)).toBeNull();
    expect(loadConversation(storage, 3)?.sessionId).toBe("s2");
  });

  test("only the most recent photos are kept", () => {
    const storage = memory();
    for (let photoId = 1; photoId <= 25; photoId++) {
      saveConversation(storage, photoId, {
        sessionId: `s${photoId}`,
        harness: "claude",
        costUsd: null,
        items: [],
      });
    }
    expect(loadConversation(storage, 5)).toBeNull();
    expect(loadConversation(storage, 6)?.sessionId).toBe("s6");
    expect(loadConversation(storage, 25)?.sessionId).toBe("s25");
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
    ).toBe(380);
  });

  test("a whole-photo chat docks at the bottom, centred in the free area", () => {
    expect(dockedPosition(chat, viewer, noPanels)).toEqual({ left: 350, top: 600 });
    expect(dockedPosition(chat, viewer, { left: 0, top: 0, right: 320, bottom: 40 })).toEqual({
      left: 190,
      top: 560,
    });
  });
});

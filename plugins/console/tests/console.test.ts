import { describe, expect, test } from "bun:test";
import type { PythonRunResult } from "@latent/protocol";
import {
  caretPosition,
  clampConsoleHeight,
  clearsConsole,
  clientLabel,
  failureLines,
  finishedLine,
  formatDuration,
  groupRuns,
  helpExamples,
  outputLine,
  pushHistory,
  recallDirection,
  recallHistory,
  resultLines,
  runsScript,
  togglesConsole,
  type ConsoleKeyEvent,
} from "../src/console";

function key(key: string, overrides: Partial<ConsoleKeyEvent> = {}): ConsoleKeyEvent {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides };
}

describe("console shortcuts", () => {
  test("Ctrl+` toggles, with or without shift, Ctrl+Enter runs", () => {
    expect(togglesConsole(key("`", { ctrlKey: true }))).toBe(true);
    expect(togglesConsole(key("~", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(togglesConsole(key("`"))).toBe(false);
    expect(togglesConsole(key("Enter", { ctrlKey: true }))).toBe(false);
    expect(runsScript(key("Enter", { ctrlKey: true }))).toBe(true);
    expect(runsScript(key("Enter"))).toBe(false);
  });
});

describe("scrollback", () => {
  function result(overrides: Partial<PythonRunResult>): PythonRunResult {
    return { ok: true, stdout: "", stderr: "", ...overrides };
  }

  test("a run prints the code, then stdout, then the value", () => {
    const lines = resultLines("latent.photo.develop.exposure = 1.0\n", {
      ok: true,
      stdout: "exposure = 1.00\n",
      stderr: "",
      value: "1.0",
    });
    expect(lines).toEqual([
      { kind: "code", text: "latent.photo.develop.exposure = 1.0" },
      { kind: "stdout", text: "exposure = 1.00" },
      { kind: "value", text: "1.0" },
    ]);
  });

  test("empty streams and a None value add nothing", () => {
    expect(resultLines("latent.undo()", result({ value: "None" }))).toEqual([
      { kind: "code", text: "latent.undo()" },
    ]);
    expect(resultLines("x", result({ stdout: "   " }))).toHaveLength(1);
  });

  test("a traceback is its own line, so it can be toned red", () => {
    const lines = resultLines("boom", result({ ok: false, stderr: "NameError: boom\n" }));
    expect(lines[1]).toEqual({ kind: "stderr", text: "NameError: boom" });
  });

  test("a streamed chunk is a line of its own stream's kind", () => {
    expect(outputLine({ runId: 1, stream: "stdout", text: "step 1\n" })).toEqual({
      kind: "stdout",
      text: "step 1",
    });
    expect(outputLine({ runId: 1, stream: "stderr", text: "warning\n" })).toEqual({
      kind: "stderr",
      text: "warning",
    });
    // Leading whitespace is the script's; only the trailing newline goes.
    expect(outputLine({ runId: 2, stream: "stdout", text: "  indented" }).text).toBe("  indented");
  });

  test("the streamed chunk and the result's stdout are the same text, never both shown", () => {
    const result: PythonRunResult = { ok: true, stdout: "step 1\n", stderr: "", runId: 1 };
    const streamed = outputLine({ runId: 1, stream: "stdout", text: result.stdout });
    expect(resultLines("x", result)).toContainEqual(streamed);
  });

  test("a call that never reached the engine is scrollback too", () => {
    expect(failureLines("x", new Error("engine not connected"))).toEqual([
      { kind: "code", text: "x" },
      { kind: "stderr", text: "engine not connected" },
    ]);
  });

  test("the help line lists the scripting API from the brief", () => {
    expect(helpExamples).toContain("latent.photo.develop.exposure = 0.7");
    expect(helpExamples).toContain("latent.undo()");
  });

  test("the scrollback groups into one block per run", () => {
    const runs = groupRuns([
      { kind: "code", text: "print(1)" },
      { kind: "stdout", text: "1" },
      { kind: "value", text: "None" },
      { kind: "code", text: "boom" },
      { kind: "stderr", text: "NameError" },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({
      code: "print(1)",
      output: [
        { kind: "stdout", text: "1" },
        { kind: "value", text: "None" },
      ],
    });
    expect(runs[1]?.output).toEqual([{ kind: "stderr", text: "NameError" }]);
    expect(groupRuns([])).toEqual([]);
  });

  test("output with no run before it is still a block", () => {
    expect(groupRuns([{ kind: "stdout", text: "orphan" }])).toEqual([
      { code: "", output: [{ kind: "stdout", text: "orphan" }] },
    ]);
  });
});

describe("python.finished", () => {
  test("a duration reads at the precision it deserves", () => {
    expect(formatDuration(0.42)).toBe("0.4 ms");
    expect(formatDuration(9.94)).toBe("9.9 ms");
    expect(formatDuration(17.1)).toBe("17 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(Number.NaN)).toBe("0.0 ms");
    expect(formatDuration(-1)).toBe("0.0 ms");
  });

  test("the notification closes the run with a dim line of its own kind", () => {
    expect(finishedLine({ durationMs: 0.4, ok: true })).toEqual({
      kind: "note",
      text: "done in 0.4 ms",
    });
    expect(finishedLine({ durationMs: 30_000, ok: false })).toEqual({
      kind: "note",
      text: "failed in 30.00 s",
    });
  });

  test("the timing line is a note, so it never groups as script output", () => {
    const runs = groupRuns([
      { kind: "code", text: "latent.undo()" },
      finishedLine({ durationMs: 2, ok: true }),
    ]);
    expect(runs[0]).toEqual({
      code: "latent.undo()",
      output: [{ kind: "note", text: "done in 2.0 ms" }],
    });
  });
});

describe("stack.changed client", () => {
  test("another writer is named, this client's own write is not", () => {
    expect(clientLabel("mcp:run_python")).toBe("stack changed by mcp:run_python");
    expect(clientLabel("python")).toBe("stack changed by python");
    expect(clientLabel("history")).toBe("stack changed by history");
    expect(clientLabel("ui")).toBe(null);
    // An engine that predates `client` says nothing rather than "stack changed by".
    expect(clientLabel(undefined)).toBe(null);
    expect(clientLabel("")).toBe(null);
  });
});

describe("history", () => {
  test("Ctrl+L clears, unmodified L does not", () => {
    expect(clearsConsole(key("l", { ctrlKey: true }))).toBe(true);
    expect(clearsConsole(key("L", { metaKey: true }))).toBe(true);
    expect(clearsConsole(key("l"))).toBe(false);
  });

  test("arrows recall only from the edges of the box", () => {
    const edges = { inFirstLine: true, inLastLine: true };
    expect(recallDirection(key("ArrowUp"), edges)).toBe(-1);
    expect(recallDirection(key("ArrowDown"), edges)).toBe(1);
    expect(recallDirection(key("ArrowUp"), { inFirstLine: false, inLastLine: true })).toBe(null);
    expect(recallDirection(key("ArrowDown"), { inFirstLine: true, inLastLine: false })).toBe(null);
    expect(recallDirection(key("ArrowUp", { ctrlKey: true }), edges)).toBe(null);
  });

  test("the caret is on the first line until a newline is behind it", () => {
    expect(caretPosition("latent.undo()", 13, 13)).toEqual({
      inFirstLine: true,
      inLastLine: true,
    });
    // Caret on line two of three: both arrows move the caret, neither recalls.
    expect(caretPosition("a\nb\nc", 3, 3)).toEqual({ inFirstLine: false, inLastLine: false });
    expect(caretPosition("a\nb", 0, 0)).toEqual({ inFirstLine: true, inLastLine: false });
    expect(caretPosition("a\nb", 3, 3)).toEqual({ inFirstLine: false, inLastLine: true });
  });

  test("a repeated input is remembered once, blanks never", () => {
    let history = pushHistory([], "latent.undo()");
    history = pushHistory(history, "latent.undo()\n");
    history = pushHistory(history, "   ");
    history = pushHistory(history, "latent.redo()");
    expect(history).toEqual(["latent.undo()", "latent.redo()"]);
  });

  test("up walks back, down walks forward and past the newest entry is an empty box", () => {
    const history = ["a", "b"];
    expect(recallHistory(history, 2, -1)).toEqual({ index: 1, code: "b" });
    expect(recallHistory(history, 1, -1)).toEqual({ index: 0, code: "a" });
    expect(recallHistory(history, 0, -1)).toEqual({ index: 0, code: "a" });
    expect(recallHistory(history, 0, 1)).toEqual({ index: 1, code: "b" });
    expect(recallHistory(history, 1, 1)).toEqual({ index: 2, code: "" });
    expect(recallHistory(history, 2, 1)).toEqual({ index: 2, code: "" });
    expect(recallHistory([], 0, -1)).toEqual({ index: 0, code: "" });
  });

  test("the pane height stays between readable and the window", () => {
    expect(clampConsoleHeight(220)).toBe(220);
    expect(clampConsoleHeight(20)).toBe(120);
    expect(clampConsoleHeight(2000)).toBe(560);
    expect(clampConsoleHeight(Number.NaN)).toBe(220);
  });
});

// Pure console logic: key mapping and turning one `python.run` result — or one streamed
// chunk of it — into scrollback lines. No engine calls, no DOM.
import type { PythonOutputParams, PythonRunResult } from "@latent/protocol";

/** `note` is the console's own voice — timings, other writers — never the script's output. */
export type ConsoleLineKind = "code" | "stdout" | "stderr" | "value" | "note";

export interface ConsoleLine {
  kind: ConsoleLineKind;
  text: string;
}

export interface ConsoleKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Ctrl+` toggles the console — the one shortcut that must also work while the textarea has
 * focus, so it deliberately has no typing guard.
 */
export function togglesConsole(event: ConsoleKeyEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  // Layouts report the backtick key as "`" or, with Shift, as "~".
  return event.key === "`" || event.key === "~";
}

/** Ctrl+Enter runs; plain Enter is a newline, because scripts are more than one line. */
export function runsScript(event: ConsoleKeyEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key === "Enter";
}

/** Ctrl+L clears the scrollback, the way every terminal does. */
export function clearsConsole(event: ConsoleKeyEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === "l";
}

/** Which line of the input the caret is on; a multi-line script still needs its arrows. */
export interface CaretPosition {
  inFirstLine: boolean;
  inLastLine: boolean;
}

/**
 * Arrow keys recall past inputs only from the edges of the box: Up walks back from the
 * first line, Down walks forward from the last one. In between the arrow moves the caret,
 * which is what a three-line script needs — the same rule a shell uses.
 */
export function recallDirection(event: ConsoleKeyEvent, caret: CaretPosition): -1 | 1 | null {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowUp" && caret.inFirstLine) return -1;
  if (event.key === "ArrowDown" && caret.inLastLine) return 1;
  return null;
}

/** Where the caret sits, as the two facts the recall rule needs. */
export function caretPosition(value: string, start: number, end: number): CaretPosition {
  return {
    inFirstLine: !value.slice(0, start).includes("\n"),
    inLastLine: !value.slice(end).includes("\n"),
  };
}

/** How many inputs the console remembers; older ones fall off the front. */
const historyLimit = 100;

/** A run that repeats the previous input adds nothing — one entry is the whole recall. */
export function pushHistory(history: string[], code: string): string[] {
  const entry = code.trim();
  if (!entry || history.at(-1) === entry) return history;
  return [...history, entry].slice(-historyLimit);
}

export interface Recalled {
  /** `history.length` means "past the newest entry": the box is back to a fresh line. */
  index: number;
  code: string;
}

/**
 * One step through the recall ring. Walking past the newest entry lands on an empty box
 * rather than wrapping — wrapping makes it impossible to tell where the ring ends.
 */
export function recallHistory(history: string[], index: number, direction: -1 | 1): Recalled {
  const end = history.length;
  if (end === 0) return { index: 0, code: "" };
  const next = Math.min(end, Math.max(0, Math.min(index, end) + direction));
  return { index: next, code: history[next] ?? "" };
}

export interface ConsoleRun {
  /** The input that started this block; the scrollback shows it as the `>>>` line. */
  code: string;
  /** Everything the engine printed for it, in order. */
  output: ConsoleLine[];
}

/**
 * The scrollback grouped into runs, so each one can be drawn as a block with a bar down
 * its left edge. Lines before the first `code` line (nothing does that today) become a
 * run with no input rather than being dropped.
 */
export function groupRuns(lines: ConsoleLine[]): ConsoleRun[] {
  const runs: ConsoleRun[] = [];
  for (const line of lines) {
    if (line.kind === "code") {
      runs.push({ code: line.text, output: [] });
      continue;
    }
    if (runs.length === 0) runs.push({ code: "", output: [] });
    runs.at(-1)?.output.push(line);
  }
  return runs;
}

/** The console pane's drag range: tall enough to read, never taller than the window. */
export function clampConsoleHeight(height: number): number {
  if (!Number.isFinite(height)) return 220;
  return Math.min(560, Math.max(120, Math.round(height)));
}

/**
 * What one run adds to the scrollback: the code, then whatever the engine printed, then
 * the value of the last expression. Empty streams add nothing.
 */
export function resultLines(code: string, result: PythonRunResult): ConsoleLine[] {
  const lines: ConsoleLine[] = [{ kind: "code", text: code.trim() }];
  if (result.stdout.trim()) lines.push({ kind: "stdout", text: result.stdout.trimEnd() });
  if (result.stderr.trim()) lines.push({ kind: "stderr", text: result.stderr.trimEnd() });
  if (result.value !== undefined && result.value !== "None") {
    lines.push({ kind: "value", text: result.value });
  }
  return lines;
}

/**
 * One `python.output` chunk, shown while the run is still open. The run's result repeats
 * the complete streams, so these lines are provisional: the console drops them and prints
 * `resultLines` once the call returns, and the same text is never shown twice.
 */
export function outputLine(params: PythonOutputParams): ConsoleLine {
  return { kind: params.stream, text: params.text.trimEnd() };
}

/**
 * A run's wall clock, at the precision a reader can use: tenths under 10 ms, whole
 * milliseconds under a second, seconds above it.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0.0 ms";
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)} s`;
  if (durationMs >= 10) return `${Math.round(durationMs)} ms`;
  return `${durationMs.toFixed(1)} ms`;
}

/**
 * The line `python.finished` prints: the run is over and this is what it cost. `ok` is the
 * notification's — the traceback itself arrives with the result, as `stderr`.
 */
export function finishedLine(finished: { durationMs: number; ok: boolean }): ConsoleLine {
  const verb = finished.ok ? "done" : "failed";
  return { kind: "note", text: `${verb} in ${formatDuration(finished.durationMs)}` };
}

/**
 * What the console says about a `stack.changed` it did not cause. `ui` is this socket's own
 * write and an absent `client` is an engine too old to say, so both stay silent; everything
 * else is printed verbatim, `mcp:<tool>` included — the suffix is open-ended, so the label
 * is text and never a branch.
 */
export function clientLabel(client: string | undefined): string | null {
  if (!client || client === "ui") return null;
  return `stack changed by ${client}`;
}

/** A call that never reached the engine still belongs in the scrollback, as an error. */
export function failureLines(code: string, error: unknown): ConsoleLine[] {
  const message = error instanceof Error ? error.message : String(error);
  return [
    { kind: "code", text: code.trim() },
    { kind: "stderr", text: message },
  ];
}

/** The examples the console advertises, straight out of PROMPT.md §3.4. */
export const helpExamples = [
  "latent.photo.develop.exposure = 0.7",
  'latent.photo.stack.add("clarity", amount=20)',
  "latent.undo()",
  "latent.render.preview()",
];

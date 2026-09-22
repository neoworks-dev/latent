import type { EngineClient, ViewerService } from "@latent/contracts";
import type { PythonRunResult, StackChangedParams } from "@latent/protocol";
import {
  clampConsoleHeight,
  clientLabel,
  failureLines,
  finishedLine,
  outputLine,
  pushHistory,
  recallHistory,
  resultLines,
  type ConsoleLine,
} from "./console";

/**
 * The Python console's scrollback and history. The code is the engine's
 * to run (embedded CPython, PROMPT.md §3.4) — this only ships it and prints what comes
 * back. Nothing it shows is derived locally.
 */
export class ConsoleState {
  /** A call is in flight; a second run would fight it for the streamed output. */
  busy = $state(false);
  /**
   * The spinner. `python.finished` arrives before the RPC result, so the run stops looking
   * busy as soon as the engine says it ended rather than when the reply lands.
   */
  running = $state(false);
  lines = $state<ConsoleLine[]>([]);
  /**
   * What the engine streamed for the run that is still open. Shown under `lines` while it
   * runs, then cleared: the result repeats the same streams and is the canonical record.
   */
  streamed = $state<ConsoleLine[]>([]);
  /** `python.finished`'s timing line for the open run, kept until the result prints it. */
  finishedNote = $state<ConsoleLine | null>(null);
  /** Chunks this console has received, ever. Diagnostics only — it never resets. */
  streamedCount = $state(0);
  /** Past inputs, oldest first; the arrow keys walk them. */
  history = $state<string[]>([]);
  /** Where the recall sits; `history.length` is the fresh line below the newest entry. */
  historyIndex = $state(0);
  /** Scrollback height in pixels, dragged by the handle under it. */
  height = $state(220);

  /** `photoId:revision` of the last stack change printed; the same one never prints twice. */
  private lastStackChange = "";
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
  ) {
    this.unsubscribes.push(
      engine.on("python.output", (params) => {
        // The console runs one script at a time, so output that arrives while it is busy
        // belongs to its own run; another socket's run is not this console's to print.
        if (!this.busy) return;
        this.streamedCount += 1;
        this.streamed = [...this.streamed, outputLine(params)];
      }),
      engine.on("python.finished", (params) => {
        if (!this.busy) return;
        this.running = false;
        this.finishedNote = finishedLine(params);
      }),
      engine.on("stack.changed", (params) => this.logStackChange(params)),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  setHeight(height: number): void {
    this.height = clampConsoleHeight(height);
  }

  /** One step through past inputs; the caller puts the answer back in its box. */
  recall(direction: -1 | 1): string {
    const recalled = recallHistory(this.history, this.historyIndex, direction);
    this.historyIndex = recalled.index;
    return recalled.code;
  }

  async run(code: string): Promise<void> {
    if (!code.trim() || this.busy) return;
    this.busy = true;
    this.running = true;
    this.streamed = [];
    this.finishedNote = null;
    this.history = pushHistory(this.history, code);
    this.historyIndex = this.history.length;
    const photoId = this.viewer.photoId;
    const params = photoId === null ? { code } : { code, photoId };
    try {
      const result = await this.engine.call("python.run", params);
      this.lines = [...this.lines, ...resultLines(code, result), ...this.timingLines(result)];
    } catch (error) {
      this.lines = [...this.lines, ...failureLines(code, error)];
    } finally {
      this.streamed = [];
      this.finishedNote = null;
      this.running = false;
      this.busy = false;
    }
  }

  clear(): void {
    this.lines = [];
    this.streamed = [];
  }

  /**
   * The run's timing line, kept when the streamed block goes: `python.finished`'s if it
   * arrived, the result's own `durationMs` otherwise. An engine that reports neither gets
   * no line rather than an invented one.
   */
  private timingLines(result: PythonRunResult): ConsoleLine[] {
    if (this.finishedNote) return [this.finishedNote];
    if (result.durationMs === undefined) return [];
    return [finishedLine({ durationMs: result.durationMs, ok: result.ok })];
  }

  /**
   * Somebody else moved the stack — a script, an agent, another window. The console is the
   * one pane that says so; `ui` is this socket's own write and stays quiet. A revision is
   * one state, so the same one never prints twice however many notifications carry it.
   */
  private logStackChange(params: StackChangedParams): void {
    const label = clientLabel(params.client);
    if (label === null) return;
    const change = `${params.photoId}:${params.revision}`;
    if (change === this.lastStackChange) return;
    this.lastStackChange = change;
    this.lines = [...this.lines, { kind: "note", text: label }];
  }
}

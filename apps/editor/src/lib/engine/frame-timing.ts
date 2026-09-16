// Per-frame stage timings for the preview path. Pure arithmetic over `performance.now()`
// marks taken by the engine client, the painter and the presentation callback, so it is
// testable without a socket or a GL context.

/** One preview frame's marks, in the order the stages happen. */
export interface FrameMarks {
  /** `view.render` left the socket. */
  sent: number;
  /** The WebSocket message event fired. */
  received: number;
  /** The 32-byte header had been read. */
  parsed: number;
  /** The painter got the frame. */
  drawStarted: number;
  /** `texSubImage2D` returned. */
  uploaded: number;
  /** The draw call was issued. */
  drawn: number;
  /** The first animation frame after the draw ran — the presentation proxy. */
  presented: number;
  /** What the engine reported for this render: `renderMs + readbackMs`. */
  engine: number;
}

export const FRAME_STAGES = [
  "engine",
  "wire",
  "parse",
  "dispatch",
  "upload",
  "draw",
  "toDraw",
  "present",
  "total",
] as const;

export type FrameStage = (typeof FRAME_STAGES)[number];

/**
 * Milliseconds each stage cost. `engine` is the engine's own share of `wire`. `toDraw` is
 * the cumulative request → pixels-on-the-GPU time, which is what PROMPT.md §8.1 measured;
 * `present` on top of it is the wait for the next vsync and is display-bound, not ours.
 */
export function frameDurations(marks: FrameMarks): Record<FrameStage, number> {
  return {
    engine: marks.engine,
    wire: marks.received - marks.sent,
    parse: marks.parsed - marks.received,
    dispatch: marks.drawStarted - marks.parsed,
    upload: marks.uploaded - marks.drawStarted,
    draw: marks.drawn - marks.uploaded,
    toDraw: marks.drawn - marks.sent,
    present: marks.presented - marks.drawn,
    total: marks.presented - marks.sent,
  };
}

/** Nearest-rank percentile over an unsorted sample. Empty sample is 0. */
export function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export interface StageSummary {
  stage: FrameStage;
  p50: number;
  p95: number;
}

/** Rolling window of the last `capacity` frames. */
export class FrameTimingLog {
  private readonly frames: Record<FrameStage, number>[] = [];

  constructor(private readonly capacity = 120) {}

  get count(): number {
    return this.frames.length;
  }

  record(marks: FrameMarks): void {
    this.frames.push(frameDurations(marks));
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  clear(): void {
    this.frames.length = 0;
  }

  summary(): StageSummary[] {
    return FRAME_STAGES.map((stage) => {
      const samples = this.frames.map((frame) => frame[stage]);
      return { stage, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
    });
  }

  /** One console line per report: `[frame] n=100 engine 1.9/2.4 wire 3.1/4.0 …` (p50/p95). */
  format(): string {
    const stages = this.summary()
      .map((entry) => `${entry.stage} ${entry.p50.toFixed(1)}/${entry.p95.toFixed(1)}`)
      .join(" ");
    return `[frame] n=${this.frames.length} ${stages}`;
  }
}

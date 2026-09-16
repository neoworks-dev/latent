import { describe, expect, test } from "bun:test";
import {
  FrameTimingLog,
  frameDurations,
  percentile,
  type FrameMarks,
} from "../src/lib/engine/frame-timing";

/** Marks for a frame whose stages each cost exactly `step` milliseconds. */
function marks(step: number, engine = 1): FrameMarks {
  return {
    sent: 100,
    received: 100 + step,
    parsed: 100 + step * 2,
    drawStarted: 100 + step * 3,
    uploaded: 100 + step * 4,
    drawn: 100 + step * 5,
    presented: 100 + step * 6,
    engine,
  };
}

describe("frameDurations", () => {
  test("splits the marks into one duration per stage", () => {
    expect(frameDurations(marks(2, 0.7))).toEqual({
      engine: 0.7,
      wire: 2,
      parse: 2,
      dispatch: 2,
      upload: 2,
      draw: 2,
      toDraw: 10,
      present: 2,
      total: 12,
    });
  });

  test("toDraw excludes the vsync wait that total includes", () => {
    const durations = frameDurations(marks(3));
    expect(durations.total - durations.toDraw).toBe(durations.present);
  });

  test("engine time is reported as given, not derived from the marks", () => {
    expect(frameDurations(marks(2, 4.25)).engine).toBe(4.25);
  });
});

describe("percentile", () => {
  test("nearest rank picks a real sample, never an interpolation", () => {
    const samples = [5, 1, 4, 2, 3];
    expect(percentile(samples, 0.5)).toBe(3);
    expect(percentile(samples, 0.95)).toBe(5);
    expect(percentile(samples, 0)).toBe(1);
  });

  test("an empty sample is zero rather than NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  test("the input is left in its original order", () => {
    const samples = [3, 1, 2];
    percentile(samples, 0.5);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe("FrameTimingLog", () => {
  test("keeps only the last `capacity` frames", () => {
    const log = new FrameTimingLog(3);
    for (const step of [1, 2, 3, 4, 5]) log.record(marks(step));
    expect(log.count).toBe(3);
    // Only steps 3, 4 and 5 survive, so the median `wire` is 4.
    expect(log.summary().find((entry) => entry.stage === "wire")?.p50).toBe(4);
  });

  test("summarises every stage as p50 and p95", () => {
    const log = new FrameTimingLog();
    for (let step = 1; step <= 20; step++) log.record(marks(step));
    const total = log.summary().find((entry) => entry.stage === "total");
    expect(total).toEqual({ stage: "total", p50: 60, p95: 114 });
  });

  test("formats one line with the frame count and every stage", () => {
    const log = new FrameTimingLog();
    log.record(marks(2, 0.7));
    expect(log.format()).toBe(
      "[frame] n=1 engine 0.7/0.7 wire 2.0/2.0 parse 2.0/2.0 dispatch 2.0/2.0 " +
        "upload 2.0/2.0 draw 2.0/2.0 toDraw 10.0/10.0 present 2.0/2.0 total 12.0/12.0",
    );
  });

  test("clear empties the window", () => {
    const log = new FrameTimingLog();
    log.record(marks(1));
    log.clear();
    expect(log.count).toBe(0);
    expect(log.summary().every((entry) => entry.p50 === 0)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import {
  pointerLockDisabled,
  ScrubDrag,
  SCRUB_THRESHOLD_PX,
  wrapAround,
  type LockOwner,
  type LockTarget,
} from "../src/scrub";

interface LockSpy {
  calls: { requested: number; exited: number };
  target: LockTarget;
  lockOwner: LockOwner;
}

/** A `document` that records whether the drag took and released the lock. */
function owner(): LockSpy {
  const calls = { requested: 0, exited: 0 };
  const target = {
    requestPointerLock(): void {
      calls.requested += 1;
    },
  };
  const lockOwner = {
    exitPointerLock(): void {
      calls.exited += 1;
    },
    get pointerLockElement(): Element | null {
      return calls.requested > calls.exited ? ({} as Element) : null;
    },
  };
  return { calls, target, lockOwner };
}

describe("a press that does not move", () => {
  test("is a click: it scrubs nothing and never takes the lock", () => {
    const { calls, target, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(target, lockOwner);
    expect(drag.move(SCRUB_THRESHOLD_PX - 1)).toBe(null);
    expect(drag.end()).toBe(null);
    expect(calls.requested).toBe(0);
  });
});

describe("a drag", () => {
  test("accumulates movement and reports it from the threshold on", () => {
    const { target, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(target, lockOwner);
    expect(drag.move(2)).toBe(null);
    expect(drag.move(2)).toBe(4);
    expect(drag.move(-10)).toBe(-6);
    expect(drag.end()).toBe(-6);
  });

  test("takes the lock as soon as it is a drag, and gives it back at the end", () => {
    const { calls, target, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(target, lockOwner);
    // The press has not moved far enough to be a drag: no lock, so a click keeps its cursor.
    expect(drag.move(1)).toBe(null);
    expect(calls.requested).toBe(0);
    drag.move(40);
    // Asked for here, while the press that started it is still the browser's idea of a
    // gesture — at the edge of the screen, minutes later, it would be refused.
    expect(calls.requested).toBe(1);
    drag.move(40);
    expect(calls.requested).toBe(1);
    expect(drag.end()).toBe(81);
    expect(calls.exited).toBe(1);
  });

  test("the warp that comes with the lock is not counted as movement", () => {
    const { target, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(target, lockOwner);
    expect(drag.move(40)).toBe(40);
    // Locking puts the cursor in the middle of the screen; the first move afterwards
    // carries that jump rather than the hand, and half the range with it.
    expect(drag.move(-1200, true)).toBe(40);
    // Every move after it is the hand again.
    expect(drag.move(-10, true)).toBe(30);
    expect(drag.end()).toBe(30);
  });

  test("a press that never becomes a drag is a click even under a lock left by another", () => {
    const { calls, target, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(target, lockOwner);
    expect(drag.move(1, true)).toBe(null);
    expect(drag.end()).toBe(null);
    expect(calls.requested).toBe(0);
  });

  test("a press begun while the last one is unfinished starts from zero", () => {
    const { target, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(target, lockOwner);
    drag.move(40);
    drag.begin(target, lockOwner);
    expect(drag.move(5)).toBe(5);
  });
});

describe("a drag that is told not to lock", () => {
  test("scrubs the same, and never asks", () => {
    const { calls, lockOwner } = owner();
    const drag = new ScrubDrag();
    drag.begin(null, lockOwner);
    expect(drag.move(40)).toBe(40);
    expect(drag.end()).toBe(40);
    expect(calls.requested).toBe(0);
    expect(calls.exited).toBe(0);
  });

  test("the flag is the renderer's query, not a guess about the environment", () => {
    expect(pointerLockDisabled("?photo=/tmp/a.raf&pointerlock=off")).toBe(true);
    expect(pointerLockDisabled("?photo=/tmp/a.raf")).toBe(false);
    expect(pointerLockDisabled("")).toBe(false);
  });
});

describe("the cursor a locked scrub draws", () => {
  test("comes back in at the other side of the window", () => {
    expect(wrapAround(30, 1000)).toBe(30);
    expect(wrapAround(1010, 1000)).toBe(10);
    // Off the left edge: back in at the right.
    expect(wrapAround(-10, 1000)).toBe(990);
    // Several screens' worth of movement in one frame still lands somewhere sane.
    expect(wrapAround(-4010, 1000)).toBe(990);
  });

  test("a window with no width is nothing to wrap around", () => {
    expect(wrapAround(30, 0)).toBe(0);
    expect(wrapAround(Number.NaN, 1000)).toBe(0);
  });
});

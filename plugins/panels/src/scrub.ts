/**
 * The drag behind every slider and readout in the app: a press that moves horizontally
 * scrubs the value, one that does not opens the text editor.
 *
 * Movement is accumulated from `movementX` rather than read back off `clientX`, because a
 * long scrub runs out of monitor: the pointer stops at the edge of the screen while the
 * value still has range left. The drag takes a pointer lock for that — the cursor freezes
 * and the raw movement keeps coming, so the scrub wraps instead of stopping.
 *
 * The lock is requested the moment the press becomes a drag, not when the pointer reaches
 * the edge: `requestPointerLock` needs the transient activation of a recent gesture, and a
 * slow scrub — the kind that runs out of screen — is minutes past its pointerdown by the
 * time it gets there. Asking at the edge is asking too late, and the browser refuses.
 */

/** Below this a press is a click that opens the editor, above it a drag that scrubs. */
export const SCRUB_THRESHOLD_PX = 3;

/** The element the lock is asked for. Narrowed so a test can hand over a stub. */
export interface LockTarget {
  requestPointerLock(): unknown;
}

/**
 * `?pointerlock=off` in the renderer's URL: the drag scrubs without ever taking the lock.
 * Pointer lock and synthetic input do not mix — the lock warps the cursor to the middle of
 * the screen and Chromium then reports a driver's absolute moves as hundreds of pixels of
 * noise (measured under Playwright: a 10 px step arrived as −819, then +829, then −817) —
 * so the screenshot flows turn it off. A driven window has a whole virtual screen and never
 * runs out of it; the lock is the part it can do without, and `ScrubDrag` is covered by its
 * own tests either way.
 */
export function pointerLockDisabled(search: string): boolean {
  return new URLSearchParams(search).get("pointerlock") === "off";
}

/**
 * The cursor Figma draws while a scrub is locked: the real one is hidden and frozen, so the
 * drag paints its own, and a scrub that runs past the side of the window comes back in at
 * the other one. Negative and huge values both wrap, so nothing has to clamp first.
 */
export function wrapAround(value: number, extent: number): number {
  if (!Number.isFinite(value) || extent <= 0) return 0;
  return ((value % extent) + extent) % extent;
}

export interface LockOwner {
  exitPointerLock(): void;
  readonly pointerLockElement: Element | null;
}

export class ScrubDrag {
  /** Total pointer movement since the press, in pixels, lock or no lock. */
  private movement = 0;
  private target: LockTarget | null = null;
  private owner: LockOwner | null = null;
  private requested = false;
  /** The lock has engaged, so the warp that comes with it has been accounted for. */
  private engaged = false;
  /** True once the press has moved far enough to count as a drag rather than a click. */
  scrubbing = false;
  pressed = false;

  /**
   * A press landed. Nothing is locked yet: a click that never moves must stay a click. A
   * `null` target scrubs without ever asking for the lock.
   */
  begin(target: LockTarget | null, owner: LockOwner): void {
    this.pressed = true;
    this.scrubbing = false;
    this.requested = false;
    this.engaged = false;
    this.movement = 0;
    this.target = target;
    this.owner = owner;
  }

  /**
   * A move arrived. Returns the pixels scrubbed so far, or `null` while the press is still
   * within the click threshold — the caller has nothing to write until then. `locked` is
   * whether the document holds a pointer lock right now.
   */
  move(movementX: number, locked = false): number | null {
    if (!this.pressed) return null;
    // Locking warps the cursor to the middle of the screen, and the first move reported
    // afterwards carries that warp rather than the hand. Counting it would throw the
    // value half its range across in one frame.
    if (locked && !this.engaged) {
      this.engaged = true;
      return this.scrubbing ? this.movement : null;
    }
    this.movement += movementX;
    if (!this.scrubbing && Math.abs(this.movement) < SCRUB_THRESHOLD_PX) return null;
    // A drag, from here on: the lock is asked for now, while the press that started it is
    // still recent enough to count as the gesture the browser wants.
    this.scrubbing = true;
    this.lock();
    return this.movement;
  }

  /**
   * The press ended. Returns the pixels scrubbed, or `null` if it never became a drag, in
   * which case the caller opens its editor instead.
   */
  end(): number | null {
    if (!this.pressed) return null;
    this.pressed = false;
    this.unlock();
    if (!this.scrubbing) return null;
    this.scrubbing = false;
    return this.movement;
  }

  private lock(): void {
    if (this.requested) return;
    this.requested = true;
    // Pointer lock is a request, not a guarantee: a browser that refuses it simply scrubs
    // the old way, up to the edge of the screen.
    try {
      const requested = this.target?.requestPointerLock();
      if (requested instanceof Promise) requested.catch(() => undefined);
    } catch {
      // Same fallback as a refusal.
    }
  }

  private unlock(): void {
    const owner = this.owner;
    const wasRequested = this.requested;
    this.target = null;
    this.owner = null;
    this.requested = false;
    this.engaged = false;
    if (!wasRequested || !owner || owner.pointerLockElement === null) return;
    owner.exitPointerLock();
  }
}

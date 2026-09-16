import { describe, expect, test } from "bun:test";
import { FRAME_HEADER_BYTES } from "@latent/protocol";
import { PhotoState, renderFrame } from "../mock-engine";

function exposureOf(photo: PhotoState): number {
  const entry = photo.stack.find((candidate) => candidate.op === "exposure");
  return Number(entry?.params.value ?? 0);
}

describe("history semantics", () => {
  test("a fresh photo has nothing to undo or redo", () => {
    const photo = new PhotoState();
    expect(photo.snapshot()).toEqual({ stack: [], revision: 0, canUndo: false, canRedo: false });
  });

  test("a committed mutation snapshots, undo restores the stack before it", () => {
    const photo = new PhotoState();
    const op = photo.addOp("exposure", { value: 1 });
    expect(photo.canUndo).toBe(true);
    photo.updateOp(op.id, { value: 2 }, undefined, false);
    photo.undo();
    expect(exposureOf(photo)).toBe(1);
    expect(photo.canRedo).toBe(true);
    photo.redo();
    expect(exposureOf(photo)).toBe(2);
  });

  test("transient updates replace the live stack without snapshotting the drag", () => {
    const photo = new PhotoState();
    const op = photo.addOp("exposure", { value: 0 });
    for (const value of [0.2, 0.4, 0.6, 0.8]) photo.updateOp(op.id, { value }, undefined, true);
    expect(exposureOf(photo)).toBe(0.8);
    photo.updateOp(op.id, { value: 0.8 }, undefined, false);

    // One undo lands before the whole drag, not on one of its intermediate values.
    photo.undo();
    expect(exposureOf(photo)).toBe(0);
    expect(photo.canUndo).toBe(true);
    photo.undo();
    expect(photo.stack).toEqual([]);
    expect(photo.canUndo).toBe(false);
  });

  test("a mutation after undo drops the redo tail", () => {
    const photo = new PhotoState();
    const op = photo.addOp("exposure", { value: 1 });
    photo.updateOp(op.id, { value: 2 }, undefined, false);
    photo.undo();
    photo.updateOp(op.id, { value: 3 }, undefined, false);
    expect(photo.canRedo).toBe(false);
    expect(exposureOf(photo)).toBe(3);
  });

  test("snapshots are values: mutating later never rewrites history", () => {
    const photo = new PhotoState();
    const op = photo.addOp("exposure", { value: 1 });
    const before = photo.stack;
    photo.updateOp(op.id, { value: 5 }, undefined, false);
    expect(Number(before[0]?.params.value)).toBe(1);
  });

  test("the revision advances on every change, including transient ones", () => {
    const photo = new PhotoState();
    const op = photo.addOp("exposure", { value: 0 });
    const afterAdd = photo.revision;
    photo.updateOp(op.id, { value: 1 }, undefined, true);
    expect(photo.revision).toBe(afterAdd + 1);
  });

  test("removing an op and disabling it are both undoable", () => {
    const photo = new PhotoState();
    const op = photo.addOp("contrast", { value: 30 });
    photo.updateOp(op.id, {}, false, false);
    expect(photo.stack[0]?.enabled).toBe(false);
    photo.removeOp(op.id);
    expect(photo.stack).toEqual([]);
    photo.undo();
    expect(photo.stack).toHaveLength(1);
  });
});

describe("frames", () => {
  test("an LFRM frame carries a 32-byte header and rgba8 pixels", () => {
    const frame = renderFrame(8, 4, 7, 3, []);
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES + 8 * 4 * 4);
    const view = new DataView(frame);
    expect(
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)),
    ).toBe("LFRM");
    expect(view.getUint32(4, true)).toBe(8);
    expect(view.getUint32(12, true)).toBe(7);
    expect(view.getUint32(16, true)).toBe(3);
  });

  test("exposure changes the pixels", () => {
    const photo = new PhotoState();
    const dark = new Uint8Array(renderFrame(8, 4, 1, 1, photo.stack), FRAME_HEADER_BYTES);
    photo.addOp("exposure", { value: 2 });
    const bright = new Uint8Array(renderFrame(8, 4, 2, 1, photo.stack), FRAME_HEADER_BYTES);
    expect(bright[0]).toBeGreaterThan(Number(dark[0]));
  });
});

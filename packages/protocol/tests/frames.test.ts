import { describe, expect, test } from "bun:test";
import {
  FRAME_FORMAT_R8,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC_MASK,
  FRAME_MAGIC_THUMBNAIL,
  frameBody,
  parseFrameHeader,
} from "../src/frames";

/** Builds a frame the way the engine does: 32-byte header, then the payload. */
function frame(magic: string, fields: number[], payload: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(buffer);
  for (let index = 0; index < magic.length; index++) {
    view.setUint8(index, magic.charCodeAt(index));
  }
  for (const [index, value] of fields.entries()) view.setUint32(4 + index * 4, value, true);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

describe("binary frames", () => {
  test("an LTHM header reads photoId as the target and jpeg as the format", () => {
    const header = parseFrameHeader(frame("LTHM", [256, 170, 3, 42, 1], [0xff, 0xd8]));
    expect(header).toEqual({
      magic: FRAME_MAGIC_THUMBNAIL,
      width: 256,
      height: 170,
      seq: 3,
      target: 42,
      format: 1,
    });
  });

  test("the body is the bytes after the header, not a copy of the frame", () => {
    const body = frameBody(frame("LTHM", [2, 1, 1, 7, 1], [0xff, 0xd8, 0x00]));
    expect([...body]).toEqual([0xff, 0xd8, 0x00]);
  });

  test("an LMSK header reads the viewId as the target and r8 as the format", () => {
    const header = parseFrameHeader(frame("LMSK", [4, 2, 9, 3, FRAME_FORMAT_R8], [0, 255, 128]));
    expect(header).toEqual({
      magic: FRAME_MAGIC_MASK,
      width: 4,
      height: 2,
      seq: 9,
      target: 3,
      format: FRAME_FORMAT_R8,
    });
    // One byte per pixel, not four: the body is w·h long.
    expect(frameBody(frame("LMSK", [2, 2, 1, 0, FRAME_FORMAT_R8], [1, 2, 3, 4]))).toHaveLength(4);
  });

  test("a short buffer or an unknown magic is an error, never a half-read frame", () => {
    expect(() => parseFrameHeader(new ArrayBuffer(8))).toThrow("too short");
    expect(() => frameBody(new ArrayBuffer(8))).toThrow("too short");
    expect(() => parseFrameHeader(frame("XXXX", [1, 1, 1, 1, 0], []))).toThrow("unknown binary frame magic");
  });
});

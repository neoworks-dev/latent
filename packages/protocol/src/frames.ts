// Binary frame header, mirrors protocol/frames.md.

export const FRAME_HEADER_BYTES = 32;
export const FRAME_MAGIC_PREVIEW = "LFRM";
export const FRAME_MAGIC_THUMBNAIL = "LTHM";

export interface FrameHeader {
  magic: string;
  width: number;
  height: number;
  seq: number;
  /** viewId for LFRM, photoId for LTHM. */
  target: number;
  /** 0 = rgba8 sRGB pixels, 1 = jpeg bytes. */
  format: number;
}

export function parseFrameHeader(buffer: ArrayBuffer): FrameHeader {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`binary frame too short: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== FRAME_MAGIC_PREVIEW && magic !== FRAME_MAGIC_THUMBNAIL) {
    throw new Error(`unknown binary frame magic ${magic}`);
  }
  return {
    magic,
    width: view.getUint32(4, true),
    height: view.getUint32(8, true),
    seq: view.getUint32(12, true),
    target: view.getUint32(16, true),
    format: view.getUint32(20, true),
  };
}

// Binary frame header, mirrors protocol/frames.md.

export const FRAME_HEADER_BYTES = 32;
export const FRAME_MAGIC_PREVIEW = "LFRM";
export const FRAME_MAGIC_THUMBNAIL = "LTHM";
/** `mask.preview`'s raster: r8 coverage, one byte per pixel, `format` 2. */
export const FRAME_MAGIC_MASK = "LMSK";

/** Payload encodings, as `format` in the header. */
export const FRAME_FORMAT_RGBA8 = 0;
export const FRAME_FORMAT_JPEG = 1;
export const FRAME_FORMAT_R8 = 2;

export interface FrameHeader {
  magic: string;
  width: number;
  height: number;
  seq: number;
  /** viewId for LFRM and LMSK (0 when the mask was not sized for a view), photoId for LTHM. */
  target: number;
  /** 0 = rgba8 sRGB pixels, 1 = jpeg bytes, 2 = r8 mask coverage. */
  format: number;
}

/**
 * Everything after the header: rgba8 pixels for `LFRM`, JPEG bytes for `LTHM`, one
 * coverage byte per pixel for `LMSK`.
 */
export function frameBody(buffer: ArrayBuffer): Uint8Array<ArrayBuffer> {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`binary frame too short: ${buffer.byteLength} bytes`);
  }
  return new Uint8Array(buffer, FRAME_HEADER_BYTES);
}

export function parseFrameHeader(buffer: ArrayBuffer): FrameHeader {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`binary frame too short: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== FRAME_MAGIC_PREVIEW && magic !== FRAME_MAGIC_THUMBNAIL && magic !== FRAME_MAGIC_MASK) {
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

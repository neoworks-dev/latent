import { describe, expect, test } from "bun:test";
import { encodeJpeg } from "../jpeg";

function gradient(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x / width) * 255;
      pixels[offset + 1] = (y / height) * 255;
      pixels[offset + 2] = 128;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/** Reads SOF0 (0xFFC0), the only place a baseline JPEG states its size. */
function frameSize(jpeg: Uint8Array): { width: number; height: number } {
  for (let index = 2; index < jpeg.length - 9; index++) {
    if (jpeg[index] !== 0xff || jpeg[index + 1] !== 0xc0) continue;
    const height = ((jpeg[index + 5] ?? 0) << 8) | (jpeg[index + 6] ?? 0);
    const width = ((jpeg[index + 7] ?? 0) << 8) | (jpeg[index + 8] ?? 0);
    return { width, height };
  }
  throw new Error("no SOF0 marker");
}

/** First byte of the entropy-coded data: past the SOS marker and its header. */
function scanStart(jpeg: Uint8Array): number {
  for (let index = 2; index < jpeg.length - 4; index++) {
    if (jpeg[index] !== 0xff || jpeg[index + 1] !== 0xda) continue;
    return index + 2 + (((jpeg[index + 2] ?? 0) << 8) | (jpeg[index + 3] ?? 0));
  }
  throw new Error("no SOS marker");
}

describe("baseline jpeg encoder", () => {
  test("wraps the scan in SOI/EOI and states the image size in SOF0", () => {
    const jpeg = encodeJpeg(gradient(70, 34), 70, 34);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect([jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd9]);
    // 70×34 is not a multiple of 8: edge blocks must still encode.
    expect(frameSize(jpeg)).toEqual({ width: 70, height: 34 });
  });

  test("a 0xFF byte in the entropy-coded scan is always followed by a stuffed 0x00", () => {
    const jpeg = encodeJpeg(gradient(64, 64), 64, 64, 95);
    for (let index = scanStart(jpeg); index < jpeg.length - 2; index++) {
      if (jpeg[index] !== 0xff) continue;
      expect(jpeg[index + 1]).toBe(0x00);
    }
  });

  test("lower quality is fewer bytes, and an empty image is refused", () => {
    const pixels = gradient(64, 64);
    expect(encodeJpeg(pixels, 64, 64, 20).length).toBeLessThan(
      encodeJpeg(pixels, 64, 64, 90).length,
    );
    expect(() => encodeJpeg(pixels, 0, 64)).toThrow("empty image");
    expect(() => encodeJpeg(new Uint8Array(4), 64, 64)).toThrow("pixel buffer too short");
  });
});

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng, mergeOptions, mergeOutputPath, paintMerge } from "../mock-merge";

const options = mergeOptions({});

describe("output paths", () => {
  test("Lightroom's suffix, next to the source", () => {
    expect(mergeOutputPath("hdr", "/photos/DSC0001.ARW")).toBe("/photos/DSC0001-HDR.tif");
    expect(mergeOutputPath("panorama", "/photos/DSC0001.ARW")).toBe("/photos/DSC0001-Pano.tif");
    expect(mergeOutputPath("hdrPanorama", "/photos/a.rw2")).toBe("/photos/a-HDRPano.tif");
  });

  test("a source with no extension keeps its whole name", () => {
    expect(mergeOutputPath("hdr", "/photos/raw")).toBe("/photos/raw-HDR.tif");
  });
});

describe("the synthetic picture", () => {
  test("a panorama is much wider than an HDR merge of the same long edge", () => {
    const hdr = paintMerge("hdr", 3, options, 512);
    const panorama = paintMerge("panorama", 3, options, 512);
    expect(hdr.width).toBe(512);
    expect(panorama.width).toBe(512);
    expect(panorama.height).toBeLessThan(hdr.height);
    expect(hdr.rgba.length).toBe(hdr.width * hdr.height * 4);
  });

  test("Boundary Warp and Auto Crop change the pixels, so the preview is worth re-asking for", () => {
    const uncropped = paintMerge("panorama", 4, { ...options, autoCrop: false }, 256);
    const cropped = paintMerge("panorama", 4, { ...options, autoCrop: true }, 256);
    expect(uncropped.rgba).not.toEqual(cropped.rgba);
  });

  test("Deghost Amount changes an HDR merge", () => {
    const none = paintMerge("hdr", 3, { ...options, deghost: "none" }, 256);
    const high = paintMerge("hdr", 3, { ...options, deghost: "high" }, 256);
    expect(none.rgba).not.toEqual(high.rgba);
  });
});

describe("PNG encoding", () => {
  test("the bytes start with the PNG signature and an IHDR naming the size", () => {
    const png = encodePng(new Uint8Array(4 * 4 * 4), 4, 4);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(8, false)).toBe(13);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect(view.getUint32(16, false)).toBe(4);
    expect(view.getUint32(20, false)).toBe(4);
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });

  test("the IDAT inflates back to the rows that went in, each behind a zero filter byte", () => {
    const picture = paintMerge("panorama", 3, options, 64);
    const png = encodePng(picture.rgba, picture.width, picture.height);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    // signature 8 + IHDR (12 + 13) = 33; the next chunk is the IDAT.
    const length = view.getUint32(33, false);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe("IDAT");
    const raw = new Uint8Array(inflateSync(png.subarray(41, 41 + length)));
    const stride = picture.width * 4;
    expect(raw.length).toBe((stride + 1) * picture.height);
    expect(raw[0]).toBe(0);
    expect([...raw.subarray(1, 1 + stride)]).toEqual([...picture.rgba.subarray(0, stride)]);
  });
});

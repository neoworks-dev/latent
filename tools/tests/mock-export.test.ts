import { describe, expect, test } from "bun:test";
import type { ExportRunParams } from "@latent/protocol";
import { exportFileName, planFiles } from "../mock-export";

describe("the mock's file naming matches the engine's", () => {
  test("the default template is the source stem plus the format's extension", () => {
    expect(exportFileName("{name}", "/photos/DSC00120.ARW", 1, "jpeg")).toBe("DSC00120.jpg");
    expect(exportFileName("{name}", "/photos/DSC00120.ARW", 1, "tiff16")).toBe("DSC00120.tif");
  });

  test("{index} is one-based and an explicit extension is not doubled", () => {
    expect(exportFileName("{name}-{index}", "/a/b.ARW", 4, "png")).toBe("b-4.png");
    expect(exportFileName("{name}.jpg", "/a/b.ARW", 1, "jpeg")).toBe("b.jpg");
  });

  test("a template is a file name, never a path", () => {
    expect(exportFileName("../../etc/passwd", "/a/b.ARW", 1, "png")).toBe("etcpasswd.png");
  });
});

describe("planning a run", () => {
  const params = (patch: Partial<ExportRunParams>): ExportRunParams => ({
    photoIds: [1, 2, 3],
    format: "jpeg",
    colorSpace: "srgb",
    outputDir: "/tmp/out",
    ...patch,
  });

  test("colliding names are made unique, in order", () => {
    const files = planFiles(params({}), ["/a/IMG.ARW", "/b/IMG.ARW", "/c/other.ARW"]);
    expect(files).toEqual(["/tmp/out/IMG.jpg", "/tmp/out/IMG-2.jpg", "/tmp/out/other.jpg"]);
  });

  test("a photo the catalog does not know still gets a file", () => {
    const files = planFiles(params({ photoIds: [9] }), [""]);
    expect(files).toEqual(["/tmp/out/photo.jpg"]);
  });
});

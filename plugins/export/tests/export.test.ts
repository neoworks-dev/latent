import { describe, expect, test } from "bun:test";
import type { JobProgressParams } from "@latent/protocol";
import {
  defaultSettings,
  exportParams,
  exportPhotoIds,
  fileNameOf,
  jobLabel,
  jobPercent,
  settingsProblem,
  usesQuality,
} from "../src/export";

describe("which photos an export covers", () => {
  test("the library selection wins when there is one", () => {
    expect(exportPhotoIds([4, 9], 1)).toEqual([4, 9]);
  });

  test("an empty selection falls back to the open photo", () => {
    expect(exportPhotoIds([], 7)).toEqual([7]);
  });

  test("nothing selected and nothing open is nothing to export", () => {
    expect(exportPhotoIds([], null)).toEqual([]);
  });
});

describe("what stops the button", () => {
  test("no photos", () => {
    expect(settingsProblem({ ...defaultSettings(), outputDir: "/tmp" }, 0)).toBe(
      "Open a photo or select some in the library",
    );
  });

  test("no folder, and whitespace is not a folder", () => {
    expect(settingsProblem(defaultSettings(), 1)).toBe("Choose an output folder");
    expect(settingsProblem({ ...defaultSettings(), outputDir: "   " }, 1)).toBe(
      "Choose an output folder",
    );
  });

  test("a long edge outside the engine's range", () => {
    const base = { ...defaultSettings(), outputDir: "/tmp", sizeMode: "longEdge" as const };
    expect(settingsProblem({ ...base, longEdge: 0 }, 1)).toContain("Long edge");
    expect(settingsProblem({ ...base, longEdge: 99999 }, 1)).toContain("Long edge");
    expect(settingsProblem({ ...base, longEdge: 2048 }, 1)).toBeNull();
  });

  test("a complete set of settings passes", () => {
    expect(settingsProblem({ ...defaultSettings(), outputDir: "/tmp/out" }, 3)).toBeNull();
  });
});

describe("the params that go on the wire", () => {
  test("the minimum is the four required fields", () => {
    const params = exportParams({ ...defaultSettings(), outputDir: " /tmp/out " }, [1]);
    expect(params).toEqual({
      photoIds: [1],
      format: "jpeg",
      colorSpace: "srgb",
      outputDir: "/tmp/out",
      quality: 90,
    });
  });

  test("a lossless format carries no quality", () => {
    const params = exportParams({ ...defaultSettings(), format: "tiff16", outputDir: "/tmp" }, [1]);
    expect(params.quality).toBeUndefined();
    expect(usesQuality("tiff16")).toBe(false);
    expect(usesQuality("avif")).toBe(true);
  });

  test("resize is omitted at full size and present with a long edge or a dpi", () => {
    const base = { ...defaultSettings(), outputDir: "/tmp" };
    expect(exportParams(base, [1]).resize).toBeUndefined();
    expect(exportParams({ ...base, sizeMode: "longEdge", longEdge: 1200 }, [1]).resize).toEqual({
      longEdge: 1200,
    });
    // dpi is metadata, so it travels on its own without forcing a resample.
    expect(exportParams({ ...base, dpi: 300 }, [1]).resize).toEqual({ dpi: 300 });
  });

  test("sharpening is omitted when it is off", () => {
    const base = { ...defaultSettings(), outputDir: "/tmp" };
    expect(exportParams(base, [1]).sharpen).toBeUndefined();
    expect(exportParams({ ...base, sharpen: "matte", sharpenAmount: "high" }, [1]).sharpen).toEqual(
      { target: "matte", amount: "high" },
    );
  });

  test("the default template is left off, a real one is sent", () => {
    const base = { ...defaultSettings(), outputDir: "/tmp" };
    expect(exportParams(base, [1]).fileNameTemplate).toBeUndefined();
    expect(exportParams({ ...base, fileNameTemplate: "web-{name}" }, [1]).fileNameTemplate).toBe(
      "web-{name}",
    );
  });
});

describe("progress", () => {
  const job = (patch: Partial<JobProgressParams>): JobProgressParams => ({
    jobId: 1,
    kind: "export",
    done: 0,
    total: 4,
    finished: false,
    ...patch,
  });

  test("percent is clamped and empty before the first tick", () => {
    expect(jobPercent(null)).toBe(0);
    expect(jobPercent(job({ total: 0 }))).toBe(0);
    expect(jobPercent(job({ done: 1 }))).toBe(25);
    expect(jobPercent(job({ done: 9, total: 4 }))).toBe(100);
  });

  test("a running job names the file it is on, one-based", () => {
    expect(jobLabel(job({ done: 1, message: "/out/DSC00120.jpg" }))).toBe(
      "Exporting DSC00120.jpg (2 of 4)",
    );
  });

  test("a finished job reports how it ended", () => {
    expect(
      jobLabel(job({ done: 4, finished: true, state: "done", message: "4 of 4 written" })),
    ).toBe("4 of 4 written");
    expect(jobLabel(job({ done: 2, finished: true, state: "cancelled" }))).toBe(
      "Cancelled after 2 of 4",
    );
    expect(jobLabel(job({ done: 4, finished: true, state: "error", error: "disk full" }))).toBe(
      "disk full",
    );
  });

  test("file names come out of absolute paths", () => {
    expect(fileNameOf("/a/b/c.jpg")).toBe("c.jpg");
    expect(fileNameOf("c.jpg")).toBe("c.jpg");
  });
});

// The shapes the v3 batch added, written the way a caller writes them. These run as
// assertions and typecheck as usage: a params or result field that drifts out of the
// generated types fails `bun run typecheck`, not only this file's expectations.
import { describe, expect, test } from "bun:test";
import type {
  CatalogImportResult,
  CatalogListParams,
  CatalogRemoveResult,
  CatalogThumbnailsResult,
  EngineHelloResult,
  JobCancelResult,
  JobProgressParams,
  MethodMap,
  OpDefinition,
  PhotoOpenResult,
  PythonFinishedParams,
  PythonOutputParams,
  PythonRunResult,
  StackChangedParams,
  ViewRenderResult,
} from "../src/index";
import { methods, notifications } from "../src/methods";

describe("method table", () => {
  test("the v3 requests and the streamed-output notification are listed", () => {
    expect(methods).toContain("catalog.thumbnails");
    expect(methods).toContain("catalog.remove");
    expect(methods).toContain("job.cancel");
    expect(notifications).toContain("python.output");
    // The singular thumbnail call stays: an engine that only has it still answers.
    expect(methods).toContain("catalog.thumbnail");
  });
});

describe("batch thumbnails", () => {
  test("a page asks for its photos in one call", () => {
    const params: MethodMap["catalog.thumbnails"]["params"] = { photoIds: [1, 2, 3], size: 256 };
    expect(params.photoIds).toHaveLength(3);
  });

  test("the result accounts for every id, sent or missing", () => {
    const result: CatalogThumbnailsResult = { requested: 3, sent: 2, missing: [3] };
    expect(result.sent + result.missing.length).toBe(result.requested);
  });

  test("size is optional, so a client that does not care omits it", () => {
    const params: MethodMap["catalog.thumbnails"]["params"] = { photoIds: [7] };
    expect(params.size).toBeUndefined();
  });
});

describe("removing rows", () => {
  test("remove takes the selection and answers with a count", () => {
    const params: MethodMap["catalog.remove"]["params"] = { photoIds: [4, 5] };
    const result: CatalogRemoveResult = { removed: 2 };
    expect(params.photoIds).toHaveLength(result.removed);
  });
});

describe("listing", () => {
  test("photoIds and query narrow a list without replacing the other filters", () => {
    const params: CatalogListParams = {
      folder: "/photos/trip",
      photoIds: [1, 2],
      query: "dscf",
      sort: "capturedAt",
    };
    expect(params.query).toBe("dscf");
    expect(params.photoIds).toEqual([1, 2]);
  });
});

describe("jobs", () => {
  test("a cancelled job's last progress says so and still counts what it did", () => {
    const cancelled: JobProgressParams = {
      jobId: 1,
      kind: "import",
      done: 12,
      total: 40,
      finished: true,
      state: "cancelled",
      message: "import cancelled after 12 photos",
    };
    expect(cancelled.finished).toBe(true);
    expect(cancelled.state).toBe("cancelled");
  });

  test("cancelling an unknown job is false, not an error", () => {
    const result: JobCancelResult = { cancelled: false };
    expect(result.cancelled).toBe(false);
  });

  test("a job from an engine without the state field still typechecks", () => {
    const legacy: JobProgressParams = { jobId: 2, kind: "import", done: 3, total: 3, finished: true };
    expect(legacy.state).toBeUndefined();
  });
});

describe("python", () => {
  test("a run carries its own timeout and comes back with the id its output was tagged with", () => {
    const params: MethodMap["python.run"]["params"] = { code: "latent.undo()", timeoutMs: 5000 };
    const result: PythonRunResult = {
      ok: true,
      stdout: "done\n",
      stderr: "",
      runId: 9,
      durationMs: 0.4,
    };
    const chunk: PythonOutputParams = { runId: 9, stream: "stdout", text: "done\n" };
    expect(params.timeoutMs).toBe(5000);
    expect(result.runId).toBe(chunk.runId);
    // The result repeats the streams, so a client can render either one, never both.
    expect(result.stdout).toBe(chunk.text);
  });
});

describe("v4 additions", () => {
  test("hello names the catalog, and the MCP url only when there is one", () => {
    const withMcp: EngineHelloResult = {
      engineVersion: "0.1.0",
      protocolVersion: 1,
      catalogPath: "/home/u/.local/share/latent/catalog.db",
      mcpUrl: "http://127.0.0.1:7801/mcp",
      gpu: { adapter: "RTX 4080", maxTextureDimension2D: 32768, shaderF16: true },
    };
    const headless: EngineHelloResult = { ...withMcp, mcpUrl: undefined };
    expect(withMcp.mcpUrl).toContain("/mcp");
    expect(headless.mcpUrl).toBeUndefined();
  });

  test("an import names the thumbnail job it queues, and that job names its parent", () => {
    const imported: CatalogImportResult = { jobId: 4, thumbnailJobId: 5 };
    const child: JobProgressParams = {
      jobId: imported.thumbnailJobId ?? 0,
      parentJobId: imported.jobId,
      kind: "thumbnails",
      done: 12,
      total: 12,
      finished: true,
      state: "done",
    };
    expect(child.parentJobId).toBe(imported.jobId);
  });

  test("a finished run repeats the duration the result carries", () => {
    const result: PythonRunResult = {
      ok: true,
      stdout: "hi\n",
      stderr: "",
      runId: 3,
      durationMs: 1.5,
    };
    const finished: PythonFinishedParams = { runId: 3, durationMs: 1.5, ok: true };
    // durationMs is optional on the result (an older engine may omit it) and required on
    // the notification, so the console can time a run from the notification alone.
    expect(result.durationMs).toBe(finished.durationMs);
    expect(notifications).toContain("python.finished");
  });

  test("a frame knows which revision it was rendered from", () => {
    const rendered: ViewRenderResult = {
      seq: 7,
      width: 1280,
      height: 720,
      // A portrait photo in a 16:9 view: the frame is mostly letterbox, and only this says
      // where the photo is inside it.
      contentRect: [399, 0, 481, 720],
      renderMs: 1.4,
      readbackMs: 4.8,
      revision: 12,
    };
    expect(rendered.contentRect?.[2]).toBeLessThan(rendered.width);
    const changed: StackChangedParams = {
      stack: [],
      revision: 12,
      canUndo: true,
      canRedo: false,
      photoId: 1,
      source: "mcp",
      client: "mcp:run_python",
    };
    // Equal revisions mean the canvas is showing the newest state, not a stale frame.
    expect(rendered.revision).toBe(changed.revision);
    expect(changed.client).toBe("mcp:run_python");
  });

  test("a described op says which Lightroom section it belongs in and how to draw it", () => {
    const whiteBalance: OpDefinition = {
      name: "white_balance",
      panel: "color",
      section: "Color",
      order: 1,
      label: "White Balance",
      params: [
        {
          name: "temperature",
          label: "Temp",
          type: "number",
          min: -100,
          max: 100,
          step: 1,
          default: 0,
          display: { kind: "kelvin", tint: "temperature" },
        },
      ],
    };
    expect(whiteBalance.params[0]?.display?.tint).toBe("temperature");
    expect(whiteBalance.section).toBe("Color");
  });
});

describe("photo.open", () => {
  test("the catalog row rides along, so no second catalog.get is needed", () => {
    const opened: PhotoOpenResult = {
      photoId: 3,
      width: 6024,
      height: 4024,
      camera: "Sony A6400",
      hash: "0".repeat(64),
      sidecarLoaded: false,
      catalog: {
        photoId: 3,
        path: "/photos/a.arw",
        folder: "/photos",
        filename: "a.arw",
        width: 6024,
        height: 4024,
        camera: "Sony A6400",
        rating: 0,
        flag: "none",
        hasSidecar: false,
        importedAt: "2026-09-16T10:00:00.000Z",
      },
    };
    expect(opened.catalog?.photoId).toBe(opened.photoId);
  });
});

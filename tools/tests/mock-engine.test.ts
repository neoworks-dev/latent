import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CatalogImportResult,
  CatalogListResult,
  CatalogRemoveResult,
  CatalogThumbnailsResult,
  EngineHelloResult,
  OpsDescribeResult,
  StackChangedParams,
  StackGetResult,
  CatalogPhoto,
  JobCancelResult,
  JobProgressParams,
  MaskComponent,
  MaskDetectResult,
  MaskPreviewResult,
  Op,
  PhotoOpenResult,
  PythonFinishedParams,
  PythonRunResult,
  ViewOpenResult,
  ViewRenderResult,
} from "@latent/protocol";
import { FRAME_HEADER_BYTES, parseFrameHeader } from "@latent/protocol";
import { opDefinitions, PhotoState, renderFrame, startMockEngine } from "../mock-engine";

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

  test("a point curve changes the pixels, a curve at its default does not", () => {
    const photo = new PhotoState();
    const flat = new Uint8Array(renderFrame(8, 4, 1, 1, photo.stack), FRAME_HEADER_BYTES);
    const op = photo.addOp("tone_curve", { rgb: [], red: [], green: [], blue: [] });
    const neutral = new Uint8Array(renderFrame(8, 4, 2, 1, photo.stack), FRAME_HEADER_BYTES);
    expect([...neutral]).toEqual([...flat]);

    // A quarter-tone lifted to 0.4 raises everything below the next control point.
    photo.updateOp(
      op.id,
      {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.4 },
          { x: 1, y: 1 },
        ],
      },
      undefined,
      false,
    );
    const lifted = new Uint8Array(renderFrame(8, 4, 3, 1, photo.stack), FRAME_HEADER_BYTES);
    expect(lifted[0]).toBeGreaterThan(Number(flat[0]));
    expect(lifted[1]).toBeGreaterThan(Number(flat[1]));
    expect(lifted[2]).toBeGreaterThan(Number(flat[2]));
  });

  test("a red curve moves only the red channel", () => {
    const photo = new PhotoState();
    const before = new Uint8Array(renderFrame(8, 4, 1, 1, photo.stack), FRAME_HEADER_BYTES);
    photo.addOp("tone_curve", {
      red: [
        { x: 0, y: 0.3 },
        { x: 1, y: 1 },
      ],
    });
    const after = new Uint8Array(renderFrame(8, 4, 2, 1, photo.stack), FRAME_HEADER_BYTES);
    expect(after[0]).toBeGreaterThan(Number(before[0]));
    expect(after[1]).toBe(Number(before[1]));
    expect(after[2]).toBe(Number(before[2]));
  });

  test("the parametric regions reach the pixels too", () => {
    const photo = new PhotoState();
    const before = new Uint8Array(renderFrame(8, 4, 1, 1, photo.stack), FRAME_HEADER_BYTES);
    photo.addOp("tone_curve", { shadows: 100, shadowSplit: 25, midtoneSplit: 50 });
    const after = new Uint8Array(renderFrame(8, 4, 2, 1, photo.stack), FRAME_HEADER_BYTES);
    expect(after[0]).toBeGreaterThan(Number(before[0]));
  });
});

/** Minimal JSON-RPC client over the mock's socket, for the end-to-end catalog tests. */
class TestClient {
  readonly notifications: { method: string; params: Record<string, unknown> }[] = [];
  readonly frames: ArrayBuffer[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcReply) => void>();

  private constructor(private readonly socket: WebSocket) {}

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.binaryType = "arraybuffer";
    const client = new TestClient(socket);
    socket.addEventListener("message", (event) => client.receive(event.data));
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    return client;
  }

  call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result as T);
      });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Resolves once a notification the predicate accepts has arrived. */
  async waitFor<T = Record<string, unknown>>(
    method: string,
    accept: (params: Record<string, unknown>) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const match = this.notifications.find(
        (entry) => entry.method === method && accept(entry.params),
      );
      if (match) return match.params as T;
      await Bun.sleep(10);
    }
    throw new Error(`no ${method} notification matched within 5s`);
  }

  close(): void {
    this.socket.close();
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.frames.push(data);
      return;
    }
    const message: RpcReply = JSON.parse(String(data));
    if (message.id !== undefined) {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
      return;
    }
    if (message.method)
      this.notifications.push({ method: message.method, params: message.params ?? {} });
  }
}

interface RpcReply {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

describe("catalog over the socket", () => {
  test("import walks the directory, reports progress and ends with the photos listed", async () => {
    const root = mkdtempSync(join(tmpdir(), "latent-import-"));
    for (const name of ["a.arw", "b.nef", "c.dng", "skip.txt"]) {
      writeFileSync(join(root, name), "");
    }
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const started = await client.call<{ jobId: number }>("catalog.import", { paths: [root] });
      expect(started.jobId).toBeGreaterThan(0);

      const finished = await client.waitFor("job.progress", (params) => params.finished === true);
      expect(finished).toMatchObject({ jobId: started.jobId, kind: "import", total: 3, done: 3 });
      await client.waitFor("catalog.changed", (params) => params.reason === "import");

      const listed = await client.call<CatalogListResult>("catalog.list", { sort: "filename" });
      expect(listed.total).toBe(3);
      expect(listed.photos.map((photo) => photo.filename)).toEqual(["a.arw", "b.nef", "c.dng"]);

      // photo.open on an imported file reuses that row's id.
      const opened = await client.call<PhotoOpenResult>("photo.open", {
        path: join(root, "a.arw"),
      });
      expect(opened.photoId).toBe(listed.photos[0]?.photoId ?? -1);

      const rated = await client.call<CatalogPhoto>("catalog.setRating", {
        photoId: opened.photoId,
        rating: 4,
      });
      expect(rated.rating).toBe(4);
      await client.waitFor("catalog.changed", (params) => params.reason === "rating");

      const thumbnail = await client.call<{ width: number }>("catalog.thumbnail", {
        photoId: opened.photoId,
        size: 128,
      });
      expect(thumbnail.width).toBeGreaterThan(0);
      expect(client.frames).toHaveLength(1);
      const header = new DataView(client.frames[0] ?? new ArrayBuffer(0));
      expect(header.getUint32(16, true)).toBe(opened.photoId);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("python.run applies an exposure assignment and publishes it as source python", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/x.arw" });
      const result = await client.call<PythonRunResult>("python.run", {
        code: "latent.photo.develop.exposure = 1.0",
        photoId: opened.photoId,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("1.00");

      const changed = await client.waitFor<StackChangedParams>(
        "stack.changed",
        (params) => params.source === "python",
      );
      expect(changed.stack[0]?.op).toBe("exposure");
      expect(changed.stack[0]?.params.value).toBe(1);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("photo.open carries the catalog row, so no catalog.get follows it", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/x.arw" });
      expect(opened.catalog?.photoId).toBe(opened.photoId);
      expect(opened.catalog?.filename).toBe("x.arw");
      expect(opened.catalog?.camera).toBe(opened.camera);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("catalog.thumbnails sends one frame per photo and lists what it could not send", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const ids: number[] = [];
      for (const name of ["a", "b", "c"]) {
        const opened = await client.call<PhotoOpenResult>("photo.open", {
          path: `/photos/${name}.arw`,
        });
        ids.push(opened.photoId);
      }
      const batch = await client.call<CatalogThumbnailsResult>("catalog.thumbnails", {
        photoIds: [...ids, ids[0], 9999],
        size: 64,
      });
      // The duplicate is collapsed, the unknown id is missing, and every frame arrived
      // before this result.
      expect(batch).toEqual({ requested: 4, sent: 3, missing: [9999] });
      expect(client.frames).toHaveLength(3);
      const targets = client.frames.map((frame) => new DataView(frame).getUint32(16, true));
      expect(targets).toEqual(ids);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("catalog.remove drops rows, publishes the reason and leaves the files alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "latent-remove-"));
    for (const name of ["a.arw", "b.arw"]) writeFileSync(join(root, name), "");
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      await client.call("catalog.import", { paths: [root] });
      await client.waitFor("job.progress", (params) => params.finished === true);
      const listed = await client.call<CatalogListResult>("catalog.list", { sort: "filename" });
      const [first] = listed.photos;

      const removed = await client.call<CatalogRemoveResult>("catalog.remove", {
        photoIds: [first?.photoId ?? 0, 4242],
      });
      expect(removed.removed).toBe(1);
      await client.waitFor("catalog.changed", (params) => params.reason === "remove");
      expect((await client.call<CatalogListResult>("catalog.list", {})).total).toBe(1);
      expect(existsSync(join(root, "a.arw"))).toBe(true);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("catalog.list narrows by photoIds and by a case-insensitive query", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const ids: number[] = [];
      for (const name of ["alpha", "beta", "gamma"]) {
        const opened = await client.call<PhotoOpenResult>("photo.open", {
          path: `/photos/${name}.arw`,
        });
        ids.push(opened.photoId);
      }
      const picked = await client.call<CatalogListResult>("catalog.list", {
        photoIds: [ids[2], ids[0]],
        sort: "filename",
      });
      expect(picked.photos.map((photo) => photo.filename)).toEqual(["alpha.arw", "gamma.arw"]);

      const searched = await client.call<CatalogListResult>("catalog.list", { query: "BET" });
      expect(searched.photos.map((photo) => photo.filename)).toEqual(["beta.arw"]);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("job.cancel stops an import between ticks and the job ends as cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "latent-cancel-"));
    for (let index = 0; index < 60; index++) {
      writeFileSync(join(root, `f${String(index).padStart(3, "0")}.arw`), "");
    }
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const started = await client.call<{ jobId: number }>("catalog.import", { paths: [root] });
      const cancelled = await client.call<JobCancelResult>("job.cancel", {
        jobId: started.jobId,
      });
      expect(cancelled.cancelled).toBe(true);

      const last = await client.waitFor<JobProgressParams>(
        "job.progress",
        (params) => params.finished === true,
      );
      expect(last.state).toBe("cancelled");
      expect(last.done).toBeLessThan(last.total);
      // Cancelling twice, or cancelling a job that is over, is false rather than an error.
      expect(
        (await client.call<JobCancelResult>("job.cancel", { jobId: started.jobId })).cancelled,
      ).toBe(false);
      expect((await client.call<JobCancelResult>("job.cancel", { jobId: 999 })).cancelled).toBe(
        false,
      );
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("python.run streams its output before the result carries it", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/x.arw" });
      const result = await client.call<PythonRunResult>("python.run", {
        code: "latent.photo.develop.exposure = 1.0",
        photoId: opened.photoId,
        timeoutMs: 5000,
      });
      expect(result.runId).toBeGreaterThan(0);

      // Already in the log when the result resolved: the notification went out first.
      const streamed = client.notifications.filter((entry) => entry.method === "python.output");
      expect(streamed).toHaveLength(1);
      expect(streamed[0]?.params).toEqual({
        runId: result.runId,
        stream: "stdout",
        text: result.stdout,
      });

      const failed = await client.call<PythonRunResult>("python.run", {
        code: "latent.photo.develop.exposure = 1.0",
      });
      const errors = client.notifications.filter(
        (entry) => entry.method === "python.output" && entry.params.stream === "stderr",
      );
      expect(errors[0]?.params).toEqual({
        runId: failed.runId,
        stream: "stderr",
        text: failed.stderr,
      });
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("engine.hello names the catalog it opened and has no MCP url", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const hello = await client.call<EngineHelloResult>("engine.hello", { client: "test" });
      expect(hello.catalogPath).toMatch(/catalog\.db$/);
      // The mock has no interpreter, the same shape a client sees from latentd --no-mcp.
      expect(hello.mcpUrl).toBeUndefined();
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("an import names its thumbnail job, which reports with parentJobId", async () => {
    const root = mkdtempSync(join(tmpdir(), "latent-thumbjob-"));
    for (const name of ["a.arw", "b.arw"]) writeFileSync(join(root, name), "");
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const started = await client.call<CatalogImportResult>("catalog.import", { paths: [root] });
      expect(started.thumbnailJobId).toBeGreaterThan(started.jobId);

      const thumbnails = await client.waitFor<JobProgressParams>(
        "job.progress",
        (params) => params.jobId === started.thumbnailJobId,
      );
      expect(thumbnails.parentJobId).toBe(started.jobId);
      expect(thumbnails).toMatchObject({ kind: "thumbnails", finished: true, state: "done" });
      expect(thumbnails.done).toBe(2);
      // The import's own progress never claims a parent.
      const imports = client.notifications.filter(
        (entry) => entry.method === "job.progress" && entry.params.jobId === started.jobId,
      );
      expect(imports.every((entry) => entry.params.parentJobId === undefined)).toBe(true);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("an import that finds nothing still closes the thumbnail job it promised", async () => {
    const root = mkdtempSync(join(tmpdir(), "latent-nothumbs-"));
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const started = await client.call<CatalogImportResult>("catalog.import", { paths: [root] });
      const thumbnails = await client.waitFor<JobProgressParams>(
        "job.progress",
        (params) => params.jobId === started.thumbnailJobId,
      );
      expect(thumbnails).toMatchObject({ finished: true, total: 0, parentJobId: started.jobId });
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("python.finished closes the stream before the result arrives", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/x.arw" });
      const result = await client.call<PythonRunResult>("python.run", {
        code: "latent.photo.develop.exposure = 1.0",
        photoId: opened.photoId,
      });
      // Already logged when the result resolved, and after the run's last output chunk.
      const run = client.notifications.filter((entry) => entry.method.startsWith("python."));
      expect(run.map((entry) => entry.method)).toEqual(["python.output", "python.finished"]);
      const finished = run[1]?.params as unknown as PythonFinishedParams;
      expect(finished.runId).toBe(result.runId ?? 0);
      expect(finished.ok).toBe(true);
      expect(finished.durationMs).toBe(result.durationMs ?? -1);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("view.render reports the revision its pixels came from", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/x.arw" });
      const view = await client.call<ViewOpenResult>("view.open", {
        photoId: opened.photoId,
        width: 32,
        height: 16,
      });
      const first = await client.call<ViewRenderResult>("view.render", { viewId: view.viewId });
      const edited = await client.call<StackGetResult>("op.add", {
        photoId: opened.photoId,
        op: "exposure",
        params: { value: 1 },
      });
      const second = await client.call<ViewRenderResult>("view.render", { viewId: view.viewId });
      expect(second.revision).toBe(edited.revision);
      expect(second.revision).toBeGreaterThan(first.revision);
      // seq counts frames, revision counts states: they are not the same number.
      expect(second.seq).toBe(first.seq + 1);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("stack.changed names the client, one step finer than the source", async () => {
    const engine = startMockEngine(0);
    const writer = await TestClient.connect(engine.port);
    const observer = await TestClient.connect(engine.port);
    try {
      const opened = await writer.call<PhotoOpenResult>("photo.open", { path: "/photos/x.arw" });
      await writer.call("op.add", { photoId: opened.photoId, op: "contrast", params: {} });
      const own = await writer.waitFor<StackChangedParams>(
        "stack.changed",
        (params) => params.source === "ui",
      );
      const seen = await observer.waitFor<StackChangedParams>(
        "stack.changed",
        (params) => params.source !== "ui",
      );
      expect(own.client).toBe("ui");
      expect(seen.client).toBe("mcp:run_python");
      expect(own.revision).toBe(seen.revision);
    } finally {
      writer.close();
      observer.close();
      engine.stop();
    }
  });

  test("a photoId too large for an LTHM frame is refused, not truncated", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const tooBig = 0x1_0000_0000;
      const failed = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);
      const single = await client.call("catalog.thumbnail", { photoId: tooBig }).catch(failed);
      const batch = await client.call("catalog.thumbnails", { photoIds: [tooBig] }).catch(failed);
      expect(single).toMatch(/thumbnail frame limit/);
      expect(batch).toMatch(/thumbnail frame limit/);
      // Neither call may have put a frame with a wrapped-around target on the wire.
      expect(client.frames).toHaveLength(0);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("ops.describe carries the Lightroom section, order and display hints", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const described = await client.call<OpsDescribeResult>("ops.describe", {});
      for (const op of described.ops) {
        expect(op.section).toBeDefined();
        expect(op.order).toBeGreaterThan(0);
        // An enum is drawn as a select from `values`; everything else says which control
        // and which track gradient it wants, exactly as the engine's registry does.
        for (const param of op.params) {
          if (param.type === "enum") expect(param.values?.length).toBeGreaterThan(0);
          else expect(param.display?.kind).toBeDefined();
        }
      }
      // Lightroom's panel order, so a generated panel can render the list as it arrives.
      const sections = described.ops.map((op) => op.section);
      expect([...new Set(sections)]).toEqual([
        "Light",
        "Color",
        "Effects",
        "Detail",
        "Optics",
        "Geometry",
        // Generative sorts after Lightroom's own panels: Lightroom has no such section.
        "Generative",
      ]);
      const whiteBalance = described.ops.find((op) => op.name === "white_balance");
      expect(whiteBalance?.section).toBe("Color");
      expect(whiteBalance?.params[0]?.name).toBe("mode");
      expect(whiteBalance?.params[2]?.display).toEqual({ kind: "kelvin", tint: "temperature" });
      expect(described.ops.find((op) => op.name === "exposure")?.order).toBe(1);
      expect(described.ops.find((op) => op.name === "color_mixer")?.params).toHaveLength(24);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("a script that needs a photo fails with stderr instead of throwing", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const result = await client.call<PythonRunResult>("python.run", {
        code: "latent.photo.develop.exposure = 1.0",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("no photo is open");

      const canned = await client.call<PythonRunResult>("python.run", { code: "latent.undo()" });
      expect(canned).toMatchObject({ ok: true, value: "None" });
    } finally {
      client.close();
      engine.stop();
    }
  });
});

/** The error message a call came back with; fails loudly when the call succeeded. */
async function failureOf(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "the call succeeded",
    (error: Error) => error.message,
  );
}

/** An op with one mask component, the shape the UI writes through `stack.set`. */
function maskedStack(component: MaskComponent, opacity?: number): Op[] {
  const op: Op = {
    id: "op1",
    op: "exposure",
    params: { value: 1 },
    enabled: true,
    mask: { components: [component] },
  };
  if (opacity !== undefined) op.opacity = opacity;
  return [op];
}

const radial: MaskComponent = {
  id: "m1",
  kind: "radial",
  mode: "add",
  feather: 20,
  params: { center: [0.5, 0.5], radius: [0.3, 0.3], angle: 0 },
};

async function openMasked(
  client: TestClient,
  component: MaskComponent = radial,
  opacity?: number,
): Promise<{ photoId: number; viewId: number }> {
  const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/mask.arw" });
  const view = await client.call<ViewOpenResult>("view.open", {
    photoId: opened.photoId,
    width: 600,
    height: 400,
  });
  await client.call<StackGetResult>("stack.set", {
    photoId: opened.photoId,
    stack: maskedStack(component, opacity),
  });
  return { photoId: opened.photoId, viewId: view.viewId };
}

describe("masks over the socket", () => {
  test("a stack write carries mask and opacity through the stack, history and JSON", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const { photoId } = await openMasked(client, radial, 60);
      const stored = await client.call<StackGetResult>("stack.get", { photoId });
      expect(stored.stack[0]?.opacity).toBe(60);
      expect(stored.stack[0]?.mask?.components[0]).toMatchObject({ id: "m1", kind: "radial" });

      // The sidecar is JSON of exactly this: a round trip must not lose the mask.
      expect(JSON.parse(JSON.stringify(stored.stack))).toEqual(stored.stack);

      // op.update keeps them: only `params` and `enabled` are its business.
      const updated = await client.call<StackGetResult>("op.update", {
        photoId,
        opId: "op1",
        params: { value: 2 },
        enabled: false,
      });
      expect(updated.stack[0]).toMatchObject({ opacity: 60, enabled: false });
      expect(updated.stack[0]?.mask?.components).toHaveLength(1);

      const undone = await client.call<StackGetResult>("history.undo", { photoId });
      expect(undone.stack[0]?.params.value).toBe(1);
      expect(undone.stack[0]?.mask?.components).toHaveLength(1);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("op.update writes the mask whole, clears it with null and sets the opacity", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const opened = await client.call<PhotoOpenResult>("photo.open", { path: "/photos/m.arw" });
      const photoId = opened.photoId;
      const added = await client.call<StackGetResult>("op.add", {
        photoId,
        op: "exposure",
        params: { value: 1 },
        mask: { components: [radial] },
        opacity: 80,
      });
      const opId = added.stack[0]?.id ?? "";
      expect(added.stack[0]).toMatchObject({ opacity: 80 });
      expect(added.stack[0]?.mask?.components[0]?.state).toBe("ready");

      // A second component replaces the list: never a merge by index.
      const brush: MaskComponent = { id: "b1", kind: "brush", mode: "subtract" };
      const replaced = await client.call<StackGetResult>("op.update", {
        photoId,
        opId,
        params: {},
        mask: { components: [radial, brush] },
        opacity: 55,
      });
      expect(replaced.stack[0]?.mask?.components.map((entry) => entry.id)).toEqual(["m1", "b1"]);
      expect(replaced.stack[0]?.opacity).toBe(55);

      // A transient tick leaves no snapshot: one undo goes back past the whole drag.
      await client.call<StackGetResult>("op.update", {
        photoId,
        opId,
        params: {},
        opacity: 40,
        transient: true,
      });
      const committed = await client.call<StackGetResult>("op.update", {
        photoId,
        opId,
        params: {},
        opacity: 30,
      });
      expect(committed.stack[0]?.opacity).toBe(30);
      const undone = await client.call<StackGetResult>("history.undo", { photoId });
      expect(undone.stack[0]?.opacity).toBe(55);

      const cleared = await client.call<StackGetResult>("op.update", {
        photoId,
        opId,
        params: {},
        mask: null,
      });
      expect(cleared.stack[0]?.mask).toBeUndefined();
      expect(cleared.stack[0]?.opacity).toBe(55);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("mask.preview sends one LMSK frame before its result", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const { photoId, viewId } = await openMasked(client);
      const preview = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(client.frames).toHaveLength(1);
      const frame = client.frames[0] ?? new ArrayBuffer(0);
      const header = parseFrameHeader(frame);
      expect(header).toMatchObject({ magic: "LMSK", target: viewId, format: 2 });
      // r8: one byte per pixel, and the result's size is the frame's.
      expect(frame.byteLength - FRAME_HEADER_BYTES).toBe(header.width * header.height);
      expect(preview.width).toBe(header.width);
      // π·0.3² of the frame, softened by the feather.
      expect(preview.coverage).toBeGreaterThan(0.2);
      expect(preview.coverage).toBeLessThan(0.32);

      // One component's own raster instead of the combined mask.
      const single = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        componentId: "m1",
        viewId,
      });
      expect(single.coverage).toBeCloseTo(preview.coverage ?? 0, 3);
      expect(client.frames).toHaveLength(2);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("mask.stroke appends to a brush, and one pointer-down undoes as one step", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const brush: MaskComponent = {
        id: "b1",
        kind: "brush",
        mode: "add",
        feather: 30,
        params: { size: 0.2, flow: 100 },
      };
      const { photoId, viewId } = await openMasked(client, brush);
      const empty = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(empty.coverage).toBe(0);

      // A drag: transient segments, then the committed one that closes the stroke.
      for (const x of [0.3, 0.4, 0.5]) {
        await client.call<StackGetResult>("mask.stroke", {
          photoId,
          opId: "op1",
          componentId: "b1",
          points: [[x, 0.5]],
          transient: true,
        });
      }
      const committed = await client.call<StackGetResult>("mask.stroke", {
        photoId,
        opId: "op1",
        componentId: "b1",
        points: [[0.6, 0.5]],
      });
      const painted = committed.stack[0]?.mask?.components[0];
      expect(painted?.params?.strokeData).toHaveLength(4);
      // The stroke reference the contract describes is there; the points are the engine's.
      expect(painted?.params?.strokes).toBe("brush/b1.bin");

      const drawn = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(drawn.coverage).toBeGreaterThan(0.02);

      const undone = await client.call<StackGetResult>("history.undo", { photoId });
      expect(undone.stack[0]?.mask?.components[0]?.params?.strokeData ?? []).toHaveLength(0);
      const cleared = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(cleared.coverage).toBe(0);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("a stroke aimed at a component that is not a brush is refused", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const { photoId } = await openMasked(client);
      const refused = await failureOf(
        client.call("mask.stroke", {
          photoId,
          opId: "op1",
          componentId: "m1",
          points: [[0.5, 0.5]],
        }),
      );
      expect(refused).toContain("not a brush");
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("mask.detect runs as a job: pending, progress, then a raster to preview", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const subject: MaskComponent = { id: "s1", kind: "subject", mode: "add" };
      const { photoId, viewId } = await openMasked(client, subject);
      const started = await client.call<MaskDetectResult>("mask.detect", {
        photoId,
        opId: "op1",
        componentId: "s1",
      });
      expect(started.jobId).toBeGreaterThan(0);

      // The component was already `pending` the moment it existed; the job puts its id on it.
      const pending = await client.waitFor<StackChangedParams>(
        "stack.changed",
        (params) => componentState(params) === "pending" && componentJob(params) !== undefined,
      );
      expect(pending.stack[0]?.mask?.components[0]?.jobId).toBe(started.jobId);
      // While it pends the component contributes nothing, and has no raster of its own.
      const blank = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(blank.coverage).toBe(0);
      const refused = await failureOf(
        client.call("mask.preview", { photoId, opId: "op1", componentId: "s1", viewId }),
      );
      expect(refused).toContain("pending");

      const done = await client.waitFor<JobProgressParams>(
        "job.progress",
        (params) => params.jobId === started.jobId && params.finished === true,
      );
      expect(done.kind).toBe("mask");
      await client.waitFor("stack.changed", (params) => componentState(params) === "ready");

      const detected = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(detected.coverage).toBeGreaterThan(0.1);
      const ready = await client.call<StackGetResult>("stack.get", { photoId });
      expect(ready.stack[0]?.mask?.components[0]?.params?.model).toBe("sam2-mock");
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("a text component without a prompt fails, and the job says why", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const text: MaskComponent = { id: "t1", kind: "text", mode: "add", params: { prompt: "" } };
      const { photoId } = await openMasked(client, text);
      const started = await client.call<MaskDetectResult>("mask.detect", {
        photoId,
        opId: "op1",
        componentId: "t1",
      });
      const failed = await client.waitFor<JobProgressParams>(
        "job.progress",
        (params) => params.jobId === started.jobId && params.finished === true,
      );
      expect(failed.state).toBe("error");
      expect(failed.error).toContain("no prompt");
      await client.waitFor("stack.changed", (params) => componentState(params) === "failed");

      // A component the mask does not have is not something to detect.
      const missing = await failureOf(
        client.call("mask.detect", { photoId, opId: "op1", componentId: "nope" }),
      );
      expect(missing).toContain("unknown mask component");
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("a whole-stack write from the UI keeps the strokes the engine owns", async () => {
    const engine = startMockEngine(0);
    const client = await TestClient.connect(engine.port);
    try {
      const brush: MaskComponent = { id: "b1", kind: "brush", mode: "add", params: { size: 0.3 } };
      const { photoId, viewId } = await openMasked(client, brush);
      await client.call<StackGetResult>("mask.stroke", {
        photoId,
        opId: "op1",
        componentId: "b1",
        points: [[0.5, 0.5]],
      });
      const painted = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(painted.coverage).toBeGreaterThan(0);

      // The UI writes the mask it was shown — a copy with no strokes in it — to change the
      // feather. The engine's stroke list survives that.
      await client.call<StackGetResult>("stack.set", {
        photoId,
        stack: maskedStack({ ...brush, feather: 10 }),
      });
      const after = await client.call<MaskPreviewResult>("mask.preview", {
        photoId,
        opId: "op1",
        viewId,
      });
      expect(after.coverage).toBeGreaterThan(0);
    } finally {
      client.close();
      engine.stop();
    }
  });

  test("ops.describe marks the develop ops maskable and the geometry ops not", () => {
    const byName = new Map(opDefinitions.map((op) => [op.name, op]));
    expect(byName.get("exposure")?.maskable).toBe(true);
    expect(byName.get("clarity")?.maskable).toBe(true);
    expect(byName.get("crop")?.maskable).toBe(false);
    expect(byName.get("transform")?.maskable).toBe(false);
  });
});

/** The state of the first mask component in a `stack.changed`, for `waitFor`. */
function componentState(params: Record<string, unknown>): string | undefined {
  const stack = params.stack as Op[] | undefined;
  return stack?.[0]?.mask?.components[0]?.state;
}

function componentJob(params: Record<string, unknown>): number | undefined {
  const stack = params.stack as Op[] | undefined;
  return stack?.[0]?.mask?.components[0]?.jobId;
}

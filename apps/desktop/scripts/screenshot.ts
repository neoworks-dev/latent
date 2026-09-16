// Drives the real app and saves a PNG: the mock engine, Vite for the renderer, Electron
// under Playwright. Proof that the generated panels render and that dragging a slider
// reaches the engine and comes back as a frame.
//
//   node apps/desktop/scripts/screenshot.ts [--out /tmp/latent-ui.png] [--engine mock|real]
//                                           [--photo /path/to/raw]
//                                     [--flow slider|panels|curve|mixer|masks|catalog|library|latency]
//                                           [--dir <import directory>]
//
// `--engine real` spawns engine/build/dev/latentd instead of the mock; pair it with a real
// raw file via `--photo` (default: the mock's fake path).
//
// `--flow catalog` drives the library instead: import, batch thumbnails for the page,
// rating, flag, a Delete that removes rows from the catalog, a script in the Python console
// with its streamed output, and a second import cancelled from the job status line. It
// imports `--dir` (default ~/Downloads, non-recursive) plus a generated fixture of empty
// raw files, so the strip has more than one cell even on a machine with one raw lying
// around.
//
// `--flow latency` holds the exposure slider down for a long drag with `?frametrace=25`
// set, so the renderer prints a p50/p95 stage breakdown of the preview path.
//
// `--flow panels` exercises the rest of the panel column's gestures: a click on the track
// that jumps, a scrub on the value readout, arrow keys on the focused slider, a
// double-click that resets to the default, and folding a section away.
//
// `--flow curve` drives the hand-built tone curve: the Point/RGB tab, a click that adds a
// control point, a drag that moves it, one undo that takes the whole drag, a second point
// on the Red channel, then the Parametric tab's region slider and split handles. The
// engine's own render is digested before and after, so "the curve reached the pixels" is
// asserted on the frame the engine produced rather than on the canvas.
//
// `--flow mixer` drives the hand-built colour mixer: the Hue tab's eight band rows, a drag
// on one of them, the Luminance tab, and the All grid with every band's three sliders.
//
// `--flow masks` drives Masks and Layers: a radial dragged on the viewer's overlay, the
// LMSK raster drawn back as a red tint, three brush strokes that each grow the coverage,
// one undo that takes a whole stroke, layer opacity, and the Layers column's thumbnails,
// drag-reorder and eye.
//
// Node, not bun: Playwright's `_electron.launch` never resolves under bun 1.3 (it hangs
// after attaching to the inspector), while node runs it fine. Everything else is bun.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..", "..");
const editorDir = join(repoDir, "apps", "editor");
function argument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : String(process.argv[index + 1]);
}

const flow = argument("--flow", "slider");
const flowOutputs: Record<string, string> = {
  catalog: "/tmp/latent-catalog.png",
  masks: "/tmp/latent-masks.png",
  curve: "/tmp/latent-curve.png",
  mixer: "/tmp/latent-mixer.png",
};
const defaultOutput = flowOutputs[flow] ?? "/tmp/latent-ui.png";
const outputPath = argument("--out", defaultOutput);
const externalPath = outputPath.replace(/\.png$/, "-external.png");
const engineKind = argument("--engine", "mock");
const photoArgument = argument("--photo", "/tmp/demo.raf");
const importDir = argument("--dir", join(homedir(), "Downloads"));
// The real engine gets its own catalog, config and cache under /tmp so a screenshot run
// never writes into ~/.local/share/latent or ~/.config/latent.
const scratchDir = mkdtempSync(join(tmpdir(), "latent-shot-"));
const realEngine = {
  command: [
    join(repoDir, "engine", "build", "dev", "latentd"),
    "--port",
    "0",
    "--catalog",
    join(scratchDir, "catalog.db"),
  ],
  environment: {
    XDG_DATA_HOME: join(scratchDir, "data"),
    XDG_CONFIG_HOME: join(scratchDir, "config"),
    XDG_CACHE_HOME: join(scratchDir, "cache"),
  },
};
const mockEngine = { command: ["bun", join(repoDir, "tools", "mock-engine.ts")], environment: {} };
const engine = engineKind === "real" ? realEngine : mockEngine;

// Sidecars live next to the raw, so the real engine edits a scratch copy of `--photo`:
// a run never inherits the previous run's stack, and the original's sidecar stays untouched.
function scratchCopy(source: string): string {
  const target = join(scratchDir, basename(source));
  copyFileSync(source, target);
  return target;
}
const photoPath = engineKind === "real" ? scratchCopy(photoArgument) : photoArgument;

/**
 * Two directories of empty files with raw extensions. The mock engine catalogs paths and
 * synthesises the metadata, so the bytes do not matter — this only guarantees a filmstrip
 * with enough cells to look at.
 */
function writeFixturePhotos(): string[] {
  const root = "/tmp/latent-catalog-photos";
  const folders = [join(root, "trip"), join(root, "city")];
  const names = ["DSCF0101.RAF", "DSCF0102.RAF", "DSCF0103.RAF", "DSC_0421.NEF", "IMG_8802.CR3"];
  for (const folder of folders) {
    mkdirSync(folder, { recursive: true });
    for (const name of names) writeFileSync(join(folder, name), "");
  }
  return folders;
}

/**
 * Enough raws that an import runs for several ticks — long enough to press Cancel while
 * the job is still going. Empty files again; the mock never opens them.
 */
function writeBulkFixture(): string {
  const root = "/tmp/latent-catalog-bulk";
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < 300; index++) {
    writeFileSync(join(root, `BULK${String(index).padStart(4, "0")}.ARW`), "");
  }
  return root;
}

/** Runs in the page: does the control's readout show this value yet? */
function readoutIs({ op, text }: { op: string; text: string }): boolean {
  return document.querySelector(`[data-op="${op}"] [data-readout]`)?.textContent === text;
}

/** Runs in the page: how many photos does the filmstrip header say the list has? */
function photoCountIs(expected: number): boolean {
  return document.querySelector(`[data-photo-count="${expected}"]`) !== null;
}

interface RpcAnswer<T> {
  result: T;
  /** Binary frames that arrived before the result — LTHM thumbnails, LFRM renders. */
  frames: ArrayBuffer[];
}

/**
 * One JSON-RPC call on a socket of our own, the way a script or an MCP client makes it.
 * The UI is not involved, so it proves the engine's side of a method on its own.
 */
async function engineCall<T>(
  url: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcAnswer<T>> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const frames: ArrayBuffer[] = [];
  const answered = new Promise<RpcAnswer<T>>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        frames.push(event.data);
        return;
      }
      const message: { id?: number; result?: unknown } = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      resolve({ result: message.result as T, frames });
    });
  });
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const answer = await answered;
  socket.close();
  return answer;
}

/** The LFRM/LTHM header, ahead of the pixels (protocol/frames.md). */
const FRAME_HEADER_BYTES = 32;

/**
 * A cheap digest of one frame's pixels. The viewer's canvas is WebGL with no preserved
 * drawing buffer, so "did the render change?" is asked of the engine rather than read back
 * off the canvas: two renders of the same stack digest the same, two of different stacks
 * do not.
 */
function frameDigest(frame: ArrayBuffer | undefined): string {
  if (!frame) return "";
  const pixels = new Uint8Array(frame, FRAME_HEADER_BYTES);
  let hash = 2166136261;
  for (const byte of pixels) {
    hash = Math.imul(hash ^ byte, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Renders one small proxy of the photo as it stands and digests it. */
async function renderDigest(url: string, photoId: number): Promise<string> {
  const view = await engineCall<{ viewId: number }>(url, "view.open", {
    photoId,
    width: 240,
    height: 160,
  });
  const viewId = view.result.viewId;
  const rendered = await engineCall<{ seq: number }>(url, "view.render", { viewId });
  await engineCall(url, "view.close", { viewId });
  return frameDigest(rendered.frames[0]);
}

/** The control points one channel of the open photo's `tone_curve` op carries. */
async function curvePointsOf(
  url: string,
  photoId: number,
  channel: string,
): Promise<{ x: number; y: number }[]> {
  const state = await engineCall<{ stack: { op: string; params: Record<string, unknown> }[] }>(
    url,
    "stack.get",
    { photoId },
  );
  const entry = state.result.stack.find((op) => op.op === "tone_curve");
  const points = entry?.params[channel];
  if (!Array.isArray(points)) return [];
  return points as { x: number; y: number }[];
}

const children: ChildProcess[] = [];

function start(command: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): ChildProcess {
  const [executable, ...args] = command;
  // Own process group: bun and vite both fork, and killing the wrapper would leave the
  // real server holding its port.
  const child = spawn(String(executable), args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  children.push(child);
  return child;
}

/** Resolves with the first stdout line matching `pattern`, echoing everything it reads. */
function waitForLine(
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no line matching ${pattern} in ${timeoutMs}ms`)),
      timeoutMs,
    );
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      process.stdout.write(chunk);
      const match = pattern.exec(buffered);
      if (!match) return;
      clearTimeout(timer);
      resolve(match);
    });
    child.on("exit", (code) => reject(new Error(`process exited with ${code} before listening`)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no TCP port from the probe server"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function stopChildren(): void {
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
}

process.on("exit", stopChildren);

const engineProcess = start(engine.command, repoDir, engine.environment);

const [, enginePort] = await waitForLine(
  engineProcess,
  /listening on ws:\/\/127\.0\.0\.1:(\d+)/,
  20_000,
);
const engineUrl = `ws://127.0.0.1:${enginePort}`;

const build = spawnSync(join(desktopDir, "node_modules", ".bin", "electron-vite"), ["build"], {
  cwd: desktopDir,
  stdio: ["ignore", "inherit", "inherit"],
});
if (build.status !== 0) {
  stopChildren();
  throw new Error("electron-vite build failed");
}

// A fixed free port, because Vite's own port scan can sit behind other dev servers.
const editorPort = await freePort();
const editor = start(
  ["bun", "--bun", "vite", "dev", "--port", String(editorPort), "--strictPort"],
  editorDir,
);
await waitForLine(editor, new RegExp(`http://localhost:${editorPort}/`), 60_000);
const editorUrl = `http://localhost:${editorPort}`;

// Dev hooks instead of native dialogs: `?photo=` opens one file, `?import=` imports
// directories into the catalog.
function pageQuery(): string {
  if (flow === "catalog") {
    const paths = [...writeFixturePhotos(), importDir].join(",");
    return `?import=${encodeURIComponent(paths)}`;
  }
  const photo = `?photo=${encodeURIComponent(photoPath)}`;
  return flow === "latency" ? `${photo}&frametrace=25` : photo;
}

const app = await electron.launch({
  executablePath: join(repoDir, "node_modules", "electron", "dist", "electron"),
  args: [desktopDir],
  cwd: repoDir,
  env: {
    ...process.env,
    LATENT_ENGINE_URL: `ws://127.0.0.1:${enginePort}`,
    LATENT_EDITOR_URL: `${editorUrl}/${pageQuery()}`,
  },
});

const window = await app.firstWindow();
window.on("console", (message) => console.log(`[renderer] ${message.text()}`));
window.on("pageerror", (error) => console.log(`[renderer] ${error.message}`));

/**
 * `page.screenshot` captures the window's surface and waits for the compositor to hand it
 * a frame. With other GPU clients on the machine that wait sometimes never ends, and the
 * viewer's canvas is not repainting on its own to wake it. The fallback asks the renderer's
 * own compositor for the same pixels (`fromSurface: false`). Driver-side only.
 */
async function capture(path: string): Promise<void> {
  const captured = await window
    .screenshot({ path, timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (captured) return;
  const session = await window.context().newCDPSession(window);
  const shot = await session.send("Page.captureScreenshot", { format: "png", fromSurface: false });
  await session.detach();
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  console.log(`[shot] surface capture stalled; ${path} came from the renderer instead`);
}
if (flow === "catalog") {
  // The import job walks the directories and ticks job.progress; the filmstrip fills in
  // as catalog.changed lands and every thumbnail arrives as its own LTHM frame.
  await window.waitForSelector('[data-pane="filmstrip"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const running = document.querySelector('[data-jobs-running="0"]');
      return running !== null && document.querySelectorAll("[data-photo-id] img").length >= 5;
    },
    null,
    { timeout: 60_000 },
  );
  // job.progress reports "finished" before the last catalog.changed has been re-listed;
  // the state debounces that by 60ms, so give it a beat before reading the count.
  await window.waitForTimeout(500);
  const imported = await window.locator("[data-photo-count]").innerText();
  console.log(`[shot] import finished, filmstrip shows ${imported}`);

  // Every cell above was filled from one `catalog.thumbnails` call for the page, not one
  // call per cell — the filmstrip only asks when the page changes.
  const strip = window.locator('[data-pane="filmstrip"]');
  const filled = await strip.getAttribute("data-thumbnails-loaded");
  const cells = await window.locator("[data-photo-id]").count();
  console.log(`[shot] batch thumbnails: ${filled} of ${cells} cells filled from one page call`);

  // The same call from a socket of our own, with one id the catalog does not have: the
  // frames come first, the unknown id comes back in `missing`, and it is not an error.
  const pageIds = await window
    .locator("[data-photo-id]")
    .evaluateAll((nodes) =>
      nodes.slice(0, 3).map((node) => Number(node.getAttribute("data-photo-id"))),
    );
  const batch = await engineCall<{ requested: number; sent: number; missing: number[] }>(
    engineUrl,
    "catalog.thumbnails",
    { photoIds: [...pageIds, 999_999], size: 96 },
  );
  console.log(
    `[shot] catalog.thumbnails requested ${batch.result.requested}, sent ${batch.result.sent}` +
      ` in ${batch.frames.length} LTHM frames, missing [${batch.result.missing.join(",")}]`,
  );

  // Click the first cell: that opens the photo in the viewer, at the canvas' own size.
  await window.locator("[data-photo-id]").first().click();
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );

  // Library keys: 3 rates, P flags as a pick. Both are engine writes that come back as
  // catalog.changed, so the overlay only changes once the engine agrees.
  await window.keyboard.press("3");
  await window.waitForSelector('[data-photo-id][data-rating="3"]', { timeout: 10_000 });
  await window.keyboard.press("p");
  await window.waitForSelector('[data-photo-id][data-flag="pick"]', { timeout: 10_000 });
  console.log("[shot] rating 3 and flag pick applied");

  // Delete on the selection: the rows leave the catalog, the files do not. Ctrl+click
  // moves the selection to the last cell without opening it, so the viewer keeps the photo
  // it has; the count only drops once the engine has published catalog.changed.
  const before = Number(await strip.locator("[data-photo-count]").getAttribute("data-photo-count"));
  await window
    .locator("[data-photo-id]")
    .last()
    .click({ modifiers: ["Control"] });
  await window
    .locator("[data-photo-id]")
    .first()
    .click({ modifiers: ["Control"] });
  await window.keyboard.press("Delete");
  await window.waitForFunction(photoCountIs, before - 1, { timeout: 15_000 });
  console.log(`[shot] Delete removed one row from the catalog: ${before} → ${before - 1} photos`);

  // Ctrl+` opens the console; Ctrl+Enter runs the script against the open photo.
  await window.keyboard.press("Control+Backquote");
  await window.waitForSelector("[data-console-input]", { timeout: 10_000 });
  await window.locator("[data-console-input]").fill("latent.photo.develop.exposure = 1.0");
  await window.keyboard.press("Control+Enter");
  // The script moved the stack, so the generated panel must show the engine's new value.
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+1.00 EV" },
    { timeout: 15_000 },
  );
  console.log("[shot] python.run moved exposure to +1.00 EV");

  // The engine streamed that run's output as python.output before the result came back.
  const streamed = await window
    .locator('[data-pane="console"]')
    .getAttribute("data-console-streamed");
  console.log(`[shot] console received ${streamed} streamed python.output chunk(s)`);

  // A second import, started from our own socket the way any client would, then cancelled
  // from the UI's job status line while it is still walking the directory.
  await engineCall<{ jobId: number }>(engineUrl, "catalog.import", {
    paths: [writeBulkFixture()],
    recursive: false,
  });
  // The real engine skips 300 empty files in well under a second, so the job may already
  // be finished by the time the click lands; that outcome is accepted and reported as such.
  const cancelButton = window.locator("[data-cancel-job]").first();
  const cancelShown = await cancelButton
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (cancelShown) await cancelButton.click().catch(() => undefined);
  await window.waitForFunction(
    () => {
      const line = document.querySelector("[data-jobs-running]");
      if (!(line instanceof HTMLElement)) return false;
      return line.innerText.includes("cancelled") || line.dataset.jobsRunning === "0";
    },
    null,
    { timeout: 20_000 },
  );
  const jobLine = await window.locator("[data-jobs-running]").innerText();
  const outcome = jobLine.includes("cancelled")
    ? "job.cancel stopped the import"
    : "import finished before cancel";
  console.log(`[shot] ${outcome}: ${jobLine.replace(/\s+/g, " ").trim()}`);

  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else if (flow === "latency") {
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );
  const size = await window.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return canvas instanceof HTMLCanvasElement ? `${canvas.width}×${canvas.height}` : "?";
  });
  console.log(`[shot] proxy size ${size}`);

  // One long drag — every move is an op.update, every reply a coalesced view.render.
  const slider = window.locator('[data-op="exposure"] [role="slider"]');
  const box = await slider.boundingBox();
  if (!box) throw new Error("exposure slider has no box");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  for (let step = 0; step < 200; step++) {
    const sweep = 0.5 + 0.06 * Math.sin(step / 7);
    await window.mouse.move(box.x + box.width * sweep, box.y + box.height / 2);
    await window.waitForTimeout(10);
  }
  await window.mouse.up();
  await window.waitForTimeout(500);
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else if (flow === "curve") {
  const poll = { timeout: 15_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );
  await window.waitForSelector('[data-curve-editor="tone_curve"]', { timeout: 15_000 });

  // The photo id the UI is on, resolved the way any client would: the same path opens the
  // same catalog row.
  const opened = await engineCall<{ photoId: number }>(engineUrl, "photo.open", {
    path: photoPath,
  });
  const photoId = opened.result.photoId;
  const neutralDigest = await renderDigest(engineUrl, photoId);

  const graph = window.locator('[data-curve-editor="tone_curve"] [role="application"]');

  /** The graph's box, with the column scrolled so the whole of it is on screen first. */
  async function graphBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    await graph.scrollIntoViewIfNeeded();
    const box = await graph.boundingBox();
    if (!box) throw new Error("the curve graph has no box");
    return box;
  }

  /** Where a curve coordinate lands on screen: x to the right, y up, as the editor draws. */
  async function graphPoint(x: number, y: number): Promise<{ x: number; y: number }> {
    const box = await graphBox();
    return { x: box.x + box.width * x, y: box.y + box.height * (1 - y) };
  }

  /** A click at a curve coordinate, aimed at the element rather than at the screen. */
  async function graphClick(x: number, y: number): Promise<void> {
    const box = await graphBox();
    await graph.click({ position: { x: box.width * x, y: box.height * (1 - y) } });
  }

  /** The `in → out` levels the editor prints for the selected point. */
  async function readoutLevels(): Promise<[number, number]> {
    const text = await window.locator("[data-curve-readout]").innerText();
    const parts = text.split("→").map((part) => Number(part.trim()));
    return [parts[0] ?? -1, parts[1] ?? -1];
  }

  // The tab strip: Parametric is what opens, Point/RGB is one click away.
  await window.locator('[data-curve-tab="rgb"]').click();
  await window.waitForSelector('[data-curve-tab="rgb"][aria-selected="true"]', { timeout: 5_000 });

  // A click on the curve adds a control point. The graph is ~230 px wide, so a click lands
  // within a level or two of the coordinate asked for: 0.25 → 64, 0.40 → 102 of 255.
  await graphClick(0.25, 0.4);
  await window.waitForSelector("[data-curve-readout]", { timeout: 10_000 });
  const addedLevels = await readoutLevels();
  if (Math.abs(addedLevels[0] - 64) > 3 || Math.abs(addedLevels[1] - 102) > 3) {
    throw new Error(`the readout says ${addedLevels.join(" → ")}, not 64 → 102`);
  }
  const added = await curvePointsOf(engineUrl, photoId, "rgb");
  if (added.length !== 3) {
    throw new Error(`stack.get has ${added.length} rgb points, expected two endpoints and one`);
  }
  console.log(
    `[shot] a click added a point: readout "${addedLevels.join(" → ")}", stack.get has` +
      ` ${added.length} rgb points, the middle one at` +
      ` (${added[1]?.x.toFixed(3)}, ${added[1]?.y.toFixed(3)})`,
  );

  // Drag that point up and to the right. Every move is a transient op.update; the release
  // is the one commit, so the whole drag is one history step.
  const from = await graphPoint(added[1]?.x ?? 0.25, added[1]?.y ?? 0.4);
  const to = await graphPoint(0.45, 0.68);
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  for (let step = 1; step <= 8; step++) {
    const fraction = step / 8;
    await window.mouse.move(
      from.x + (to.x - from.x) * fraction,
      from.y + (to.y - from.y) * fraction,
    );
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
  await window.waitForFunction(
    (was: number) => {
      const text = document.querySelector("[data-curve-readout]")?.textContent ?? "";
      return Number(text.split("→")[0]?.trim()) > was + 10;
    },
    addedLevels[0],
    poll,
  );
  const dragged = await curvePointsOf(engineUrl, photoId, "rgb");
  const draggedLevels = await readoutLevels();
  console.log(
    `[shot] the drag moved it to (${dragged[1]?.x.toFixed(3)}, ${dragged[1]?.y.toFixed(3)}),` +
      ` readout "${draggedLevels.join(" → ")}"`,
  );

  const curvedDigest = await renderDigest(engineUrl, photoId);
  if (curvedDigest === neutralDigest) {
    throw new Error(`the engine rendered the same frame with and without the curve`);
  }
  console.log(`[shot] the engine's frame changed: ${neutralDigest} → ${curvedDigest}`);

  // One Ctrl+Z takes the whole drag, landing on the point as the click left it rather than
  // somewhere in the middle of the drag.
  await window.keyboard.press("Control+z");
  await window.waitForFunction(
    (was: number) => {
      const text = document.querySelector("[data-curve-readout]")?.textContent ?? "";
      return Number(text.split("→")[0]?.trim()) < was - 10;
    },
    draggedLevels[0],
    poll,
  );
  const undone = await curvePointsOf(engineUrl, photoId, "rgb");
  const drift = Math.abs((undone[1]?.x ?? 0) - (added[1]?.x ?? 0));
  if (drift > 0.002) {
    throw new Error(
      `undo landed on x=${undone[1]?.x?.toFixed(4)}, not on the added ${added[1]?.x?.toFixed(4)}`,
    );
  }
  console.log(
    `[shot] one undo removed the whole drag: x ${dragged[1]?.x.toFixed(3)} →` +
      ` ${undone[1]?.x.toFixed(3)}, which is where the click put it`,
  );
  // Redo puts the drag back, so the shot below is of the curve that was dragged.
  await window.keyboard.press("Control+Shift+z");
  await window.waitForFunction(
    (was: number) => {
      const text = document.querySelector("[data-curve-readout]")?.textContent ?? "";
      return Number(text.split("→")[0]?.trim()) > was + 10;
    },
    addedLevels[0],
    poll,
  );

  // The Red channel is its own curve on the same graph, stroked in the red token.
  await window.locator('[data-curve-tab="red"]').click();
  await window.waitForSelector('[data-curve-tab="red"][aria-selected="true"]', { timeout: 5_000 });
  // The Red curve is empty, so the graph draws no points until the click lands: waiting
  // for that is what says the tab actually swapped before the click goes out.
  await window.waitForFunction(
    () => document.querySelectorAll("[data-curve-point]").length === 0,
    null,
    poll,
  );
  await graphClick(0.62, 0.42);
  await window.waitForFunction(
    () => document.querySelectorAll("[data-curve-point]").length >= 3,
    null,
    poll,
  );
  const red = await curvePointsOf(engineUrl, photoId, "red");
  const rgbStill = await curvePointsOf(engineUrl, photoId, "rgb");
  console.log(
    `[shot] the Red tab has its own curve: ${red.length} red points,` +
      ` ${rgbStill.length} rgb points still there`,
  );

  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // Back to Parametric: the four region sliders and the three split handles live there.
  await window.locator('[data-curve-tab="parametric"]').click();
  await window.waitForSelector('[data-curve-tab="parametric"][aria-selected="true"]', {
    timeout: 5_000,
  });
  const shadows = window.locator('[data-op="tone_curve"][data-param="shadows"] [role="slider"]');
  const shadowsBox = await shadows.boundingBox();
  if (!shadowsBox) throw new Error("the shadows slider has no box");
  await window.mouse.move(
    shadowsBox.x + shadowsBox.width / 2,
    shadowsBox.y + shadowsBox.height / 2,
  );
  await window.mouse.down();
  for (let step = 1; step <= 6; step++) {
    await window.mouse.move(
      shadowsBox.x + shadowsBox.width * (0.5 + 0.0333 * step),
      shadowsBox.y + shadowsBox.height / 2,
    );
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
  await window.waitForFunction(
    () =>
      document
        .querySelector('[data-op="tone_curve"][data-param="shadows"] [data-readout]')
        ?.textContent?.startsWith("+") === true,
    null,
    poll,
  );
  const shadowsReadout = await window
    .locator('[data-op="tone_curve"][data-param="shadows"] [data-readout]')
    .innerText();
  console.log(`[shot] the parametric Shadows slider reads ${shadowsReadout}`);

  // A split handle rides the graph's own x axis: drag the midtone one to 65 %.
  const handle = window.locator('[data-curve-split="midtoneSplit"]');
  const axis = await graphBox();
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("the midtone split handle has no box");
  await window.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await window.mouse.down();
  await window.mouse.move(axis.x + axis.width * 0.65, handleBox.y + handleBox.height / 2, {
    steps: 6,
  });
  await window.mouse.up();
  await window.waitForFunction(
    () => {
      const split = document.querySelector('[data-curve-split="midtoneSplit"]');
      return Number(split?.getAttribute("aria-valuenow") ?? 50) > 60;
    },
    null,
    poll,
  );
  const splitValue = await handle.getAttribute("aria-valuenow");
  console.log(`[shot] the midtone split handle dragged to ${splitValue}%`);

  const parametricDigest = await renderDigest(engineUrl, photoId);
  if (parametricDigest === curvedDigest) {
    throw new Error("the parametric half of the curve did not reach the engine's frame");
  }
  console.log(`[shot] the parametric edit changed the frame again: → ${parametricDigest}`);

  const parametricPath = outputPath.replace(/\.png$/, "-parametric.png");
  await capture(parametricPath);
  console.log(`[shot] wrote ${parametricPath}`);
} else if (flow === "mixer") {
  const poll = { timeout: 15_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );
  const mixer = window.locator('[data-mixer-editor="color_mixer"]');
  await mixer.waitFor({ timeout: 15_000 });

  /** How many slider rows the mixer is showing right now. */
  const rowCount = async (): Promise<number> => mixer.locator("[data-param]").count();

  // Hue is the tab that opens: eight rows, one per Lightroom colour band.
  await window.waitForSelector('[data-mixer-tab="Hue"][aria-selected="true"]', { timeout: 5_000 });
  const hueRows = await rowCount();
  const bandLabels = await mixer
    .locator("[data-param] [data-label]")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
  console.log(`[shot] the Hue tab shows ${hueRows} bands: ${bandLabels.join(", ")}`);

  // Drag the Orange band's hue: the row is the column's own slider, so this is the same
  // transient-then-commit path every other slider takes.
  const track = mixer.locator('[data-param="orangeHue"] [role="slider"]');
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  if (!box) throw new Error("the orange hue slider has no box");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  for (let step = 1; step <= 6; step++) {
    await window.mouse.move(box.x + box.width * (0.5 + 0.025 * step), box.y + box.height / 2);
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
  await window.waitForFunction(
    () =>
      document
        .querySelector('[data-param="orangeHue"] [data-readout]')
        ?.textContent?.startsWith("+") === true,
    null,
    poll,
  );
  const orange = await window.locator('[data-param="orangeHue"] [data-readout]').innerText();
  console.log(`[shot] dragging the Orange row moved orangeHue to ${orange}`);

  // Luminance is the same eight bands, the other parameter.
  await window.locator('[data-mixer-tab="Luminance"]').click();
  await window.waitForSelector('[data-param="orangeLuminance"]', { timeout: 5_000 });
  const stillHidden = await mixer.locator('[data-param="orangeHue"]').count();
  console.log(
    `[shot] the Luminance tab swapped the rows: ${await rowCount()} rows,` +
      ` ${stillHidden} hue rows left on screen`,
  );

  // All is Lightroom's grid: every band, every channel, under a heading each.
  await window.locator('[data-mixer-tab="All"]').click();
  await window.waitForFunction(
    () => document.querySelectorAll("[data-mixer-editor] [data-param]").length >= 24,
    null,
    poll,
  );
  const headings = await mixer.locator("[data-mixer-band]").count();
  console.log(`[shot] the All grid shows ${await rowCount()} rows under ${headings} band headings`);

  await mixer.scrollIntoViewIfNeeded();
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else if (flow === "masks") {
  // Every wait in this flow polls on a timer, never on an animation frame: a rAF-polled
  // `waitForFunction` over a canvas that is being drawn into leaves Chromium's screenshot
  // capture waiting for a frame that never comes quiet.
  const poll = { timeout: 15_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );

  /** The fraction of the frame the last mask.preview covered, as the pane reports it. */
  async function maskCoverage(): Promise<number> {
    const value = await window.locator('[data-pane="masks"]').getAttribute("data-mask-coverage");
    return Number(value ?? 0);
  }

  /** Waits until the coverage has moved past `floor`, then answers with it. */
  async function coverageAbove(floor: number): Promise<number> {
    await window.waitForFunction(
      (limit: number) => {
        const pane = document.querySelector('[data-pane="masks"]');
        return Number(pane?.getAttribute("data-mask-coverage") ?? 0) > limit;
      },
      floor,
      poll,
    );
    return maskCoverage();
  }

  /**
   * The same, but only once the number stops moving: a stroke's transient segments each
   * bring a preview of their own, and reading the first one that is bigger would record a
   * coverage from the middle of the stroke rather than from the end of it.
   */
  async function settledCoverage(floor: number): Promise<number> {
    let previous = await coverageAbove(floor);
    for (let attempt = 0; attempt < 20; attempt++) {
      await window.waitForTimeout(150);
      const current = await maskCoverage();
      if (current === previous) return current;
      previous = current;
    }
    return previous;
  }

  // Two ops to layer: a click at 60 % of the exposure track, and one on contrast.
  for (const [op, at, text] of [
    ["exposure", 0.6, "+1.00 EV"],
    ["contrast", 0.75, "+50"],
  ] as const) {
    const track = window.locator(`[data-op="${op}"] [role="slider"]`);
    const box = await track.boundingBox();
    if (!box) throw new Error(`${op} slider has no box`);
    await window.mouse.click(box.x + box.width * at, box.y + box.height / 2);
    await window.waitForFunction(readoutIs, { op, text }, poll);
  }
  console.log("[shot] two ops in the stack: exposure +1.00 EV, contrast +50");

  // The rail swaps the column. Nothing is masked yet, so the Masks column asks which
  // adjustment to mask.
  await window.locator('[data-rail-mode="masks"] button').click();
  await window.waitForSelector('[data-pane="masks"]', { timeout: 10_000 });
  await window.locator('[data-select-op="exposure"]').click();
  await window.waitForSelector("[data-create-mask]", { timeout: 10_000 });

  // Create a radial, then drag one on the overlay: press at the centre, release at a
  // corner of the ellipse. The component exists after the first call; the drag resizes it.
  await window.locator('[data-create-mask] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "Radial gradient" }).click();
  await window.waitForSelector('[data-mask-component="radial1"]', { timeout: 10_000 });
  const created = await coverageAbove(0);
  console.log(`[shot] radial created, mask.preview covers ${(created * 100).toFixed(1)}%`);

  const overlay = window.locator("[data-overlay-canvas]");
  const frame = await overlay.boundingBox();
  if (!frame) throw new Error("the viewer overlay has no box");
  const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  await window.mouse.move(centre.x, centre.y);
  await window.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await window.mouse.move(
      centre.x + frame.width * 0.045 * step,
      centre.y + frame.height * 0.045 * step,
    );
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
  const dragged = await settledCoverage(created);
  console.log(
    `[shot] drag on the overlay resized the radial: coverage ${(created * 100).toFixed(1)}%` +
      ` → ${(dragged * 100).toFixed(1)}%`,
  );

  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // O takes the tint off, Shift+O walks the overlay styles.
  await window.keyboard.press("o");
  await window.waitForSelector('[data-pane="masks"][data-mask-overlay="false"]', {
    timeout: 5_000,
  });
  await window.keyboard.press("o");
  await window.waitForSelector('[data-pane="masks"][data-mask-overlay="true"]', { timeout: 5_000 });
  await window.keyboard.press("Shift+O");
  await window.waitForSelector('[data-pane="masks"][data-mask-tint="green"]', { timeout: 5_000 });
  await window.keyboard.press("Shift+O");
  await window.keyboard.press("Shift+O");
  await window.keyboard.press("Shift+O");
  await window.waitForSelector('[data-pane="masks"][data-mask-tint="red"]', { timeout: 5_000 });
  console.log("[shot] O toggled the overlay, Shift+O cycled the four tints back to red");

  // A brush component, then three strokes. Every stroke is transient segments plus one
  // committed call, so each one grows the mask and each one is a single undo step.
  await window.locator('[data-create-mask] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "Tools · Brush" }).click();
  await window.waitForSelector('[data-mask-component="brush1"]', { timeout: 10_000 });
  // Selecting a component previews that component's own raster, so the empty brush reads
  // as 0 % while the combined mask stays on the op. Every stroke below grows this number.
  await window.waitForFunction(
    () => document.querySelector('[data-pane="masks"][data-mask-coverage="0.0000"]') !== null,
    null,
    poll,
  );

  const strokes: number[] = [];
  let before = 0;
  for (const [index, y] of [0.12, 0.22, 0.86].entries()) {
    const top = frame.y + frame.height * y;
    await window.mouse.move(frame.x + frame.width * 0.12, top);
    await window.mouse.down();
    for (let step = 1; step <= 10; step++) {
      await window.mouse.move(frame.x + frame.width * (0.12 + 0.07 * step), top);
      await window.waitForTimeout(16);
    }
    await window.mouse.up();
    before = await settledCoverage(before);
    strokes.push(before);
    console.log(`[shot] brush stroke ${index + 1}: coverage ${(before * 100).toFixed(1)}%`);
  }

  // One Ctrl+Z takes the whole third stroke, not one of its segments: the coverage lands
  // back on what it was after the second stroke, not somewhere inside the third.
  const afterTwo = strokes[1] ?? 0;
  const afterThree = strokes[2] ?? 0;
  await window.keyboard.press("Control+z");
  await window.waitForFunction(
    (target: number) => {
      const pane = document.querySelector('[data-pane="masks"]');
      return Number(pane?.getAttribute("data-mask-coverage") ?? 0) < target - 0.0005;
    },
    afterThree,
    poll,
  );
  const undone = await maskCoverage();
  if (Math.abs(undone - afterTwo) > 0.002) {
    throw new Error(
      `undo landed on ${undone.toFixed(4)}, not on the two-stroke ${afterTwo.toFixed(4)}`,
    );
  }
  console.log(
    `[shot] undo removed the whole third stroke: ${(afterThree * 100).toFixed(1)}%` +
      ` → ${(undone * 100).toFixed(1)}% (two strokes)`,
  );
  await window.keyboard.press("Control+Shift+z");
  await coverageAbove(afterTwo);

  // Layer opacity: the readout opens on a click and takes a typed value.
  await window.locator('[data-pane="masks"] [aria-label="Layer opacity"]').click();
  await window.locator('[data-pane="masks"] input[aria-label="Layer opacity"]').fill("50");
  await window.keyboard.press("Enter");
  await window.waitForFunction(
    () =>
      document
        .querySelector('[data-pane="masks"] [data-readout="opacity"]')
        ?.textContent?.trim() === "50 %",
    null,
    poll,
  );
  console.log("[shot] layer opacity set to 50 %");

  // Back in the Edit column the op now wears a mask badge with that opacity on it, and
  // clicking the badge is the way back here.
  await window.locator('[data-rail-mode="edit"] button').click();
  await window.waitForSelector('[data-mask-badge="exposure"]', { timeout: 10_000 });
  const badge = await window.locator('[data-mask-badge="exposure"]').innerText();
  console.log(`[shot] the Edit column marks exposure as a layer: "${badge.replace(/\s+/g, " ")}"`);
  await window.locator('[data-mask-badge="exposure"]').click();
  await window.waitForSelector('[data-pane="masks"]', { timeout: 10_000 });

  // The Layers column: the stack top-down, one row per op, each with its mask thumbnail.
  await window.locator('[data-rail-mode="layers"] button').click();
  await window.waitForSelector('[data-pane="layers"]', { timeout: 10_000 });
  await window.waitForSelector("[data-mask-thumb-image]", { timeout: 15_000 });
  const rowOrder = async (): Promise<string[]> =>
    window
      .locator("[data-layer-row]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-op") ?? ""));
  const beforeOrder = await rowOrder();
  const thumbnails = await window.locator("[data-mask-thumb-image]").count();
  const exposureOpacity = await window
    .locator('[data-layer-row][data-op="exposure"]')
    .getAttribute("data-opacity");
  console.log(
    `[shot] layers top-down ${beforeOrder.join(" → ")}, ${thumbnails} mask thumbnail(s),` +
      ` exposure at ${exposureOpacity}% opacity`,
  );

  // Drag the top row past the middle of the bottom row: that is a stack.set, and the
  // engine's answer is what re-orders the list.
  const handle = window.locator("[data-layer-handle]").first();
  const handleBox = await handle.boundingBox();
  const lastRow = await window.locator("[data-layer-row]").last().boundingBox();
  if (!handleBox || !lastRow) throw new Error("a layer row has no box");
  await window.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await window.mouse.down();
  await window.mouse.move(handleBox.x + handleBox.width / 2, lastRow.y + lastRow.height * 0.8, {
    steps: 8,
  });
  await window.mouse.up();
  await window.waitForFunction(
    (was: string[]) => {
      const rows = [...document.querySelectorAll("[data-layer-row]")];
      const order = rows.map((row) => row.getAttribute("data-op") ?? "");
      return order.join(",") !== was.join(",");
    },
    beforeOrder,
    poll,
  );
  const afterOrder = await rowOrder();
  console.log(
    `[shot] drag reordered the stack: ${beforeOrder.join(" → ")} becomes ${afterOrder.join(" → ")}`,
  );

  // The eye is an op.update, so the row only dims once the engine agrees.
  const topOp = afterOrder[0] ?? "exposure";
  await window.locator(`[data-layer-row][data-op="${topOp}"] [data-layer-eye] button`).click();
  await window.waitForSelector(`[data-layer-row][data-op="${topOp}"][data-enabled="false"]`, {
    timeout: 10_000,
  });
  console.log(`[shot] the eye disabled the ${topOp} layer`);

  // Off the row, or the tooltip the click left open covers the shot.
  await window.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  const layersPath = outputPath.replace(/\.png$/, "-layers.png");
  await capture(layersPath);
  console.log(`[shot] wrote ${layersPath}`);
} else if (flow === "panels") {
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );

  // A click anywhere on the track jumps there and would start a drag: 70% of a −5…+5
  // range is +2.00 EV.
  const track = window.locator('[data-op="exposure"] [role="slider"]');
  const trackBox = await track.boundingBox();
  if (!trackBox) throw new Error("exposure slider has no box");
  await window.mouse.click(trackBox.x + trackBox.width * 0.7, trackBox.y + trackBox.height / 2);
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+2.00 EV" },
    { timeout: 10_000 },
  );
  console.log("[shot] click at 70% of the track jumped exposure to +2.00 EV");

  // Arrow keys on the focused slider: one step, then ten with Shift.
  await track.focus();
  await window.keyboard.press("ArrowRight");
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+2.01 EV" },
    { timeout: 10_000 },
  );
  await window.keyboard.press("Shift+ArrowRight");
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+2.11 EV" },
    { timeout: 10_000 },
  );
  console.log("[shot] ArrowRight stepped 0.01 EV, Shift+ArrowRight stepped 0.10 EV");

  // Dragging the readout scrubs it: one step per pixel, so 20 px is +0.20 EV.
  const readout = window.locator('[data-op="exposure"] [data-readout]');
  const readoutBox = await readout.boundingBox();
  if (!readoutBox) throw new Error("exposure readout has no box");
  const readoutY = readoutBox.y + readoutBox.height / 2;
  await window.mouse.move(readoutBox.x + readoutBox.width / 2, readoutY);
  await window.mouse.down();
  for (let step = 1; step <= 20; step++) {
    await window.mouse.move(readoutBox.x + readoutBox.width / 2 + step, readoutY);
    await window.waitForTimeout(10);
  }
  await window.mouse.up();
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+2.31 EV" },
    { timeout: 10_000 },
  );
  console.log("[shot] scrubbing the readout 20 px moved exposure to +2.31 EV");

  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // Double-click resets to the described default. Off-centre on purpose: the two clicks
  // first jump the slider to +3.00 EV, so landing on 0.00 is the reset and not the click.
  await track.dblclick({
    position: { x: trackBox.width * 0.8, y: trackBox.height / 2 },
  });
  await window.waitForFunction(readoutIs, { op: "exposure", text: "0.00 EV" }, { timeout: 10_000 });
  console.log("[shot] double-click reset exposure to its default");

  // The section chevron folds the group away; the fold is UI state and survives nothing
  // else changing.
  await window.locator('[data-section-toggle="color"]').click();
  await window.waitForSelector('[data-section="color"][data-open="false"]', { timeout: 10_000 });
  const visibleRows = await window.locator('[data-section="color"] [data-op]').count();
  console.log(`[shot] Color section folded: ${visibleRows} rows left in it`);

  const foldedPath = outputPath.replace(/\.png$/, "-folded.png");
  await capture(foldedPath);
  console.log(`[shot] wrote ${foldedPath}`);
} else if (flow === "library") {
  // The library at Lightroom density: a cell's own hover controls, the grid and its size
  // slider, Enter back into the edit view, the sort menu, the Info rail, Tab, and the
  // console's history. The photos come in over our own socket rather than the page's
  // `?import=` hook, so nothing outside this block needs to know about the flow.
  await window.waitForSelector('[data-pane="filmstrip"]', { timeout: 30_000 });
  await engineCall<{ jobId: number }>(engineUrl, "catalog.import", {
    paths: writeFixturePhotos(),
    recursive: false,
  });
  await window.waitForFunction(
    () => document.querySelectorAll('[data-pane="filmstrip"] [data-photo-id] img').length >= 10,
    null,
    { timeout: 60_000 },
  );
  const stripCells = await window.locator('[data-pane="filmstrip"] [data-photo-id]').count();
  console.log(`[shot] filmstrip filled with ${stripCells} cells`);

  // The cell's own controls: hovering reveals five stars, clicking one is a
  // catalog.setRating for that photo — the overlay only changes once the engine agrees.
  const firstCell = window.locator('[data-pane="filmstrip"] [data-photo-id]').first();
  await firstCell.hover();
  await firstCell.locator('[data-rate="4"]').click();
  await window.waitForSelector('[data-pane="filmstrip"] [data-photo-id][data-rating="4"]', {
    timeout: 10_000,
  });
  console.log("[shot] hover control rated the first cell 4 stars");

  // G swaps the centre region for the grid; the slider scales its cells.
  await window.keyboard.press("g");
  await window.waitForSelector('[data-pane="grid"]', { timeout: 10_000 });
  const gridCells = await window.locator('[data-pane="grid"] [data-photo-id]').count();
  const sizeSlider = window.locator("[data-grid-size]");
  const sizeBefore = await sizeSlider.getAttribute("data-grid-size");
  await sizeSlider.focus();
  for (let step = 0; step < 8; step++) await window.keyboard.press("ArrowRight");
  const sizeAfter = await sizeSlider.getAttribute("data-grid-size");
  console.log(`[shot] grid shows ${gridCells} cells, size ${sizeBefore}px → ${sizeAfter}px`);
  // Hover one cell so the shot shows the controls the cursor reveals.
  await window.locator('[data-pane="grid"] [data-photo-id]').first().hover();
  const gridPath = outputPath.replace(/\.png$/, "-grid.png");
  await capture(gridPath);
  console.log(`[shot] wrote ${gridPath}`);

  // Click a cell, Enter opens it: the grid closes and the viewer has the centre back.
  await window.locator('[data-pane="grid"] [data-photo-id]').nth(3).click();
  await window.keyboard.press("Enter");
  await window.waitForSelector('[data-pane="grid"]', { state: "detached", timeout: 10_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );
  console.log("[shot] Enter opened the photo and handed the centre back to the viewer");

  // The sort menu is one catalog.list per change: pick a key, then flip the direction,
  // and the page comes back in the engine's order — the UI never re-sorts rows itself.
  await window.locator('[data-sort] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "File name" }).click();
  await window.waitForSelector('[data-sort="filename"]', { timeout: 10_000 });
  await window.locator("[data-sort] button").last().click();
  await window.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll('[data-pane="filmstrip"] [data-photo-id]')];
      const names = cells.map((cell) => (cell.getAttribute("title") ?? "").split(" · ")[0] ?? "");
      return names.length > 1 && names.join("\n") === [...names].sort().join("\n");
    },
    null,
    { timeout: 15_000 },
  );
  console.log("[shot] sort by file name re-listed the page in ascending order");

  // The right rail swaps the column: Info is the open photo's catalog row.
  await window.locator('[data-rail-mode="info"] button').click();
  await window.waitForSelector('[data-pane="info"]', { timeout: 10_000 });
  const camera = await window.locator('[data-pane="info"] dd').first().innerText();
  console.log(`[shot] Info rail shows camera ${camera.trim()}`);
  const infoPath = outputPath.replace(/\.png$/, "-info.png");
  await capture(infoPath);
  console.log(`[shot] wrote ${infoPath}`);

  // Tab takes the side panes off, the way Lightroom's does, and puts them back.
  await window.keyboard.press("Tab");
  await window.waitForSelector('[data-chrome="sides"]', { timeout: 5_000 });
  const hidden = await window.locator('[data-pane="filmstrip"]').count();
  console.log(`[shot] Tab hid the side panes: ${hidden} filmstrip panes left on screen`);
  const hiddenPath = outputPath.replace(/\.png$/, "-tab.png");
  await capture(hiddenPath);
  await window.keyboard.press("Tab");
  await window.waitForSelector('[data-chrome="all"]', { timeout: 5_000 });

  // The console remembers what was run: an empty box plus ArrowUp walks back through it,
  // and Ctrl+L clears the scrollback without touching the history.
  await window.keyboard.press("Control+Backquote");
  await window.waitForSelector("[data-console-input]", { timeout: 10_000 });
  await window.locator("[data-console-input]").fill("latent.photo.develop.exposure = 0.4");
  await window.keyboard.press("Control+Enter");
  await window.waitForFunction(
    () => document.querySelectorAll("[data-console-run]").length >= 1,
    null,
    { timeout: 15_000 },
  );
  await window.locator("[data-console-input]").fill("latent.undo()");
  await window.keyboard.press("Control+Enter");
  await window.waitForFunction(
    () => document.querySelectorAll("[data-console-run]").length >= 2,
    null,
    { timeout: 15_000 },
  );
  await window.locator("[data-console-input]").fill("");
  await window.keyboard.press("ArrowUp");
  const newest = await window.locator("[data-console-input]").inputValue();
  await window.keyboard.press("ArrowUp");
  const older = await window.locator("[data-console-input]").inputValue();
  console.log(`[shot] history recall: ArrowUp gave "${newest}", then "${older}"`);
  await window.keyboard.press("Control+l");
  await window.waitForFunction(
    () => document.querySelectorAll("[data-console-run]").length === 0,
    null,
    { timeout: 10_000 },
  );
  console.log("[shot] Ctrl+L cleared the scrollback");

  // A page too wide for the strip: a vertical wheel over it scrolls it sideways.
  await engineCall<{ jobId: number }>(engineUrl, "catalog.import", {
    paths: [writeBulkFixture()],
    recursive: false,
  });
  await window.waitForFunction(
    () => document.querySelectorAll('[data-pane="filmstrip"] [data-photo-id]').length >= 40,
    null,
    { timeout: 60_000 },
  );
  const scroller = window.locator('[data-pane="filmstrip"] [role="listbox"]');
  await scroller.hover();
  await window.mouse.wheel(0, 600);
  await window.waitForFunction(
    () => (document.querySelector('[data-pane="filmstrip"] [role="listbox"]')?.scrollLeft ?? 0) > 0,
    null,
    { timeout: 5_000 },
  );
  const scrolled = await scroller.evaluate((element) => element.scrollLeft);
  console.log(`[shot] wheel over the strip scrolled it ${scrolled}px sideways`);
  await window.waitForSelector('[data-jobs-running="0"]', { timeout: 120_000 });

  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else {
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  // The canvas keeps its default 300×150 until the first LFRM frame is drawn into it.
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );

  // Drag exposure up: real pointer events, the same path a user's mouse takes.
  const slider = window.locator('[data-op="exposure"] [role="slider"]');
  const box = await slider.boundingBox();
  if (!box) throw new Error("exposure slider has no box");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await window.mouse.move(box.x + box.width * (0.5 + 0.0125 * step), box.y + box.height / 2);
    await window.waitForTimeout(30);
  }
  await window.mouse.up();
  await window.waitForTimeout(500);

  await capture(outputPath);
  const readout = await window.locator('[data-op="exposure"] [data-readout]').innerText();
  const revision = await window.locator("[data-revision]").innerText();
  console.log(`[shot] exposure reads ${readout}, ${revision}`);
  console.log(`[shot] wrote ${outputPath}`);

  // Ctrl+Z / Ctrl+Shift+Z go to the engine's history, not to a local undo buffer.
  await window.keyboard.press("Control+z");
  await window.waitForFunction(readoutIs, { op: "exposure", text: "0.00 EV" }, { timeout: 10_000 });
  await window.keyboard.press("Control+Shift+z");
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+1.00 EV" },
    { timeout: 10_000 },
  );
  console.log("[shot] undo/redo moved the slider");

  // An external writer — a script or an MCP client on its own socket — must move the
  // sliders and trigger a re-render without the UI asking for anything.
  // Photo ids are catalog rows, so the writer resolves the id the same way any client
  // would: photo.open on the same path answers with the row the UI already holds.
  const opened = await engineCall<{ photoId: number }>(engineUrl, "photo.open", {
    path: photoPath,
  });
  const added = await engineCall<{ revision: number }>(engineUrl, "op.add", {
    photoId: opened.result.photoId,
    op: "contrast",
    params: { value: 60 },
  });
  console.log(
    `[shot] external op.add on photo ${opened.result.photoId} answered rev ${added.result.revision}`,
  );
  await window.waitForFunction(readoutIs, { op: "contrast", text: "+60" }, { timeout: 10_000 });
  await window.waitForTimeout(500);
  await capture(externalPath);
  console.log(`[shot] external writer moved contrast to 60, wrote ${externalPath}`);
}

await app.close();
stopChildren();
process.exit(0);

// Drives the real app and saves a PNG: the mock engine, Vite for the renderer, Electron
// under Playwright. Proof that the generated panels render and that dragging a slider
// reaches the engine and comes back as a frame.
//
//   node apps/desktop/scripts/screenshot.ts [--out /tmp/latent-ui.png] [--engine mock|real]
//                                           [--photo /path/to/raw]
//   [--flow slider|panels|curve|mixer|masks|generative|enhance|relight|planes|crop|zoom|pan|merge|catalog|library]
//                                           [--dir <import directory>]
//                                           [--display vnc|native] [--hold]
//
// The window runs on its own Xvnc display by default (TigerVNC's `Xvnc`, 1600x1000 like the
// window), so a run never lands on the desktop. The script prints `vncviewer localhost::<port>`
// before it builds anything; connect to watch the flow live. `--hold` keeps the app and the
// display up after the flow until Ctrl+C. `--display native` puts the window on the desktop.
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
// `--flow presets` drives the Presets pane: a shipped group unfolded, a preset applied, and
// the panel column and the History pane checked afterwards — a preset is one whole-stack
// write, so twelve sliders move in one undo step.
//
// `--flow history` branches the History pane: a preset applied and undone, another applied
// in its place, the graph shot with the first one on a lane of its own (`-branch.png`),
// then that branch merged back in.
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
// `--flow crop` drives the crop tool: R opens it and the viewer switches to the uncropped
// frame (`view.render`'s `geometry: "full"`), a corner grip is dragged in, 1:1 fits a square,
// the straighten readout takes 5°, and Esc leaves. Each step asserts the `crop` op the
// engine holds rather than what the column says, and the two content rects one state
// answers with prove the geometry flag is per render and not a stack edit.
//
// `--flow generative` drives the Generative column: a radial mask, a fill that takes it, a
// run through the backend, the result composited into the frame, and the stale badge an
// edit underneath produces. With `--engine real`, set LATENT_GENERATIVE_STUB=1 unless
// ComfyUI is running.
//
// `--flow enhance` drives the two whole-frame model columns (issues #51, #52): AI Denoise
// added and run, then AI Upscale at 4x on top of it, then an edit underneath that marks
// both stale. Same rule as the generative flow — set LATENT_GENERATIVE_STUB=1 unless
// ComfyUI is running, because a diffusion pass is not a screenshot.
//
// `--flow relight` drives the Relight column (PROMPT.md §3.8): the depth map estimated from
// the rail and drawn over the photo, a light added and dragged to the sun, and its rays
// turned up. Point it at a backlit photo with something in front of the light —
// `--photo <a tree>` — or there is nothing for the shadows and the shafts to be cast by.
// `LATENT_DEPTH_STUB=1` stands in for the model.
//
// `--flow masks` drives Masks and Layers: a radial dragged on the viewer's overlay, the
// LMSK raster drawn back as a red tint, three brush strokes that each grow the coverage,
// one undo that takes a whole stroke, layer opacity, and the Layers column's thumbnails,
// drag-reorder and eye. It ends on the image-space check: a radial at a known image point,
// then a crop and a straighten, with `mask.preview`'s centroid asserted to have stayed on
// the same pixels of the photo.
//
// `--flow zoom` drives the viewer's viewport: Z for fit ↔ 1:1, the wheel at the cursor,
// a middle-button pan, and Ctrl+0 back to fit. It writes one PNG per step.
//
// `--flow merge` drives Photo Merge: three photos selected in the library, Photo Merge →
// HDR, the preview PNG the engine rendered and serves over its own listener, a Deghost
// change that re-renders it, then the merge itself — the job's bar, the catalog row the
// engine registered, and the merged photo opening in the viewer.
//
// Node, not bun: Playwright's `_electron.launch` never resolves under bun 1.3 (it hangs
// after attaching to the inspector), while node runs it fine. Everything else is bun.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";

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
  crop: "/tmp/latent-crop.png",
  masks: "/tmp/latent-masks.png",
  curve: "/tmp/latent-curve.png",
  generative: "/tmp/latent-generative.png",
  enhance: "/tmp/latent-enhance.png",
  relight: "/tmp/latent-relight-ui.png",
  mixer: "/tmp/latent-mixer.png",
  export: "/tmp/latent-export.png",
  merge: "/tmp/latent-merge.png",
  planes: "/tmp/latent-planes.png",
  zoom: "/tmp/latent-zoom.png",
  presets: "/tmp/latent-presets.png",
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
// The model store is the one thing the scratch XDG_DATA_HOME must not take with it: the
// engine resolves it from $XDG_DATA_HOME/latent/models (ai/model_store.cpp), so a driven run
// would answer "model … not installed (run scripts/models/fetch.py)" for every AI feature
// while the same build finds them the moment the app is launched by hand. Pinned to the real
// store, which is read-only to a run.
const modelStore =
  process.env.LATENT_MODEL_STORE ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "latent", "models");
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
    LATENT_MODEL_STORE: modelStore,
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

/** A row-major 3x3 inverted, for `imageTransform` (protocol/README.md, view.render). */
function invertTransform(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const c0 = e * i - f * h;
  const c1 = f * g - d * i;
  const c2 = d * h - e * g;
  const determinant = a * c0 + b * c1 + c * c2;
  if (Math.abs(determinant) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = 1 / determinant;
  return [
    c0 * k,
    (c * h - b * i) * k,
    (b * f - c * e) * k,
    c1 * k,
    (a * i - c * g) * k,
    (c * d - a * f) * k,
    c2 * k,
    (b * g - a * h) * k,
    (a * e - b * d) * k,
  ];
}

function applyTransform(m: number[], x: number, y: number): { x: number; y: number } {
  const w = (m[6] ?? 0) * x + (m[7] ?? 0) * y + (m[8] ?? 1);
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: ((m[0] ?? 1) * x + (m[1] ?? 0) * y + (m[2] ?? 0)) / w,
    y: ((m[3] ?? 0) * x + (m[4] ?? 1) * y + (m[5] ?? 0)) / w,
  };
}

interface MaskReadout {
  coverage: number;
  /** The raster's centre of mass, carried back into image coordinates. */
  x: number;
  y: number;
}

/**
 * `mask.preview` on a socket of our own, digested into the one number that says whether a
 * mask is still on its subject: the centre of mass of the r8 raster, mapped through the
 * render's own `imageTransform` back into image space. Image-space masks keep it fixed
 * while the geometry moves; content-space ones do not.
 */
async function maskReadout(url: string, photoId: number, opId: string): Promise<MaskReadout> {
  const answer = await engineCall<{
    width: number;
    height: number;
    coverage: number;
    imageTransform?: number[];
  }>(url, "mask.preview", { photoId, opId });
  const frame = answer.frames[0];
  if (!frame) throw new Error("mask.preview sent no LMSK frame");
  const { width, height, coverage } = answer.result;
  const inverse = invertTransform(answer.result.imageTransform ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const pixels = new Uint8Array(frame, FRAME_HEADER_BYTES);
  let sumX = 0;
  let sumY = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixels[y * width + x] ?? 0) <= 127) continue;
      sumX += x + 0.5;
      sumY += y + 0.5;
      weight += 1;
    }
  }
  if (weight === 0) throw new Error("mask.preview answered an empty raster");
  const centre = applyTransform(inverse, sumX / weight, sumY / weight);
  return { coverage, x: centre.x, y: centre.y };
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
// Without these a Ctrl+C skips the exit handler and leaves every detached group running.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const displayMode = argument("--display", "vnc");
const hold = process.argv.includes("--hold");

function freeDisplay(): number {
  for (let display = 50; display < 200; display++) {
    const taken = existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`);
    if (!taken) return display;
  }
  throw new Error("no free X display between :50 and :199");
}

/** Starts Xvnc on a free display and answers the environment that puts Electron on it. */
async function startVnc(): Promise<NodeJS.ProcessEnv> {
  const display = freeDisplay();
  const rfbPort = await freePort();
  const server = spawn(
    "Xvnc",
    [
      `:${display}`,
      "-geometry",
      "1600x1000",
      "-depth",
      "24",
      "-localhost",
      "-SecurityTypes",
      "None",
      "-AlwaysShared",
      "-rfbport",
      String(rfbPort),
    ],
    { stdio: "ignore", detached: true },
  );
  children.push(server);
  const deadline = Date.now() + 10_000;
  while (!existsSync(`/tmp/.X11-unix/X${display}`)) {
    if (server.exitCode !== null || Date.now() > deadline) {
      throw new Error(`Xvnc :${display} did not come up`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`[shot] app on Xvnc :${display}, watch with: vncviewer localhost::${rfbPort}`);
  return { DISPLAY: `:${display}`, WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "x11" };
}

// Started before the engine and the build, so the viewer can connect while they run.
let displayEnvironment: NodeJS.ProcessEnv | undefined;
if (displayMode === "vnc") displayEnvironment = await startVnc();

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
  // Pointer lock off for every flow: a locked cursor is warped to the middle of the screen
  // and Chromium then reports our synthetic moves as hundreds of pixels of noise, so a
  // driven drag would scrub to a random value. Real drags take the lock; see `scrub.ts`.
  const driven = "pointerlock=off";
  if (flow === "catalog") {
    const paths = [...writeFixturePhotos(), importDir].join(",");
    return `?import=${encodeURIComponent(paths)}&${driven}`;
  }
  const photo = `?photo=${encodeURIComponent(photoPath)}&${driven}`;
  return flow === "latency" ? `${photo}&frametrace=25` : photo;
}

// The app is spawned here and driven over CDP rather than through Playwright's
// `_electron.launch`, which hangs on this Electron: it attaches to the main process'
// inspector and then waits forever for a DevTools websocket upgrade that Chromium refuses,
// because the upgrade carries an Origin it was not told to allow and Playwright passes no
// `--remote-allow-origins` for an Electron it launches. The HTTP endpoint answers fine
// throughout, so the failure is a timeout with no error in it.
const devtoolsPort = await freePort();
const electronCommand = [
  join(repoDir, "node_modules", "electron", "dist", "electron"),
  "--no-sandbox",
  `--remote-debugging-port=${devtoolsPort}`,
  "--remote-allow-origins=*",
];
const electronEnvironment: NodeJS.ProcessEnv = {
  LATENT_ENGINE_URL: `ws://127.0.0.1:${enginePort}`,
  LATENT_EDITOR_URL: `${editorUrl}/${pageQuery()}`,
};
if (displayEnvironment) {
  Object.assign(electronEnvironment, displayEnvironment);
  // Explicit, or a Wayland session's auto-detection can still pick the desktop compositor.
  // Xvnc has no hardware GL, so Chromium lands on SwiftShader and blocklists WebGL2 there
  // unless told otherwise; the viewer's painter is WebGL2 and would never draw.
  electronCommand.push("--ozone-platform=x11", "--enable-unsafe-swiftshader");
}
start([...electronCommand, desktopDir], repoDir, electronEnvironment);

/** Retries until the app's DevTools endpoint is up; it is not listening when spawn returns. */
async function connectToApp(port: number, timeoutMs: number): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const browser = await connectToApp(devtoolsPort, 60_000);
const context = browser.contexts()[0];
if (!context) throw new Error("the app exposed no browser context over CDP");
const window = context.pages()[0] ?? (await context.waitForEvent("page"));
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
  //
  // A quiet status line means the preview prewarm is done too, and that is one full decode
  // per imported photo — minutes when `--dir` is a real library rather than a handful of
  // fixtures, which is what this flow is pointed at.
  await window.waitForSelector('[data-pane="filmstrip"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const running = document.querySelector('[data-jobs-running="0"]');
      return running !== null && document.querySelectorAll("[data-photo-id] img").length >= 5;
    },
    null,
    { timeout: 600_000 },
  );
  // job.progress reports "finished" before the last catalog.changed has been re-listed;
  // the state debounces that by 60ms, so give it a beat before reading the count.
  await window.waitForTimeout(500);
  const imported = await window.locator("[data-photo-count]").innerText();
  console.log(`[shot] import finished, filmstrip shows ${imported}`);

  // Every cell above was filled from one `catalog.thumbnails` call for the strip's visible
  // window, not one call per cell — the filmstrip only asks when scrolling brings a cell
  // it has no thumbnail for into reach.
  const strip = window.locator('[data-pane="filmstrip"]');
  const filled = await strip.getAttribute("data-thumbnails-loaded");
  const cells = await window.locator("[data-photo-id]").count();
  console.log(`[shot] batch thumbnails: ${filled} held for ${cells} cells drawn`);

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

  // The grid is the whole catalog in one scroll, not a page of it: the content box is as
  // tall as every row, the DOM holds the rows near the scrollport, and scrolling to the
  // bottom swaps the drawn cells for the ones down there.
  await window.keyboard.press("g");
  await window.waitForSelector('[data-pane="grid"]', { timeout: 10_000 });
  const gridScroller = window.locator('[data-pane="grid"] [role="listbox"]');
  const top = await gridScroller.evaluate((element) => ({
    cells: element.querySelectorAll("[data-photo-id]").length,
    content: element.scrollHeight,
    port: element.clientHeight,
    first: element.querySelector("[data-photo-id]")?.getAttribute("data-photo-id") ?? "",
  }));
  const catalogSize = Number(
    await window.locator("[data-photo-count]").getAttribute("data-photo-count"),
  );
  console.log(
    `[shot] grid draws ${top.cells} of ${catalogSize} cells for a ${top.content}px content box` +
      ` in a ${top.port}px scrollport`,
  );
  const gridPath = outputPath.replace(/\.png$/, "-grid.png");
  await capture(gridPath);
  console.log(`[shot] wrote ${gridPath}`);

  await gridScroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await window.waitForFunction(
    (before: string) => {
      const scroller = document.querySelector('[data-pane="grid"] [role="listbox"]');
      const first = scroller?.querySelector("[data-photo-id]")?.getAttribute("data-photo-id");
      return first !== undefined && first !== before;
    },
    top.first,
    { timeout: 15_000 },
  );
  // The cells down here had no thumbnail when the grid opened; the scroll asked for them.
  await window
    .waitForFunction(
      () => {
        const scroller = document.querySelector('[data-pane="grid"] [role="listbox"]');
        return (scroller?.querySelectorAll("[data-photo-id] img").length ?? 0) > 0;
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => console.log("[shot] no thumbnail arrived for the bottom of the grid"));
  const bottomPath = outputPath.replace(/\.png$/, "-grid-bottom.png");
  await capture(bottomPath);
  console.log(`[shot] scrolled to the end of the grid; wrote ${bottomPath}`);
  await window.keyboard.press("g");
  await window.waitForSelector('[data-pane="grid"]', { state: "detached", timeout: 10_000 });

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

  // Ctrl+` switches the rail to the console; Ctrl+Enter runs the script against the open
  // photo.
  await window.keyboard.press("Control+Backquote");
  await window.waitForSelector("[data-console-input]", { timeout: 10_000 });
  await window.locator("[data-console-input]").fill("latent.photo.develop.exposure = 1.0");
  await window.keyboard.press("Control+Enter");
  await window.waitForFunction(
    () => document.querySelectorAll("[data-console-run]").length >= 1,
    null,
    { timeout: 15_000 },
  );
  // The engine streamed that run's output as python.output before the result came back.
  // Read while the console is still the tab on screen: Ctrl+` takes its card away with it.
  const streamed = await window
    .locator('[data-pane="console"]')
    .getAttribute("data-console-streamed");
  console.log(`[shot] console received ${streamed} streamed python.output chunk(s)`);

  // Back to Edit, where the generated panel must show the value the script wrote.
  await window.keyboard.press("Control+Backquote");
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+1.00 EV" },
    { timeout: 15_000 },
  );
  console.log("[shot] python.run moved exposure to +1.00 EV");

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

  // `--zoom 1:1` measures the same drag with the viewport at one image pixel per device
  // pixel. The frame is still the view's size — zoom changes which source texels the
  // proxy's sampling pass reads, never how many bytes come back — so this is the check
  // that the viewport did not move the frame budget.
  if (argument("--zoom", "fit") === "1:1") {
    await window.mouse.move(400, 400);
    await window.keyboard.press("z");
    await window.waitForFunction(
      () => document.querySelector("[data-zoom-level]")?.textContent?.trim() === "100%",
      null,
      { timeout: 15_000, polling: 200 },
    );
    console.log("[shot] measuring at 1:1");
  }

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

  /**
   * A boxed slider scrubs from where the press landed: 800 px sweeps the whole range, so
   * the travel for a value is that value's share of it (plugins/panels/src/panels.ts).
   */
  async function scrub(selector: string, pixels: number): Promise<void> {
    // A column taller than its card scrolls: a slider below the fold has a box, and it is
    // behind whatever is drawn over it, so the drag would land on that instead.
    const box = await window.locator(selector).boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    const y = box.y + box.height / 2;
    await window.mouse.move(box.x + box.width / 2, y);
    await window.mouse.down();
    for (let step = 1; step <= 10; step++) {
      await window.mouse.move(box.x + box.width / 2 + (pixels / 10) * step, y);
      await window.waitForTimeout(16);
    }
    await window.mouse.up();
  }

  // Two global ops, so the Edit column has something in it before the masking starts.
  for (const [op, pixels, text] of [
    ["exposure", 80, "+1.00 EV"],
    ["contrast", 200, "+50"],
  ] as const) {
    await scrub(`[data-op="${op}"] [role="slider"]`, pixels);
    await window.waitForFunction(readoutIs, { op, text }, poll);
  }
  console.log("[shot] two ops in the stack: exposure +1.00 EV, contrast +50");

  // The rail swaps the column. A mask is a layer of its own, so nothing has to be selected
  // first: Create new mask is there with an empty stack (PROMPT.md 3.7).
  // The Masks panel is the rail's flyout and stays open: clicking the button again would
  // close it, so it is only pressed when it is not already up.
  if ((await window.locator('[data-rail-pane="masks"]').getAttribute("data-open")) !== "true") {
    await window.locator('[data-rail-pane="masks"] button').click();
  }
  await window.waitForSelector('[data-pane="masks"]', { timeout: 10_000 });
  await window.waitForSelector("[data-create-mask]", { timeout: 10_000 });

  // A new mask, then a radial in it, then a drag on the overlay: press at the centre,
  // release at a corner of the ellipse. The component exists after the click; the drag
  // resizes it.
  await window.locator("[data-create-mask] button").click();
  await window.locator('[data-add-component] [data-add-kind="radial"]').click();
  await window.waitForSelector('[data-mask-component="radial1"]', { timeout: 10_000 });
  const created = await coverageAbove(0);
  console.log(`[shot] radial created, mask.preview covers ${(created * 100).toFixed(1)}%`);

  const overlay = window.locator("[data-overlay-canvas]");
  const box = await overlay.boundingBox();
  if (!box) throw new Error("the viewer overlay has no box");
  // The photo, not the canvas: the canvas fills the viewer and the panels float over it, so
  // a gesture measured off the box lands on a card or on the letterbox beside the picture.
  const drawn = (await overlay.getAttribute("data-overlay-rect"))?.split(",").map(Number) ?? [];
  const [rectX = 0, rectY = 0, rectWidth = 0, rectHeight = 0] = drawn;
  if (rectWidth <= 0 || rectHeight <= 0) throw new Error("the viewer drew no photo");
  const frame = {
    x: box.x + rectX,
    y: box.y + rectY,
    width: rectWidth,
    height: rectHeight,
  };
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
  // Into the same mask, not a new one: the icon adds a layer to the mask that is selected.
  await window.locator('[data-add-component] [data-add-kind="brush"]').click();
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
    // How far behind the pointer the stroke is: the drag is paced at 60 Hz, so whatever is
    // still arriving after the release is the backlog the brush built up.
    const released = Date.now();
    await window.mouse.up();
    before = await settledCoverage(before);
    strokes.push(before);
    console.log(
      `[shot] brush stroke ${index + 1}: coverage ${(before * 100).toFixed(1)}%,` +
        ` settled ${Date.now() - released} ms after the release`,
    );
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

  // The adjustments this mask holds. They are made in the Edit column beside the panel: the
  // mask is selected, so a slider there writes into the layer and shows up here. Two of them
  // under one mask is what a per-op mask could not express.
  for (const op of ["exposure", "clarity"]) {
    // Clarity is in the Effects card, below the fold of the column: a drag aimed at a
    // slider that is scrolled out lands on whatever is drawn over it.
    await window.locator(`[data-op="${op}"] [role="slider"]`).scrollIntoViewIfNeeded();
    await window.waitForTimeout(100);
    await scrub(`[data-op="${op}"] [role="slider"]`, 120);
    await window.waitForSelector(`[data-mask-adjustment="${op}"]`, { timeout: 10_000 });
  }
  const adjustments = await window
    .locator("[data-mask-adjustment]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-mask-adjustment") ?? ""));
  console.log(
    `[shot] the Edit column's sliders landed in the mask: ${adjustments.length}` +
      ` (${adjustments.join(", ")})`,
  );
  await window.waitForTimeout(400);

  // Back on the photo: the column reads the photo's own exposure again — a different stack
  // entry, still where the first scrub of this flow left it — and says the adjustment is
  // also in a mask. Clicking that badge selects the mask again.
  await window.locator('[data-mask-layer-select="photo"]').click();
  await window.waitForFunction(readoutIs, { op: "exposure", text: "+1.00 EV" }, poll);
  await window.waitForSelector('[data-mask-badge="exposure"]', { timeout: 10_000 });
  const badge = await window.locator('[data-mask-badge="exposure"]').innerText();
  console.log(
    `[shot] the Edit column marks exposure as masked too: "${badge.replace(/\s+/g, " ")}"`,
  );
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

  // Masks are keyed to the image, not to the view. A radial painted on a feature has to
  // stay on that feature when a crop and a straighten land after it — which is the whole
  // point of image space and the thing content-space coordinates got wrong. Asked of
  // `mask.preview` on a socket of our own, so the assertion is about the engine's raster
  // and not about what the column happens to say.
  // The same file the viewer opened — a real run edits a scratch copy — so the crop below
  // lands on the picture on screen and the last capture shows it.
  const spaceCheck = await engineCall<{ photoId: number }>(engineUrl, "photo.open", {
    path: photoPath,
  });
  const spacePhoto = spaceCheck.result.photoId;
  const withMask = await engineCall<{ stack: { id: string; op: string }[] }>(engineUrl, "op.add", {
    photoId: spacePhoto,
    op: "clarity",
    params: { value: 40 },
    mask: {
      space: "image",
      components: [
        {
          id: "spacechk",
          kind: "radial",
          mode: "add",
          feather: 0,
          params: { center: [0.42, 0.47], radius: [0.1, 0.1] },
        },
      ],
    },
  });
  const spaceOp = withMask.result.stack.find((entry) => entry.op === "clarity");
  if (!spaceOp) throw new Error("the image-space check could not add its masked op");
  const uncropped = await maskReadout(engineUrl, spacePhoto, spaceOp.id);
  console.log(
    `[shot] radial at image (0.420, 0.470): mask.preview centroid` +
      ` (${uncropped.x.toFixed(3)}, ${uncropped.y.toFixed(3)}),` +
      ` covering ${(uncropped.coverage * 100).toFixed(1)}%`,
  );

  // The before half of the pair: the viewer is on the same photo, so the radial is on it.
  // The Masks panel is the rail's flyout and stays open: clicking the button again would
  // close it, so it is only pressed when it is not already up.
  if ((await window.locator('[data-rail-pane="masks"]').getAttribute("data-open")) !== "true") {
    await window.locator('[data-rail-pane="masks"] button').click();
  }
  await window.waitForSelector('[data-pane="masks"]', { timeout: 10_000 });
  await window.waitForTimeout(900);
  const uncroppedPath = outputPath.replace(/\.png$/, "-uncropped.png");
  await capture(uncroppedPath);
  console.log(`[shot] wrote ${uncroppedPath}`);

  // A crop that keeps the radial, then a straighten on top of it.
  await engineCall(engineUrl, "op.add", {
    photoId: spacePhoto,
    op: "crop",
    params: { left: 0.12, top: 0.18, right: 0.62, bottom: 0.78 },
    index: 0,
  });
  const cropped = await maskReadout(engineUrl, spacePhoto, spaceOp.id);
  const drift = Math.hypot(cropped.x - uncropped.x, cropped.y - uncropped.y);
  if (drift > 0.02) {
    throw new Error(
      `the crop moved the mask ${drift.toFixed(3)} of the image off its subject:` +
        ` (${uncropped.x.toFixed(3)}, ${uncropped.y.toFixed(3)}) →` +
        ` (${cropped.x.toFixed(3)}, ${cropped.y.toFixed(3)})`,
    );
  }
  // The same pixels of the photo fill more of a smaller frame, which is how a content-space
  // mask would be told apart: it would have been cropped with the view and kept its share.
  if (cropped.coverage < uncropped.coverage * 1.3) {
    throw new Error(
      `coverage ${(cropped.coverage * 100).toFixed(1)}% did not grow with the crop from` +
        ` ${(uncropped.coverage * 100).toFixed(1)}%: the mask was cropped with the view`,
    );
  }
  console.log(
    `[shot] after a crop the centroid is (${cropped.x.toFixed(3)}, ${cropped.y.toFixed(3)}),` +
      ` drift ${drift.toFixed(4)}; coverage ${(uncropped.coverage * 100).toFixed(1)}% →` +
      ` ${(cropped.coverage * 100).toFixed(1)}%`,
  );

  const cropEntry = await engineCall<{ stack: { id: string; op: string }[] }>(
    engineUrl,
    "stack.get",
    { photoId: spacePhoto },
  );
  const cropId = cropEntry.result.stack.find((entry) => entry.op === "crop");
  if (!cropId) throw new Error("the crop op is not in the stack");
  await engineCall(engineUrl, "op.update", {
    photoId: spacePhoto,
    opId: cropId.id,
    params: { left: 0.12, top: 0.18, right: 0.62, bottom: 0.78, angle: 6 },
  });
  const straightened = await maskReadout(engineUrl, spacePhoto, spaceOp.id);
  const turn = Math.hypot(straightened.x - uncropped.x, straightened.y - uncropped.y);
  if (turn > 0.03) {
    throw new Error(`the straighten moved the mask ${turn.toFixed(3)} off its subject`);
  }
  console.log(
    `[shot] after a 6° straighten the centroid is` +
      ` (${straightened.x.toFixed(3)}, ${straightened.y.toFixed(3)}), drift ${turn.toFixed(4)}`,
  );

  // The after half: the crop and the straighten reached the viewer through `stack.changed`,
  // and the tint sits on the same feature it did before them.
  await window.waitForTimeout(900);
  const croppedPath = outputPath.replace(/\.png$/, "-cropped.png");
  await capture(croppedPath);
  console.log(`[shot] wrote ${croppedPath}`);
} else if (flow === "zoom") {
  // Zoom and pan: `view.render`'s viewport. Nothing here is edit state — the stack never
  // changes — so every assertion is about the readout and about the frame the engine sends.
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

  const zoomLevel = async (): Promise<string> =>
    (await window.locator("[data-zoom-level]").textContent())?.trim() ?? "";
  const zoomIs = async (text: string): Promise<void> => {
    await window.waitForFunction(
      (expected: string) =>
        document.querySelector("[data-zoom-level]")?.textContent?.trim() === expected,
      text,
      poll,
    );
  };
  const zoomChanged = async (from: string): Promise<string> => {
    await window.waitForFunction(
      (was: string) => document.querySelector("[data-zoom-level]")?.textContent?.trim() !== was,
      from,
      poll,
    );
    return zoomLevel();
  };

  await zoomIs("Fit");
  console.log("[shot] a fresh view opens fitted");

  const viewer = window.locator("[data-overlay-canvas]").first();
  const box =
    (await viewer.boundingBox()) ?? (await window.locator("canvas").first().boundingBox());
  if (!box) throw new Error("the viewer has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await window.mouse.move(centre.x, centre.y);

  // Z is fit ↔ 1:1, and 1:1 is one image pixel per device pixel whatever the photo's size.
  await window.keyboard.press("z");
  await zoomIs("100%");
  console.log(`[shot] Z went to ${await zoomLevel()}`);
  const actualPath = outputPath.replace(/\.png$/, "-1to1.png");
  await capture(actualPath);
  console.log(`[shot] wrote ${actualPath}`);

  // Ctrl+wheel zooms at the cursor, off-centre so the pan it implies is visible.
  const at = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.32 };
  await window.mouse.move(at.x, at.y);
  let level = await zoomLevel();
  for (let step = 0; step < 3; step++) {
    await window.mouse.wheel(0, -120);
    level = await zoomChanged(level);
  }
  console.log(`[shot] three Ctrl-less wheel notches at the cursor: ${level}`);
  const wheelPath = outputPath.replace(/\.png$/, "-wheel.png");
  await capture(wheelPath);
  console.log(`[shot] wrote ${wheelPath}`);

  // A middle-button drag pans. The zoom must not move with it — a pan is a pan.
  await window.mouse.move(centre.x, centre.y);
  await window.mouse.down({ button: "middle" });
  for (let step = 1; step <= 6; step++) {
    await window.mouse.move(
      centre.x - box.width * 0.03 * step,
      centre.y - box.height * 0.02 * step,
    );
    await window.waitForTimeout(24);
  }
  await window.mouse.up({ button: "middle" });
  await window.waitForTimeout(700);
  if ((await zoomLevel()) !== level) {
    throw new Error(`the pan changed the zoom: ${level} → ${await zoomLevel()}`);
  }
  console.log(`[shot] a middle-button drag panned at ${level}`);
  const panPath = outputPath.replace(/\.png$/, "-pan.png");
  await capture(panPath);
  console.log(`[shot] wrote ${panPath}`);

  // Ctrl+0 is back to fit, and the mask overlay has to land on the right pixels at every
  // step in between — which is the same `imageTransform` the masks flow asserts.
  await window.keyboard.press("Control+0");
  await zoomIs("Fit");
  console.log("[shot] Ctrl+0 went back to Fit");
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else if (flow === "pan") {
  // What a pan and a zoom out uncover before the engine's next frame lands (#74). A frame
  // normally lands within a screenshot's own latency, so the flow holds the engine instead:
  // a sleeping `python.run` on a socket of its own blocks the engine's one thread, and every
  // capture taken meanwhile shows only what the viewer already had.
  const stallEngine = async (seconds: number): Promise<void> => {
    const socket = new WebSocket(engineUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const code = `import time\ntime.sleep(${seconds})`;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "python.run", params: { code } }));
    socket.addEventListener("message", () => socket.close(), { once: true });
  };

  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );
  const viewer = window.locator("[data-overlay-canvas]").first();
  const box =
    (await viewer.boundingBox()) ?? (await window.locator("canvas").first().boundingBox());
  if (!box) throw new Error("the viewer has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await window.mouse.move(centre.x, centre.y);
  await window.keyboard.press("z");
  await window.waitForFunction(
    () => document.querySelector("[data-zoom-level]")?.textContent?.trim() === "100%",
    null,
    { timeout: 15_000, polling: 200 },
  );
  await window.waitForTimeout(1500);

  // A middle-button drag a third of the view across while the engine is held.
  await stallEngine(3);
  await window.waitForTimeout(200);
  await window.mouse.down({ button: "middle" });
  for (let step = 1; step <= 20; step++) {
    await window.mouse.move(centre.x + step * 20, centre.y + step * 12);
    await window.waitForTimeout(16);
  }
  const panPath = outputPath.replace(/\.png$/, "-mid-pan.png");
  await capture(panPath);
  await window.mouse.up({ button: "middle" });
  console.log(`[shot] wrote ${panPath}`);
  await window.waitForTimeout(4000);

  // Four wheel notches out while the engine is held.
  await stallEngine(3);
  await window.waitForTimeout(200);
  for (let notch = 0; notch < 4; notch++) {
    await window.mouse.wheel(0, 120);
    await window.waitForTimeout(30);
  }
  const zoomOutPath = outputPath.replace(/\.png$/, "-mid-zoom-out.png");
  await capture(zoomOutPath);
  console.log(
    `[shot] wrote ${zoomOutPath} at ${await window.locator("[data-zoom-level]").textContent()}`,
  );
  await window.waitForTimeout(4000);
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else if (flow === "crop") {
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

  const opened = await engineCall<{ photoId: number }>(engineUrl, "photo.open", {
    path: photoPath,
  });
  const photoId = opened.result.photoId;

  interface CropOp {
    left: number;
    top: number;
    right: number;
    bottom: number;
    angle: number;
  }

  /** The `crop` op as the engine holds it — the assertion, not what the column says. */
  async function cropParams(): Promise<CropOp> {
    const state = await engineCall<{ stack: { op: string; params: Record<string, number> }[] }>(
      engineUrl,
      "stack.get",
      { photoId },
    );
    const params = state.result.stack.find((entry) => entry.op === "crop")?.params ?? {};
    const value = (name: string, fallback: number): number =>
      typeof params[name] === "number" ? params[name] : fallback;
    return {
      left: value("left", 0),
      top: value("top", 0),
      right: value("right", 1),
      bottom: value("bottom", 1),
      angle: value("angle", 0),
    };
  }

  /** The image rect the engine reports, with and without the crop tool's geometry flag. */
  async function contentRect(geometry?: "full"): Promise<number[]> {
    const view = await engineCall<{ viewId: number }>(engineUrl, "view.open", {
      photoId,
      width: 240,
      height: 160,
    });
    const viewId = view.result.viewId;
    const params = geometry ? { viewId, geometry } : { viewId };
    const rendered = await engineCall<{ contentRect: number[] }>(engineUrl, "view.render", params);
    await engineCall(engineUrl, "view.close", { viewId });
    return rendered.result.contentRect ?? [];
  }

  /** Where the photo sits on the overlay canvas: the column publishes it for this. */
  async function imageBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    const canvas = await window.locator("[data-overlay-canvas]").boundingBox();
    const attribute = await window.locator('[data-pane="crop"]').getAttribute("data-crop-frame");
    if (!canvas || !attribute) throw new Error("the crop overlay has no box");
    const [x = 0, y = 0, width = 0, height = 0] = attribute.split(",").map(Number);
    return { x: canvas.x + x, y: canvas.y + y, width, height };
  }

  /** A point of the photo, 0..1 across it, in screen coordinates. */
  function at(
    frame: { x: number; y: number; width: number; height: number },
    u: number,
    v: number,
  ): { x: number; y: number } {
    return { x: frame.x + frame.width * u, y: frame.y + frame.height * v };
  }

  // R is the way in. The column mounting is what puts the viewer on the uncropped frame.
  await window.keyboard.press("r");
  await window.waitForSelector('[data-pane="crop"]', { timeout: 10_000 });
  await window.waitForSelector('[data-rail-mode="crop"][data-active="true"]', { timeout: 5_000 });
  await window.waitForTimeout(400);
  const enterPath = outputPath.replace(/\.png$/, "-enter.png");
  await capture(enterPath);
  console.log(`[shot] R opened the crop tool, wrote ${enterPath}`);

  // Drag the bottom-right grip in. The rect starts as the whole photo, so the grip is on
  // the image's corner.
  const frame = await imageBox();
  const corner = at(frame, 1, 1);
  const target = at(frame, 0.72, 0.78);
  await window.mouse.move(corner.x - 1, corner.y - 1);
  await window.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await window.mouse.move(
      corner.x + ((target.x - corner.x) * step) / 8,
      corner.y + ((target.y - corner.y) * step) / 8,
    );
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
  await window.waitForFunction(
    () => Number(document.querySelector('[data-pane="crop"]')?.getAttribute("data-crop-right")) < 1,
    null,
    poll,
  );
  const dragged = await cropParams();
  if (!(dragged.right < 0.95) || !(dragged.bottom < 0.95)) {
    throw new Error(`the corner drag did not reach the crop op: ${JSON.stringify(dragged)}`);
  }
  console.log(
    `[shot] corner drag wrote crop ${dragged.left.toFixed(3)}/${dragged.top.toFixed(3)} →` +
      ` ${dragged.right.toFixed(3)}/${dragged.bottom.toFixed(3)}`,
  );
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // The aspect menu: 1:1 locks the ratio and refits the rect.
  await window.locator('[data-crop-aspect] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "1:1" }).click();
  await window.waitForSelector('[data-pane="crop"][data-crop-locked="true"]', { timeout: 5_000 });
  await window.waitForTimeout(300);
  const square = await cropParams();
  // A 1:1 crop is square against the photo, not against its own numbers: the box is
  // normalised over the image, so the check needs the shape of the image the engine drew.
  const drawn = await imageBox();
  const ratio =
    ((drawn.width / drawn.height) * (square.right - square.left)) / (square.bottom - square.top);
  if (Math.abs(ratio - 1) > 0.02) {
    throw new Error(`1:1 left the crop at ${ratio.toFixed(3)} : 1, ${JSON.stringify(square)}`);
  }
  const squarePath = outputPath.replace(/\.png$/, "-square.png");
  await capture(squarePath);
  console.log(
    `[shot] 1:1 fitted a square crop (${ratio.toFixed(3)} : 1) out of a` +
      ` ${(drawn.width / drawn.height).toFixed(2)} : 1 image, wrote ${squarePath}`,
  );

  // Straighten by 5°, typed into the readout the same way any slider takes a value.
  await window.locator('[data-pane="crop"] [data-readout="angle"]').click();
  await window.locator('[data-pane="crop"] input[aria-label="Straighten"]').fill("5");
  await window.keyboard.press("Enter");
  await window.waitForFunction(
    () => document.querySelector('[data-pane="crop"]')?.getAttribute("data-crop-angle") === "5",
    null,
    poll,
  );
  const straightened = await cropParams();
  if (straightened.angle !== 5) {
    throw new Error(`straighten wrote ${String(straightened.angle)}, not 5`);
  }
  console.log(
    `[shot] straighten 5° kept the crop on the photo:` +
      ` ${straightened.left.toFixed(3)}/${straightened.top.toFixed(3)} →` +
      ` ${straightened.right.toFixed(3)}/${straightened.bottom.toFixed(3)}`,
  );
  const straightenPath = outputPath.replace(/\.png$/, "-straighten.png");
  await capture(straightenPath);
  console.log(`[shot] wrote ${straightenPath}`);

  // The flag is per render and not a stack edit: the same state answers with two rects.
  const cropped = await contentRect();
  const whole = await contentRect("full");
  // The flag's rect is the uncropped image and the plain one is that image with the crop
  // on it, so the two shapes differ by exactly the crop's own proportions.
  const wholeAspect = (whole[2] ?? 1) / (whole[3] ?? 1);
  const croppedAspect = (cropped[2] ?? 1) / (cropped[3] ?? 1);
  const expected =
    (wholeAspect * (straightened.right - straightened.left)) /
    (straightened.bottom - straightened.top);
  if (cropped.join(",") === whole.join(",") || Math.abs(croppedAspect - expected) > 0.02) {
    throw new Error(
      `geometry: "full" did not answer with the uncropped image: ${cropped.join(",")} vs ` +
        `${whole.join(",")}, expected ${expected.toFixed(3)} : 1 cropped`,
    );
  }
  console.log(
    `[shot] view.render answers ${cropped.join(",")} cropped and ${whole.join(",")} with` +
      ` geometry: "full"`,
  );

  // Esc leaves; the viewer goes back to the cropped frame and the crop stays on the stack.
  await window.keyboard.press("Escape");
  await window.waitForSelector('[data-rail-mode="edit"][data-active="true"]', { timeout: 5_000 });
  await window.waitForTimeout(500);
  const afterLeaving = await cropParams();
  if (afterLeaving.angle !== 5 || afterLeaving.right !== straightened.right) {
    throw new Error("leaving the tool changed the crop");
  }
  const leavePath = outputPath.replace(/\.png$/, "-leave.png");
  await capture(leavePath);
  console.log(`[shot] Esc left the tool, the crop is still on the stack, wrote ${leavePath}`);
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
} else if (flow === "presets") {
  await window.waitForSelector('[data-pane="presets"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );

  // Only the first group starts open; the rest are one click away.
  const openRows = await window.locator("[data-preset]").count();
  await window.locator('[data-preset-group="Cinematic"]').click();
  await window.waitForSelector('[data-preset="builtin:teal-orange"]', { timeout: 10_000 });
  console.log(`[shot] Presets opened with ${openRows} rows; Cinematic unfolded`);

  const stepsBefore = await window.locator("[data-history-step]").count();
  const exposureBefore = await window.locator('[data-op="exposure"] [data-readout]').textContent();
  await window.locator('[data-preset="builtin:teal-orange"]').click();

  // The preset's own exposure, read back off the slider it moved: the values went to the
  // engine and came back as the stack, rather than being drawn straight into the panel.
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: "+0.10 EV" },
    { timeout: 10_000 },
  );
  // The History pane asks the engine for the list once the cursor moves, so the rows land
  // after the frame does.
  await window.waitForFunction(
    (before: number) => document.querySelectorAll("[data-history-step]").length > before,
    stepsBefore,
    { timeout: 10_000 },
  );
  const stepsAfter = await window.locator("[data-history-step]").count();
  console.log(`[shot] Teal & orange applied: history ${stepsBefore} → ${stepsAfter} steps`);
  if (stepsAfter !== stepsBefore + 1) {
    throw new Error(`a preset must be one history step, got ${stepsAfter - stepsBefore}`);
  }
  // And that one step is named after the preset, not after whichever op sorts first.
  const newest = window.locator("[data-history-step]").first();
  console.log(
    `[shot] newest history row reads "${(await newest.innerText()).replace(/\n/g, " ")}"`,
  );
  // The History card sits under the preset list, which is now long enough to push it off
  // the bottom of the column.
  await newest.scrollIntoViewIfNeeded();

  // Unfolding it lists the ops the preset moved, each with its own revert. Only a step that
  // moved several carries the caret, so the newest row is the only one that has it.
  const carets = await window.locator("[data-history-unfold]").count();
  console.log(`[shot] ${carets} of ${stepsAfter} rows unfold`);
  await window.locator("[data-history-unfold]").first().click();
  await window.waitForSelector("[data-history-revert]", { timeout: 10_000 });
  const unfolded = await window.locator("[data-history-revert]").count();
  console.log(`[shot] the preset's row unfolded into ${unfolded} ops`);

  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // Reverting one of them puts that op back and leaves the rest of the preset alone: the
  // contrast the preset set is still +15 after the exposure it set is gone.
  await window.locator("[data-history-revert]").first().click();
  await window.waitForFunction(
    readoutIs,
    { op: "exposure", text: exposureBefore ?? "0.00 EV" },
    { timeout: 10_000 },
  );
  await window.waitForFunction(readoutIs, { op: "contrast", text: "+15" }, { timeout: 10_000 });
  console.log("[shot] one op reverted out of the preset; the rest of it stayed");

  // And one undo takes the whole look back off, every slider of it at once.
  await window.keyboard.press("Control+z");
  await window.keyboard.press("Control+z");
  await window.waitForFunction(readoutIs, { op: "contrast", text: "0" }, { timeout: 10_000 });
  console.log("[shot] undo took the revert, then the whole preset, back off");
} else if (flow === "history") {
  await window.waitForSelector('[data-pane="presets"]', { timeout: 30_000 });
  await window.waitForSelector('[data-pane="history"] [data-history-step]', { timeout: 30_000 });
  const rowCount = (): Promise<number> => window.locator("[data-history-step]").count();
  const waitForRows = (count: number): Promise<unknown> =>
    window.waitForFunction(
      (want: number) => document.querySelectorAll("[data-history-step]").length === want,
      count,
      { timeout: 10_000 },
    );

  // One preset applied and undone, then a different one: the first is not thrown away but
  // left as a branch beside the second.
  const start = await rowCount();
  await window.locator('[data-preset-group="Cinematic"]').click();
  await window.locator('[data-preset="builtin:teal-orange"]').click();
  await waitForRows(start + 1);
  await window.keyboard.press("Control+z");
  await window.waitForSelector("[data-history-merge]", { timeout: 10_000 });
  const firstOpen = window.locator("[data-preset]").first();
  const secondPreset = await firstOpen.getAttribute("data-preset");
  await firstOpen.click();
  await waitForRows(start + 2);
  const lanes = await window
    .locator("[data-history-lane]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-history-lane")));
  console.log(`[shot] teal & orange undone, ${secondPreset} applied: lanes ${lanes.join(" ")}`);
  if (!lanes.includes("1")) throw new Error("the undone preset should sit on a second lane");
  await window.locator('[data-pane="history"]').scrollIntoViewIfNeeded();
  await capture(outputPath.replace(/\.png$/, "-branch.png"));

  // Merging the old branch back: one more step, with both presets' ops in the stack.
  await window.locator("[data-history-merge]").first().click();
  await waitForRows(start + 3);
  const newest = window.locator("[data-history-step]").first();
  console.log(
    `[shot] merged: newest row reads "${(await newest.innerText()).replace(/\n/g, " ")}"`,
  );
  if (!(await newest.innerText()).startsWith("Merged “Teal & orange applied”")) {
    throw new Error("the newest step should be the merge");
  }
  await window.waitForFunction(
    () => document.querySelectorAll("[data-history-merge]").length === 0,
    null,
    {
      timeout: 10_000,
    },
  );
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);
} else if (flow === "export") {
  // The Export rail mode end to end: pick a format and a colour space, type a folder, run
  // it, and wait for the bar to report `done`. On `--engine real` the file it names is
  // opened afterwards and its header checked, because "the job said done" is not the same
  // claim as "there is a decodable JPEG on disk".
  const outputDir = mkdtempSync(join(tmpdir(), "latent-export-"));
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000 },
  );

  // An edit first, so the exported file is provably the developed picture and not the raw.
  const exposure = window.locator('[data-op="exposure"] [role="slider"]');
  const exposureBox = await exposure.boundingBox();
  if (!exposureBox) throw new Error("exposure slider has no box");
  await window.mouse.move(
    exposureBox.x + exposureBox.width / 2,
    exposureBox.y + exposureBox.height / 2,
  );
  await window.mouse.down();
  await window.mouse.move(
    exposureBox.x + exposureBox.width * 0.62,
    exposureBox.y + exposureBox.height / 2,
  );
  await window.mouse.up();

  await window.locator('[data-rail-mode="export"] button').click();
  await window.waitForSelector('[data-pane="export"]', { timeout: 10_000 });
  const covered = await window.locator('[data-pane="export"]').getAttribute("data-export-count");
  console.log(`[shot] the export pane covers ${covered} photo(s)`);

  await window.locator('[data-export-format] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "JPEG" }).click();
  await window.locator('[data-export-colorspace] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "Display P3" }).click();
  await window.locator('[data-export-size="longEdge"]').click();
  await window.locator("[data-export-long-edge]").fill("1600");
  await window.locator("[data-export-dir]").fill(outputDir);
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  await window.locator("[data-export-run] button").click();
  await window.waitForSelector('[data-export-job="done"]', { timeout: 180_000 });
  const status = await window.locator("[data-export-status]").innerText();
  console.log(`[shot] export finished: ${status}`);
  const donePath = outputPath.replace(/\.png$/, "-done.png");
  await capture(donePath);
  console.log(`[shot] wrote ${donePath}`);

  if (engineKind === "real") {
    const written = readdirSync(outputDir);
    if (written.length !== 1) throw new Error(`expected one exported file, got ${written.length}`);
    const file = join(outputDir, written[0] ?? "");
    const bytes = readFileSync(file);
    // SOI + the JFIF APP0 the encoder writes, then the ICC_PROFILE APP2 spliced in after it.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`${file} is not a JPEG`);
    if (!bytes.includes(Buffer.from("ICC_PROFILE"))) throw new Error(`${file} carries no ICC`);
    console.log(`[shot] ${file} is ${bytes.length} bytes of JPEG with an embedded profile`);
  }
} else if (flow === "merge") {
  // Photo Merge end to end. The photos come in over our own socket; against the real
  // engine that is `--dir`, walked recursively, because a merge needs raws it can decode
  // and the fixtures are empty files only the mock pretends to read.
  const poll = { timeout: 60_000, polling: 200 };
  await window.waitForSelector('[data-pane="filmstrip"]', { timeout: 30_000 });
  await engineCall<{ jobId: number }>(engineUrl, "catalog.import", {
    paths: engineKind === "real" ? [importDir] : writeFixturePhotos(),
    recursive: engineKind === "real",
  });
  await window.waitForFunction(
    () => document.querySelectorAll('[data-pane="filmstrip"] [data-photo-id]').length >= 3,
    null,
    poll,
  );

  // Three photos: a plain click opens the first, Ctrl+click adds the next two without
  // opening them. Photo Merge only appears once the selection is worth merging.
  const cells = window.locator('[data-pane="filmstrip"] [data-photo-id]');
  await cells.nth(0).click();
  await cells.nth(1).click({ modifiers: ["Control"] });
  await cells.nth(2).click({ modifiers: ["Control"] });
  // Photo Merge lives in the library, and the library is the grid's left column: G is what
  // puts it on screen. The selection is the strip's either way.
  await window.keyboard.press("g");
  await window.waitForSelector('[data-photo-merge="3"]', { timeout: 10_000 });
  console.log("[shot] 3 photos selected; the library offered Photo Merge");

  await window.locator('[data-merge-start="hdr"] button').click();
  await window.waitForSelector('[data-pane="merge"]', { timeout: 10_000 });
  // The grid is a modal pane over the centre region, so it also sits over the dialog it
  // just opened: G again puts the dialog on top, which is where the user drives it from.
  await window.keyboard.press("g");
  await window.waitForSelector('[data-pane="grid"]', { state: "detached", timeout: 10_000 });

  // The preview is a PNG the engine rendered and serves off its own listener; the dialog
  // only ever puts the URL it was handed into an <img>. `naturalWidth` is the proof that
  // the bytes arrived and decoded, not just that a src was set.
  const previewLoaded = (): boolean => {
    const image = document.querySelector("[data-merge-preview]");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  };
  await window.waitForFunction(previewLoaded, null, poll);
  let previewSource = await window.locator("[data-merge-preview]").getAttribute("src");
  console.log(`[shot] merge.preview answered ${previewSource}`);
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  /**
   * The picture after a change. Two things make this more than one wait: the dialog keeps
   * the last preview on screen while the next job runs, so the src has to move before
   * anything is proven; and a slider drag queues a second job behind the one in flight, so
   * the src has to stop moving before the shot is of the settled picture.
   */
  async function previewAfter(previous: string | null): Promise<string | null> {
    await window.waitForFunction(
      (was: string | null) =>
        document.querySelector("[data-merge-preview]")?.getAttribute("src") !== was,
      previous,
      poll,
    );
    let source = await window.locator("[data-merge-preview]").getAttribute("src");
    for (let attempt = 0; attempt < 20; attempt++) {
      await window.waitForTimeout(300);
      const current = await window.locator("[data-merge-preview]").getAttribute("src");
      if (current === source) break;
      source = current;
    }
    await window.waitForFunction(previewLoaded, null, poll);
    return source;
  }

  // Deghost Medium is a different picture, so the dialog asks for a second preview and the
  // <img> swaps to the URL of the PNG that job wrote.
  await window.locator('[data-merge-deghost] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "Medium" }).click();
  previewSource = await previewAfter(previewSource);
  const deghostPath = outputPath.replace(/\.png$/, "-deghost.png");
  await capture(deghostPath);
  console.log(`[shot] Deghost Medium re-rendered the preview; wrote ${deghostPath}`);

  // Panorama swaps the option set for the stitching half and the picture for a much wider
  // one. Boundary Warp is a drag on the panel column's own slider, so the preview coalesces
  // the whole gesture into one more `merge.preview`.
  await window.locator('[data-merge-kind-button="panorama"]').click();
  await window.waitForSelector('[data-merge-section="panorama"]', { timeout: 10_000 });
  previewSource = await previewAfter(previewSource);
  const hdrSections = await window.locator('[data-merge-section="hdr"]').count();
  const warpTrack = window.locator('[data-pane="merge"] [role="slider"]');
  const warpBox = await warpTrack.boundingBox();
  if (!warpBox) throw new Error("the Boundary Warp slider has no box");
  await window.mouse.move(warpBox.x + warpBox.width * 0.1, warpBox.y + warpBox.height / 2);
  await window.mouse.down();
  for (let step = 1; step <= 6; step++) {
    await window.mouse.move(
      warpBox.x + warpBox.width * (0.1 + 0.1 * step),
      warpBox.y + warpBox.height / 2,
    );
    await window.waitForTimeout(30);
  }
  await window.mouse.up();
  previewSource = await previewAfter(previewSource);
  const warp = await window.locator("[data-merge-warp]").innerText();
  console.log(
    `[shot] Panorama shows ${hdrSections} HDR sections; Boundary Warp dragged to ${warp}`,
  );
  const panoramaPath = outputPath.replace(/\.png$/, "-panorama.png");
  await capture(panoramaPath);
  console.log(`[shot] wrote ${panoramaPath}`);

  // Star Trails swaps the option set again: a night sequence is stacked, not stitched, so
  // neither of the other two halves is on screen and the preview is a lighten of the frames.
  await window.locator('[data-merge-kind-button="starTrail"]').click();
  await window.waitForSelector('[data-merge-section="starTrail"]', { timeout: 10_000 });
  previewSource = await previewAfter(previewSource);
  const stitchSections = await window.locator('[data-merge-section="panorama"]').count();
  await window.locator('[data-merge-foreground] [aria-haspopup="listbox"]').click();
  await window.getByRole("option", { name: "First frame" }).click();
  previewSource = await previewAfter(previewSource);
  const foreground = await window
    .locator("[data-merge-foreground]")
    .getAttribute("data-merge-foreground");
  console.log(
    `[shot] Star Trails shows ${stitchSections} panorama sections; foreground ${foreground}`,
  );
  const trailsPath = outputPath.replace(/\.png$/, "-startrail.png");
  await capture(trailsPath);
  console.log(`[shot] wrote ${trailsPath}`);

  // Back to HDR for the merge itself, which is the kind the library asked for.
  await window.locator('[data-merge-kind-button="hdr"]').click();
  await window.waitForSelector('[data-merge-section="hdr"]', { timeout: 10_000 });
  await previewAfter(previewSource);

  // Merge: the job ticks, the engine writes the TIFF and registers it, and the dialog
  // opens that row and shuts — the merged photo is a catalog photo like any other.
  // The catalog's total, not the strip's cell count: with a full page of photos the
  // merged one lands on a later page and the visible cells never change.
  const photoCount = window.locator('[data-pane="filmstrip"] [data-photo-count]');
  const before = Number(await photoCount.getAttribute("data-photo-count"));
  await window.locator("[data-merge-run] button").click();
  await window.waitForSelector("[data-merge-progress]", { timeout: 60_000 });
  await window.waitForSelector('[data-pane="merge"]', { state: "detached", timeout: 300_000 });
  await window.waitForFunction(
    (previous: number) =>
      Number(
        document
          .querySelector('[data-pane="filmstrip"] [data-photo-count]')
          ?.getAttribute("data-photo-count"),
      ) > previous,
    before,
    poll,
  );
  const after = Number(await photoCount.getAttribute("data-photo-count"));
  const opened = await window.locator("[data-photo-id]").first().getAttribute("title");
  console.log(`[shot] merge done: catalog went ${before} → ${after} photos, newest ${opened}`);

  const resultPath = outputPath.replace(/\.png$/, "-result.png");
  await capture(resultPath);
  console.log(`[shot] wrote ${resultPath}`);
} else if (flow === "generative") {
  // Generative fill end to end (PROMPT.md §3.5): a radial mask in the Masks column, a fill
  // op that takes it, a run through the backend, the result composited into the frame, and
  // the stale badge that an edit underneath produces. With `--engine real` set
  // LATENT_GENERATIVE_STUB=1 unless ComfyUI is running: a fill that has to wait on a
  // sampler is not a screenshot.
  const poll = { timeout: 20_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );

  // One op to hang a mask on, the way the Masks column expects.
  const track = window.locator('[data-op="exposure"] [role="slider"]');
  const box = await track.boundingBox();
  if (!box) throw new Error("exposure slider has no box");
  await window.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await window.waitForFunction(readoutIs, { op: "exposure", text: "+1.00 EV" }, poll);

  // The Masks panel is the rail's flyout and stays open: clicking the button again would
  // close it, so it is only pressed when it is not already up.
  if ((await window.locator('[data-rail-pane="masks"]').getAttribute("data-open")) !== "true") {
    await window.locator('[data-rail-pane="masks"] button').click();
  }
  await window.waitForSelector('[data-pane="masks"]', { timeout: 10_000 });
  await window.waitForSelector("[data-create-mask]", { timeout: 10_000 });
  await window.locator("[data-create-mask] button").click();
  await window.locator('[data-add-component] [data-add-kind="radial"]').click();
  await window.waitForSelector('[data-mask-component="radial1"]', { timeout: 10_000 });
  console.log("[shot] a radial mask on the exposure layer");

  // The rail's Generative column. Its entry buttons take the mask of the selected layer,
  // so the fill arrives with a region already.
  await window.locator('[data-rail-mode="generative"] button').click();
  await window.waitForSelector('[data-pane="generative"]', { timeout: 10_000 });
  const backend = await window
    .locator("[data-generative-status]")
    .innerText()
    .catch(() => "");
  console.log(`[shot] backend: ${backend.trim()}`);

  await window.getByRole("button", { name: "Generative Fill" }).click();
  await window.waitForFunction(
    () => {
      const pane = document.querySelector('[data-pane="generative"]');
      return (pane?.getAttribute("data-generative-op") ?? "") !== "";
    },
    null,
    poll,
  );
  await window.locator("[data-generative-prompt]").fill("a bunch of wildflowers");
  await window.locator("[data-generative-prompt]").blur();
  await window.locator("[data-roll-seed] button").click();
  const beforePath = outputPath.replace(/\.png$/, "-before.png");
  await capture(beforePath);
  console.log(`[shot] wrote ${beforePath}`);

  const startedAt = Date.now();
  await window.locator("[data-generative-run] button").click();
  // The run is a job: it ticks job.progress and lands as a stack.changed with `result` set.
  await window.waitForFunction(
    () => {
      const pane = document.querySelector('[data-pane="generative"]');
      if (!pane) return false;
      const done = pane.getAttribute("data-generative-running") === "false";
      return done && document.querySelector("[data-generative-result]") !== null;
    },
    null,
    { timeout: 600_000, polling: 250 },
  );
  const elapsed = Date.now() - startedAt;
  const result = await window.locator("[data-generative-result]").innerText();
  const ran = await window
    .locator("[data-generative-ran]")
    .innerText()
    .catch(() => "");
  console.log(`[shot] run finished in ${elapsed} ms: ${result.trim()} ${ran.trim()}`);
  const error = await window
    .locator("[data-generative-error]")
    .innerText()
    .catch(() => "");
  if (error) console.log(`[shot] the run reported: ${error.trim()}`);

  await window.waitForTimeout(400);
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // An op that renders *below* the composite changes the pixels the model saw, so the
  // result goes stale — and keeps rendering, because a re-run is always explicit.
  const opened = await engineCall<{ photoId: number }>(engineUrl, "photo.open", {
    path: photoPath,
  });
  await engineCall<{ revision: number }>(engineUrl, "op.add", {
    photoId: opened.result.photoId,
    op: "noise_reduction",
    params: { luminance: 60 },
  });
  await window.waitForSelector('[data-pane="generative"][data-generative-stale="true"]', {
    timeout: 15_000,
  });
  const stalePath = outputPath.replace(/\.png$/, "-stale.png");
  await capture(stalePath);
  console.log(`[shot] an edit under the fill marked it stale; wrote ${stalePath}`);
} else if (flow === "enhance") {
  // AI Denoise and AI Upscale end to end (issues #51, #52). Neither takes a mask: the
  // column adds one op, the engine renders the whole frame under it, the backend answers
  // with a raster and the composite puts it over the content rect. What this flow is really
  // checking is that the two columns drive a run without a region and that the stale rule
  // applies to them the same way it does to a fill.
  const poll = { timeout: 20_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );

  const runColumn = async (mode: string, name: string): Promise<void> => {
    await window.locator(`[data-rail-mode="${mode}"] button`).click();
    await window.waitForSelector(`[data-pane="${mode}"]`, poll);
    const backend = await window
      .locator(`[data-${mode}-status]`)
      .innerText()
      .catch(() => "");
    console.log(`[shot] ${mode} backend: ${backend.trim()}`);
    await window.locator(`[data-${mode}-add] button`).click();
    await window.waitForFunction(
      (pane: string) => {
        const column = document.querySelector(`[data-pane="${pane}"]`);
        return (column?.getAttribute(`data-${pane}-op`) ?? "") !== "";
      },
      mode,
      poll,
    );
    console.log(`[shot] added ${name}`);
  };

  await runColumn("denoise", "AI Denoise");
  const beforePath = outputPath.replace(/\.png$/, "-before.png");
  await capture(beforePath);
  console.log(`[shot] wrote ${beforePath}`);

  const awaitRun = async (mode: string): Promise<void> => {
    const startedAt = Date.now();
    await window.locator(`[data-${mode}-run] button`).click();
    await window.waitForFunction(
      (pane: string) => {
        const column = document.querySelector(`[data-pane="${pane}"]`);
        if (!column) return false;
        const done = column.getAttribute(`data-${pane}-running`) === "false";
        return done && document.querySelector(`[data-${pane}-result]`) !== null;
      },
      mode,
      { timeout: 600_000, polling: 250 },
    );
    const result = await window.locator(`[data-${mode}-result]`).innerText();
    const error = await window
      .locator(`[data-${mode}-error]`)
      .innerText()
      .catch(() => "");
    console.log(`[shot] ${mode} ran in ${Date.now() - startedAt} ms: ${result.trim()}`);
    if (error) console.log(`[shot] the ${mode} run reported: ${error.trim()}`);
  };

  await awaitRun("denoise");
  await window.waitForTimeout(400);
  await capture(outputPath);
  console.log(`[shot] wrote ${outputPath}`);

  // Upscale on top of the denoise: 4x, which the column states as an export size rather
  // than changing anything the preview shows.
  await runColumn("upscale", "AI Upscale");
  await window.locator('[data-upscale-factor-option="4x"] button').click();
  await window.waitForSelector('[data-pane="upscale"][data-upscale-factor="4x"]', poll);
  await awaitRun("upscale");
  const upscalePath = outputPath.replace(/\.png$/, "-upscale.png");
  await window.waitForTimeout(400);
  await capture(upscalePath);
  console.log(`[shot] wrote ${upscalePath}`);

  // An op that renders below both rasters changes the pixels the models saw, so both go
  // stale — and both keep rendering, because a re-run is always explicit.
  const opened = await engineCall<{ photoId: number }>(engineUrl, "photo.open", {
    path: photoPath,
  });
  await engineCall<{ revision: number }>(engineUrl, "op.add", {
    photoId: opened.result.photoId,
    op: "lens_correction",
    params: { distortion: 20 },
  });
  await window.waitForSelector('[data-pane="upscale"][data-upscale-stale="true"]', {
    timeout: 15_000,
  });
  const stalePath = outputPath.replace(/\.png$/, "-stale.png");
  await capture(stalePath);
  console.log(`[shot] an edit under the rasters marked them stale; wrote ${stalePath}`);
} else if (flow === "relight") {
  // Relight end to end (PROMPT.md §3.8): the depth map estimated from the rail, a light
  // added and dragged to where the sun is, its rays turned up. Worth running against a
  // backlit photo with something in front of the light — `--photo <a tree>` — because that
  // is the whole point of shading against depth rather than painting a bright patch.
  const poll = { timeout: 20_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );

  await window.locator('[data-rail-mode="relight"] button').click();
  await window.waitForSelector('[data-pane="relight"]', { timeout: 10_000 });
  const beforePath = outputPath.replace(/\.png$/, "-before.png");
  await capture(beforePath);
  console.log(`[shot] the Relight column, no depth map yet; wrote ${beforePath}`);

  // The model is a job, and on a cold store it is the first ONNX session of the run.
  const startedAt = Date.now();
  await window.locator("[data-relight-estimate] button").click();
  try {
    // The model itself is under a second on this machine and a cold CUDA session a few more,
    // so ten is the whole budget: past that the job has failed rather than gone slow, and the
    // column already knows why.
    await window.waitForSelector('[data-pane="relight"][data-relight-depth="true"]', {
      timeout: 10_000,
    });
  } catch (error) {
    const said = await window
      .locator("[data-relight-error], [data-relight-status]")
      .allInnerTexts();
    throw new Error(`depth.estimate never landed; the column says ${said.join(" / ")}`, {
      cause: error,
    });
  }
  const status = await window.locator("[data-relight-status]").innerText();
  console.log(`[shot] depth in ${Date.now() - startedAt} ms: ${status.trim()}`);

  // The map itself, over the photo: near is white, far is black.
  await window.locator("[data-relight-show-depth] button").click();
  await window.waitForTimeout(500);
  const depthPath = outputPath.replace(/\.png$/, "-depth.png");
  await capture(depthPath);
  console.log(`[shot] the depth map over the photo; wrote ${depthPath}`);
  await window.locator("[data-relight-show-depth] button").click();

  await window.locator("[data-relight-add] button").click();
  await window.waitForFunction(
    () => {
      const pane = document.querySelector('[data-pane="relight"]');
      return (pane?.getAttribute("data-relight-op") ?? "") !== "";
    },
    null,
    poll,
  );

  // Drag the light onto the photo. The overlay's rect is the drawn picture, not the canvas:
  // the canvas fills the viewer and the columns float over it.
  const overlay = window.locator("[data-overlay-canvas]");
  const box = await overlay.boundingBox();
  if (!box) throw new Error("the viewer overlay has no box");
  const drawn = (await overlay.getAttribute("data-overlay-rect"))?.split(",").map(Number) ?? [];
  const [rectX = 0, rectY = 0, rectWidth = 0, rectHeight = 0] = drawn;
  if (rectWidth <= 0 || rectHeight <= 0) throw new Error("the viewer drew no photo");
  const from = { x: box.x + rectX + rectWidth * 0.5, y: box.y + rectY + rectHeight * 0.35 };
  const to = { x: box.x + rectX + rectWidth * 0.44, y: box.y + rectY + rectHeight * 0.16 };
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await window.mouse.move(
      from.x + ((to.x - from.x) / 10) * step,
      from.y + ((to.y - from.y) / 10) * step,
    );
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
  // The column's own readout is the proof the drag reached the stack: `y` is a 0..1 image
  // coordinate and the drag ended near the top of the frame.
  await window.waitForFunction(
    () => {
      const row = document.querySelector('[data-op="relight"][data-param="y"] [data-readout]');
      return row !== null && Number(row.textContent) < 0.25;
    },
    null,
    poll,
  );
  console.log("[shot] the light dragged up to the sun");

  // The volumetric half, from the column's own slider.
  const rays = window.locator('[data-op="relight"][data-param="rays"] [role="slider"]');
  const raysBox = await rays.boundingBox();
  if (!raysBox) throw new Error("the rays slider has no box");
  await window.mouse.click(raysBox.x + raysBox.width * 0.85, raysBox.y + raysBox.height / 2);
  await window.waitForTimeout(600);
  await capture(outputPath);
  console.log(`[shot] light and rays on; wrote ${outputPath}`);
} else if (flow === "planes") {
  // The Planes column: one freehand stroke drawn along a streak, every other streak in the
  // frame found from it. Worth running against a night frame with an aircraft trail in it —
  // `--photo <one of those>` — but any photo with straight bright lines shows the path,
  // because the detector knows about streaks and not about aircraft.
  const poll = { timeout: 20_000, polling: 200 };
  await window.waitForSelector('[data-op="exposure"]', { timeout: 30_000 });
  await window.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 300;
    },
    null,
    { timeout: 30_000, polling: 200 },
  );

  await window.locator('[data-rail-mode="planes"] button').click();
  await window.waitForSelector('[data-pane="planes"]', { timeout: 10_000 });

  // The gesture: a stroke drawn across the middle of the frame, in the overlay's own rect.
  const overlay = window.locator("[data-overlay-canvas]");
  const box = await overlay.boundingBox();
  if (!box) throw new Error("the viewer overlay has no box");
  const drawn = (await overlay.getAttribute("data-overlay-rect"))?.split(",").map(Number) ?? [];
  const [rectX = 0, rectY = 0, rectWidth = 0, rectHeight = 0] = drawn;
  if (rectWidth <= 0 || rectHeight <= 0) throw new Error("the viewer drew no photo");
  const from = { x: box.x + rectX + rectWidth * 0.32, y: box.y + rectY + rectHeight * 0.36 };
  const to = { x: box.x + rectX + rectWidth * 0.62, y: box.y + rectY + rectHeight * 0.44 };
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await window.mouse.move(
      from.x + ((to.x - from.x) / 10) * step,
      from.y + ((to.y - from.y) / 10) * step,
    );
    await window.waitForTimeout(16);
  }
  await window.mouse.up();

  // The column's own status is the proof the detection reached the engine and came back.
  await window.waitForFunction(
    () => {
      const said = document.querySelector("[data-planes-status]")?.textContent ?? "";
      return said !== "" && !said.includes("Detecting");
    },
    null,
    poll,
  );
  const status = await window.locator("[data-planes-status]").innerText();
  const seed = await window.locator("[data-planes-seed]").innerText();
  console.log(`[shot] ${status.trim()} — ${seed.trim()}`);
  await window.waitForTimeout(600);
  await capture(outputPath);
  console.log(`[shot] the Planes column with what it found; wrote ${outputPath}`);
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

  // Sorting is one catalog.list per change: cycle the strip bar's key round to file name,
  // then flip the direction, and the page comes back in the engine's order — the UI never
  // re-sorts rows itself.
  const sortButton = window.locator('[data-pane="strip-filter"] [data-sort] button').first();
  for (let attempt = 0; attempt < 6; attempt++) {
    if ((await window.locator('[data-pane="strip-filter"] [data-sort="filename"]').count()) > 0) {
      break;
    }
    await sortButton.click();
  }
  await window.waitForSelector('[data-pane="strip-filter"] [data-sort="filename"]', {
    timeout: 10_000,
  });
  await window.locator('[data-pane="strip-filter"] [data-sort] button').last().click();
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

  // Info is a card of the Edit column rather than a rail mode: the open photo's catalog
  // row, beside the sliders that are editing it.
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
  const pythonPath = outputPath.replace(/\.png$/, "-python.png");
  await capture(pythonPath);
  console.log(`[shot] wrote ${pythonPath}`);
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
  await window.keyboard.press("Control+Backquote");

  // More photos than the strip can hold: a vertical wheel over it scrolls it sideways, and
  // the cells are windowed — the track is as wide as the catalog, the DOM holds only what
  // is near the scrollport, so the cell count is the window's and never the catalog's.
  await engineCall<{ jobId: number }>(engineUrl, "catalog.import", {
    paths: [writeBulkFixture()],
    recursive: false,
  });
  await window.waitForFunction(
    () => {
      const count = document.querySelector('[data-pane="filmstrip"] [data-photo-count]');
      return Number(count?.getAttribute("data-photo-count") ?? 0) >= 40;
    },
    null,
    { timeout: 60_000 },
  );
  const scroller = window.locator('[data-pane="filmstrip"] [role="listbox"]');
  const windowed = await scroller.evaluate((element) => ({
    cells: element.querySelectorAll("[data-photo-id]").length,
    track: element.scrollWidth,
    port: element.clientWidth,
  }));
  console.log(
    `[shot] filmstrip windowed: ${windowed.cells} cells drawn for a ${windowed.track}px track` +
      ` in a ${windowed.port}px scrollport`,
  );
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

  // Drag exposure up: real pointer events, the same path a user's mouse takes. The boxed
  // slider scrubs relative to where the press landed — 800 px sweeps the whole range — so
  // 80 px of a −5…5 EV slider is exactly +1 EV however wide the column happens to be.
  const slider = window.locator('[data-op="exposure"] [role="slider"]');
  const box = await slider.boundingBox();
  if (!box) throw new Error("exposure slider has no box");
  const startX = box.x + box.width / 2 - 40;
  const centreY = box.y + box.height / 2;
  await window.mouse.move(startX, centreY);
  await window.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await window.mouse.move(startX + step * 10, centreY);
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

if (hold) {
  console.log("[shot] --hold: app stays up, Ctrl+C to stop");
  // The interval keeps the event loop alive; SIGINT exits through stopChildren.
  await new Promise<never>(() => setInterval(() => {}, 60_000));
}

await browser.close();
stopChildren();
process.exit(0);

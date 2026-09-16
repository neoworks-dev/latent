// Drives the real app and saves a PNG: the mock engine, Vite for the renderer, Electron
// under Playwright. Proof that the generated panels render and that dragging a slider
// reaches the engine and comes back as a frame.
//
//   node apps/desktop/scripts/screenshot.ts [--out /tmp/latent-ui.png] [--engine mock|real]
//                                           [--photo /path/to/raw]
//                                           [--flow slider|panels|catalog|latency]
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
const defaultOutput = flow === "catalog" ? "/tmp/latent-catalog.png" : "/tmp/latent-ui.png";
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
  /** Binary frames that arrived before the result — LTHM thumbnails, for the batch call. */
  frames: number;
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
  let frames = 0;
  const answered = new Promise<RpcAnswer<T>>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        frames += 1;
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
      ` in ${batch.frames} LTHM frames, missing [${batch.result.missing.join(",")}]`,
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

  await window.screenshot({ path: outputPath });
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
  await window.screenshot({ path: outputPath });
  console.log(`[shot] wrote ${outputPath}`);
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

  await window.screenshot({ path: outputPath });
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
  await window.screenshot({ path: foldedPath });
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
  await window.screenshot({ path: gridPath });
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
  await window.screenshot({ path: infoPath });
  console.log(`[shot] wrote ${infoPath}`);

  // Tab takes the side panes off, the way Lightroom's does, and puts them back.
  await window.keyboard.press("Tab");
  await window.waitForSelector('[data-chrome="sides"]', { timeout: 5_000 });
  const hidden = await window.locator('[data-pane="filmstrip"]').count();
  console.log(`[shot] Tab hid the side panes: ${hidden} filmstrip panes left on screen`);
  const hiddenPath = outputPath.replace(/\.png$/, "-tab.png");
  await window.screenshot({ path: hiddenPath });
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

  await window.screenshot({ path: outputPath });
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

  await window.screenshot({ path: outputPath });
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
  await window.screenshot({ path: externalPath });
  console.log(`[shot] external writer moved contrast to 60, wrote ${externalPath}`);
}

await app.close();
stopChildren();
process.exit(0);

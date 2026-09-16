// Drives the real app and saves a PNG: the mock engine, Vite for the renderer, Electron
// under Playwright. Proof that the generated panels render and that dragging a slider
// reaches the engine and comes back as a frame.
//
//   node apps/desktop/scripts/screenshot.ts [--out /tmp/latent-ui.png] [--engine mock|real]
//                                           [--photo /path/to/raw]
//
// `--engine real` spawns engine/build/dev/latentd instead of the mock; pair it with a real
// raw file via `--photo` (default: the mock's fake path).
//
// Node, not bun: Playwright's `_electron.launch` never resolves under bun 1.3 (it hangs
// after attaching to the inspector), while node runs it fine. Everything else is bun.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..", "..");
const editorDir = join(repoDir, "apps", "editor");
function argument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : String(process.argv[index + 1]);
}

const outputPath = argument("--out", "/tmp/latent-ui.png");
const externalPath = outputPath.replace(/\.png$/, "-external.png");
const engineKind = argument("--engine", "mock");
const photoPath = argument("--photo", "/tmp/demo.raf");
const engineCommand =
  engineKind === "real"
    ? [join(repoDir, "engine", "build", "dev", "latentd"), "--port", "0"]
    : ["bun", join(repoDir, "tools", "mock-engine.ts")];

/** Runs in the page: does the control's readout show this value yet? */
function readoutIs({ op, text }: { op: string; text: string }): boolean {
  return document.querySelector(`[data-op="${op}"] [data-readout]`)?.textContent === text;
}

const children: ChildProcess[] = [];

function start(command: string[], cwd: string): ChildProcess {
  const [executable, ...args] = command;
  // Own process group: bun and vite both fork, and killing the wrapper would leave the
  // real server holding its port.
  const child = spawn(String(executable), args, {
    cwd,
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

const engineProcess = start(engineCommand, repoDir);

const [, enginePort] = await waitForLine(
  engineProcess,
  /listening on ws:\/\/127\.0\.0\.1:(\d+)/,
  20_000,
);

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

const app = await electron.launch({
  executablePath: join(repoDir, "node_modules", "electron", "dist", "electron"),
  args: [desktopDir],
  cwd: repoDir,
  env: {
    ...process.env,
    LATENT_ENGINE_URL: `ws://127.0.0.1:${enginePort}`,
    // The `?photo=` hook opens a photo without going through the native file dialog.
    LATENT_EDITOR_URL: `${editorUrl}/?photo=${encodeURIComponent(photoPath)}`,
  },
});

const window = await app.firstWindow();
window.on("console", (message) => console.log(`[renderer] ${message.text()}`));
window.on("pageerror", (error) => console.log(`[renderer] ${error.message}`));
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
await window.waitForFunction(readoutIs, { op: "exposure", text: "1.00 EV" }, { timeout: 10_000 });
console.log("[shot] undo/redo moved the slider");

// An external writer — a script or an MCP client on its own socket — must move the
// sliders and trigger a re-render without the UI asking for anything.
const external = new WebSocket(`ws://127.0.0.1:${enginePort}`);
await new Promise((resolve) => external.addEventListener("open", resolve, { once: true }));
external.send(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "op.add",
    params: { photoId: 1, op: "contrast", params: { value: 60 } },
  }),
);
await window.waitForFunction(readoutIs, { op: "contrast", text: "60" }, { timeout: 10_000 });
external.close();
await window.waitForTimeout(500);
await window.screenshot({ path: externalPath });
console.log(`[shot] external writer moved contrast to 60, wrote ${externalPath}`);

await app.close();
stopChildren();
process.exit(0);

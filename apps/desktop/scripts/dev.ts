// Dev runner: Vite dev server for the editor, then electron-vite dev for main/preload
// with LATENT_EDITOR_URL pointing at Vite. latentd is spawned by main itself.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const editorDir = join(desktopDir, "..", "editor");

// The renderer's origin is `http://localhost:<port>`, and localStorage is per origin: a new
// port every run meant every launch started with nothing remembered — panel layout,
// presets, the Assistant's harness, model and conversations. So one fixed port, and a
// random one only when something else already holds it.
const PREFERRED_PORT = 5199;

function pickPort(): number {
  for (const wanted of [PREFERRED_PORT, 0]) {
    try {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: wanted, socket: { data() {} } });
      const { port } = probe;
      probe.stop(true);
      return port;
    } catch {
      // Taken: fall through to any free port.
    }
  }
  throw new Error("no free port for the editor");
}

let editor: Bun.Subprocess | null = null;
let electron: Bun.Subprocess | null = null;

function shutdown(code: number): never {
  electron?.kill();
  editor?.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (editor?.exitCode != null) throw new Error(`Vite exited with code ${editor.exitCode}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`Vite did not answer on ${url} within ${timeoutMs}ms`);
}

const port = process.env.LATENT_DEV_PORT ? Number(process.env.LATENT_DEV_PORT) : pickPort();
const editorUrl = `http://localhost:${port}`;
console.log(`[dev] editor on ${editorUrl}`);
if (port !== PREFERRED_PORT) {
  console.log(`[dev] ${PREFERRED_PORT} is taken: this run starts with an empty localStorage`);
}
editor = Bun.spawn(["bun", "--bun", "vite", "dev", "--port", String(port), "--strictPort"], {
  cwd: editorDir,
  stdio: ["ignore", "inherit", "inherit"],
});
await waitForServer(editorUrl, 60_000);

electron = Bun.spawn([join(desktopDir, "node_modules", ".bin", "electron-vite"), "dev"], {
  cwd: desktopDir,
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, LATENT_EDITOR_URL: editorUrl },
});
shutdown(await electron.exited);

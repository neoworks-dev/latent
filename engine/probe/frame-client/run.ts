// Starts probe_frame on a raw file, waits for it to listen, launches the bare
// Electron client, prints its report, shuts both down. `bun engine/probe/frame-client/run.ts <raw>`
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const rawPath = process.argv[2];
if (!rawPath) {
  console.error("usage: bun engine/probe/frame-client/run.ts <file.raw>");
  process.exit(2);
}

const engine = Bun.spawn([join(repoRoot, "engine/build/dev/probe/probe_frame"), rawPath], {
  stdout: "pipe",
  stderr: "inherit",
});

const reader = engine.stdout.getReader();
const decoder = new TextDecoder();
let buffered = "";
async function waitForListen(): Promise<void> {
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("probe_frame exited before listening");
    buffered += decoder.decode(value);
    process.stdout.write(decoder.decode(value));
    if (buffered.includes("listening on")) return;
  }
}
await waitForListen();
// Keep draining so the engine never blocks on a full pipe.
void (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    process.stdout.write(decoder.decode(value));
  }
})();

const electron = Bun.spawn(
  [join(repoRoot, "node_modules/.bin/electron"), join(here, "main.cjs")],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" } },
);
const code = await electron.exited;
engine.kill();
process.exit(code);

// End-to-end smoke test: spawn latentd, drive the real protocol over a WebSocket, and
// write the frame it sends back as a PNG. Run with `bun engine/tests/smoke.ts`; ctest
// runs the same command. Exits 77 (ctest's skip code) when the sample raw is missing.
import { existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const engineExecutable = process.env.LATENTD ?? fileURLToPath(new URL("../build/dev/latentd", import.meta.url));
const samplePath = process.env.LATENT_SAMPLE_RAW ?? "/home/moritz/Downloads/DSC00120.ARW";
const outputPath = process.env.LATENT_SMOKE_PNG ?? "/tmp/latent-smoke.png";

if (!existsSync(engineExecutable)) {
  console.error(`smoke: ${engineExecutable} not built`);
  process.exit(1);
}
if (!existsSync(samplePath)) {
  console.log(`smoke: skipping, no sample raw at ${samplePath}`);
  process.exit(77);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

/** Minimal PNG: 8-bit RGBA, one IDAT, no interlacing. */
function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

const engine = Bun.spawn([engineExecutable, "--port", "0"], { stdout: "pipe", stderr: "inherit" });

// Keep draining stdout for the whole run: cancelling the stream would hand latentd a
// broken pipe the next time it logs.
let announce: (endpoint: string) => void = () => {};
let giveUp: (error: Error) => void = () => {};
const endpointReady = new Promise<string>((resolve, reject) => {
  announce = resolve;
  giveUp = reject;
});
void (async () => {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const piece of engine.stdout) {
    const text = decoder.decode(piece as Uint8Array);
    buffered += text;
    process.stdout.write(`[latentd] ${text}`);
    const match = /listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
    if (match) announce(match[1]!);
  }
  giveUp(new Error("smoke: latentd exited before listening"));
})();

const started = performance.now();
const endpoint = await endpointReady;
console.log(`startup ${(performance.now() - started).toFixed(0)} ms -> ${endpoint}`);

const socket = new WebSocket(endpoint);
socket.binaryType = "arraybuffer";
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const notifications: { method: string; params: any }[] = [];
let frame: { width: number; height: number; seq: number; viewId: number; pixels: Uint8Array } | null = null;
let nextId = 1;

socket.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer) {
    const view = new DataView(event.data);
    const magic = String.fromCharCode(...new Uint8Array(event.data, 0, 4));
    assert(magic === "LFRM", `unexpected frame magic ${magic}`);
    assert(view.getUint32(20, true) === 0, "frame format must be 0 (rgba8)");
    frame = {
      width: view.getUint32(4, true),
      height: view.getUint32(8, true),
      seq: view.getUint32(12, true),
      viewId: view.getUint32(16, true),
      pixels: new Uint8Array(event.data, 32),
    };
    return;
  }
  const message = JSON.parse(event.data as string);
  if (message.id === undefined || message.id === null) {
    notifications.push({ method: message.method, params: message.params });
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
  else waiter.resolve(message.result);
});

function call(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const begin = performance.now();
  const result = await work();
  console.log(`${label.padEnd(22)} ${(performance.now() - begin).toFixed(1)} ms`);
  return result;
}

await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", () => reject(new Error("smoke: websocket failed")));
});

const hello = await timed("engine.hello", () => call("engine.hello", { client: "smoke" }));
console.log(`  engine ${hello.engineVersion}, protocol ${hello.protocolVersion}, gpu ${hello.gpu.adapter}`);
assert(hello.protocolVersion === 1, "protocolVersion must be 1");
assert(hello.gpu.maxTextureDimension2D >= 16384, "maxTextureDimension2D too small");

const described = await timed("ops.describe", () => call("ops.describe"));
const names = described.ops.map((op: { name: string }) => op.name);
console.log(`  ${names.length} ops: ${names.join(", ")}`);
for (const expected of ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "white_balance", "saturation", "vibrance"]) {
  assert(names.includes(expected), `ops.describe is missing ${expected}`);
}

const sidecarPath = `${samplePath}.latent`;
if (existsSync(sidecarPath)) await Bun.file(sidecarPath).delete();

const photo = await timed("photo.open", () => call("photo.open", { path: samplePath }));
console.log(`  photo ${photo.photoId}: ${photo.camera} ${photo.width}x${photo.height}`);
let photoId: number = photo.photoId;

const view = await timed("view.open", () => call("view.open", { photoId, width: 1280, height: 720 }));
let viewId: number = view.viewId;

await timed("view.render (neutral)", () => call("view.render", { viewId }));
const neutral = frame;
assert(neutral, "no frame for the neutral render");

const added = await timed("op.add exposure +1", () =>
  call("op.add", { photoId, op: "exposure", params: { value: 1.0 } }),
);
const opId: string = added.stack[0].id;
assert(added.stack.length === 1, "stack should hold one op");
assert(added.stack[0].op === "exposure" && added.stack[0].params.value === 1, "op.add stored the wrong op");
assert(added.canUndo === true, "canUndo should be true after op.add");

const render = await timed("view.render (+1 EV)", () => call("view.render", { viewId }));
console.log(`  render ${render.renderMs.toFixed(2)} ms, readback ${render.readbackMs.toFixed(2)} ms, seq ${render.seq}`);
assert(frame && frame.seq === render.seq, "frame seq does not match the result");
assert(frame.viewId === viewId, "frame viewId does not match");
assert(frame.width === 1280 && frame.height === 720, "frame is the wrong size");

// +1 EV must be visibly brighter than the neutral render of the same pixels.
const mean = (pixels: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!;
  return sum / (pixels.length / 4) / 3;
};
const brightNeutral = mean(neutral.pixels);
const brightExposed = mean(frame.pixels);
console.log(`  mean level ${brightNeutral.toFixed(1)} -> ${brightExposed.toFixed(1)}`);
assert(brightExposed > brightNeutral + 5, "exposure +1 did not brighten the frame");

await Bun.write(outputPath, encodePng(frame.pixels, frame.width, frame.height));
console.log(`  wrote ${outputPath}`);

assert(existsSync(sidecarPath), `no sidecar at ${sidecarPath}`);
console.log(`--- ${sidecarPath}\n${await Bun.file(sidecarPath).text()}---`);

// Resizing happens through view.render, and the frame that comes back proves it.
const resized = await timed("view.render (resize)", () =>
  call("view.render", { viewId, width: 640, height: 480 }),
);
assert(frame && frame.width === 640 && frame.height === 480, "view.render did not resize the target");
assert(resized.seq > render.seq, "seq must increase per frame");
await timed("view.render (restore)", () => call("view.render", { viewId, width: 1280, height: 720 }));

const transient = await timed("op.update transient", () =>
  call("op.update", { photoId, opId, params: { value: 2.0 }, transient: true }),
);
assert(transient.stack[0].params.value === 2, "transient update did not apply");

const clamped = await timed("op.update clamp", () =>
  call("op.update", { photoId, opId, params: { value: 99 } }),
);
assert(clamped.stack[0].params.value === 5, "out-of-range exposure should clamp to 5");
assert(
  notifications.some((n) => n.method === "engine.log" && String(n.params.message).includes("clamped")),
  "expected an engine.log warning about the clamp",
);

const undone = await timed("history.undo", () => call("history.undo", { photoId }));
assert(undone.stack.length === 1 && undone.stack[0].params.value === 1, "undo should drop the clamped value");
const empty = await timed("history.undo", () => call("history.undo", { photoId }));
assert(empty.stack.length === 0, "the stack should be empty again");

const state = await timed("stack.get", () => call("stack.get", { photoId }));
assert(state.stack.length === 0, "stack.get disagrees with history.undo");
assert(state.canRedo === true, "canRedo should be true after two undos");
assert(state.histogram && state.histogram.bins === 256, "stack.get should carry a histogram");
const histogramTotal = state.histogram.r.reduce((sum: number, count: number) => sum + count, 0);
console.log(
  `  histogram ${histogramTotal} px, clipped ${state.histogram.clippedShadowsPct.toFixed(2)}% / ${state.histogram.clippedHighlightsPct.toFixed(2)}%`,
);
assert(histogramTotal > 0, "empty histogram");
assert(
  notifications.some((n) => n.method === "stack.changed" && n.params.source === "history"),
  "expected a stack.changed notification from history",
);
assert(
  notifications.some((n) => n.method === "stack.changed" && n.params.source === "load"),
  "expected a stack.changed notification from photo.open",
);

const python = await call("python.run", { code: "1 + 1" }).then(
  () => "resolved",
  (error: Error) => error.message,
);
assert(python.startsWith("-32601"), `python.run should be method-not-found, got ${python}`);

const badOp = await call("op.add", { photoId, op: "clarity", params: {} }).then(
  () => "resolved",
  (error: Error) => error.message,
);
assert(badOp.startsWith("-32602"), `unknown op should be invalid params, got ${badOp}`);

const badId = await call("stack.get", { photoId: 999 }).then(
  () => "resolved",
  (error: Error) => error.message,
);
assert(badId.startsWith("-32602"), `unknown photoId should be invalid params, got ${badId}`);

// stack.set is the script/agent write path; it takes ids the caller invented.
const replaced = await timed("stack.set", () =>
  call("stack.set", {
    photoId,
    stack: [
      { id: "cafe0001", op: "white_balance", params: { temperature: 20, tint: -5 }, enabled: true },
      { id: "cafe0002", op: "vibrance", params: { value: 30 }, enabled: true },
    ],
  }),
);
assert(replaced.stack.length === 2, "stack.set did not replace the stack");
assert(replaced.stack[0].op === "white_balance" && replaced.stack[1].op === "vibrance", "stack.set reordered");
await timed("view.render (wb+vib)", () => call("view.render", { viewId }));

const shortened = await timed("op.remove", () => call("op.remove", { photoId, opId: "cafe0001" }));
assert(shortened.stack.length === 1 && shortened.stack[0].id === "cafe0002", "op.remove removed the wrong op");

// Close and reopen: the stack must come back from the sidecar, not from memory.
await timed("view.close", () => call("view.close", { viewId }));
await timed("photo.close", () => call("photo.close", { photoId }));
const reopened = await timed("photo.open (sidecar)", () => call("photo.open", { path: samplePath }));
photoId = reopened.photoId;
const restored = await timed("stack.get (sidecar)", () => call("stack.get", { photoId }));
assert(restored.stack.length === 1, "the sidecar stack did not come back");
assert(restored.stack[0].id === "cafe0002", "the sidecar lost the op id");
assert(restored.stack[0].params.value === 30, "the sidecar lost the vibrance value");
assert(restored.canUndo === false, "a freshly loaded stack has nothing to undo");
assert(restored.histogram === undefined, "no view has rendered this photo yet");

await timed("photo.close", () => call("photo.close", { photoId }));
socket.close();

engine.kill("SIGTERM");
const exitCode = await engine.exited;
console.log(`latentd exited with ${exitCode} after SIGTERM`);
assert(exitCode === 0, `latentd should exit 0, got ${exitCode}`);
console.log(`smoke: ok in ${(performance.now() - started).toFixed(0)} ms`);

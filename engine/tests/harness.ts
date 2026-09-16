// Shared plumbing for the scripts that drive a real `latentd` over the real protocol:
// spawning the daemon, a JSON-RPC + binary-frame client, and a minimal PNG encoder.
// Used by smoke.ts (the end-to-end test) and ops-demo.ts (the render cost table).
import { existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const engineExecutable =
  process.env.LATENTD ?? fileURLToPath(new URL("../build/dev/latentd", import.meta.url));
export const samplePath = process.env.LATENT_SAMPLE_RAW ?? "/home/moritz/Downloads/DSC00120.ARW";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
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
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
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

export interface Engine {
  process: Bun.Subprocess;
  endpoint: Promise<string>;
  mcpUrl: Promise<string>;
}

/**
 * Spawns latentd on a free port with a scratch catalog and config, and resolves the
 * endpoints out of its stdout. stdout is drained for the whole run: cancelling the stream
 * would hand latentd a broken pipe the next time it logs.
 */
export function startEngine(scratch: string, extraArgs: string[] = []): Engine {
  if (!existsSync(engineExecutable)) throw new Error(`${engineExecutable} not built`);
  const process_ = Bun.spawn(
    [engineExecutable, "--port", "0", "--catalog", `${scratch}/catalog.db`, ...extraArgs],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: `${scratch}/config`,
        XDG_CACHE_HOME: `${scratch}/cache`,
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  process.on("exit", () => process_.kill("SIGKILL"));

  let announce: (endpoint: string) => void = () => {};
  let announceMcp: (url: string) => void = () => {};
  let giveUp: (error: Error) => void = () => {};
  const endpoint = new Promise<string>((resolve, reject) => {
    announce = resolve;
    giveUp = reject;
  });
  const mcpUrl = new Promise<string>((resolve) => {
    announceMcp = resolve;
  });
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const piece of process_.stdout as ReadableStream<Uint8Array>) {
      const text = decoder.decode(piece);
      buffered += text;
      console.write(`[latentd] ${text}`);
      const match = /listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
      if (match) announce(match[1]!);
      const mcp = /mcp on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(buffered);
      if (mcp) announceMcp(mcp[1]!);
    }
    giveUp(new Error("latentd exited before listening"));
  })();
  return { process: process_, endpoint, mcpUrl };
}

export type Frame = {
  width: number;
  height: number;
  seq: number;
  target: number;
  pixels: Uint8Array;
};
export type Notification = { method: string; params: any };

export interface Client {
  call(method: string, params?: unknown): Promise<any>;
  fail(method: string, params?: unknown): Promise<string>;
  close(): void;
  readonly notifications: Notification[];
  readonly thumbnails: Frame[];
  frame: Frame | null;
}

export async function connect(endpoint: string): Promise<Client> {
  const socket = new WebSocket(endpoint);
  socket.binaryType = "arraybuffer";
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const notifications: Notification[] = [];
  const thumbnails: Frame[] = [];
  let nextId = 1;
  const client: Client = {
    notifications,
    thumbnails,
    frame: null,
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    fail(method, params = {}) {
      return client.call(method, params).then(
        () => "resolved",
        (error: Error) => error.message,
      );
    },
    close() {
      socket.close();
    },
  };

  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      const view = new DataView(event.data);
      const magic = String.fromCharCode(...new Uint8Array(event.data, 0, 4));
      const frame: Frame = {
        width: view.getUint32(4, true),
        height: view.getUint32(8, true),
        seq: view.getUint32(12, true),
        target: view.getUint32(16, true),
        pixels: new Uint8Array(event.data, 32),
      };
      if (magic === "LTHM") {
        assert(view.getUint32(20, true) === 1, "thumbnail frames must be format 1 (jpeg)");
        thumbnails.push(frame);
        return;
      }
      assert(magic === "LFRM", `unexpected frame magic ${magic}`);
      assert(view.getUint32(20, true) === 0, "frame format must be 0 (rgba8)");
      client.frame = frame;
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

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed")));
  });
  return client;
}

/** Mean rgb level of a frame, 0-255: the cheapest "did the picture change" measure. */
export function mean(pixels: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += pixels[i]! + pixels[i + 1]! + pixels[i + 2]!;
  return sum / (pixels.length / 4) / 3;
}

/** Mean level of one channel, 0-255: 0 is red, 1 green, 2 blue. */
export function channelMean(pixels: Uint8Array, channel: number): number {
  let sum = 0;
  for (let i = channel; i < pixels.length; i += 4) sum += pixels[i]!;
  return sum / (pixels.length / 4);
}

/**
 * Mean absolute difference between horizontally adjacent pixels: how much fine detail the
 * frame carries. Sharpening and grain raise it, noise reduction and blur lower it.
 */
export function detailEnergy(pixels: Uint8Array): number {
  let sum = 0;
  for (let i = 4; i < pixels.length; i += 4) {
    sum += Math.abs(pixels[i]! - pixels[i - 4]!);
  }
  return sum / (pixels.length / 4);
}

/** Share of bytes that differ between two frames of the same size. */
export function difference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) differing++;
  }
  return differing / a.length;
}

/** Share of pixels that are the letterbox grey display.wgsl paints outside the image. */
export function letterboxShare(pixels: Uint8Array): number {
  let bars = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 20 && pixels[i + 1] === 20 && pixels[i + 2] === 23) bars++;
  }
  return bars / (pixels.length / 4);
}

export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const begin = performance.now();
  const result = await work();
  console.log(`${label.padEnd(24)} ${(performance.now() - begin).toFixed(1)} ms`);
  return result;
}

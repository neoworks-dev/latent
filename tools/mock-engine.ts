// A stand-in for `latentd` so the UI can be developed and screenshotted without a GPU,
// LibRaw or a built engine. It speaks the real protocol: JSON-RPC 2.0 on text frames,
// LFRM binary frames for pixels, `stack.changed` notifications to every connected
// client. The image is synthetic and the op maths is crude on purpose — this proves the
// round trip, not the renderer.
//
//   bun run mock-engine [--port 0]
import type {
  EngineHelloResult,
  Op,
  OpDefinition,
  OpsDescribeResult,
  PhotoOpenResult,
  StackChangedParams,
  StackGetResult,
} from "@latent/protocol";
import { FRAME_HEADER_BYTES } from "@latent/protocol";
import type { ServerWebSocket } from "bun";

export const opDefinitions: OpDefinition[] = [
  {
    name: "exposure",
    panel: "light",
    label: "Exposure",
    params: [
      { name: "value", type: "number", min: -5, max: 5, step: 0.01, unit: "EV", default: 0 },
    ],
  },
  ...["contrast", "highlights", "shadows", "whites", "blacks"].map<OpDefinition>((name) => ({
    name,
    panel: "light",
    label: name.slice(0, 1).toUpperCase() + name.slice(1),
    params: [{ name: "value", type: "number", min: -100, max: 100, step: 1, default: 0 }],
  })),
  {
    name: "white_balance",
    panel: "color",
    label: "White balance",
    params: [
      {
        name: "temperature",
        label: "Temp",
        type: "number",
        min: -100,
        max: 100,
        step: 1,
        default: 0,
      },
      { name: "tint", label: "Tint", type: "number", min: -100, max: 100, step: 1, default: 0 },
    ],
  },
  ...["saturation", "vibrance"].map<OpDefinition>((name) => ({
    name,
    panel: "color",
    label: name.slice(0, 1).toUpperCase() + name.slice(1),
    params: [{ name: "value", type: "number", min: -100, max: 100, step: 1, default: 0 }],
  })),
];

/**
 * The op-stack with the engine's history semantics: snapshots plus a cursor, never a
 * pop. A transient mutation (slider being dragged) changes the live stack without
 * snapshotting; the next committed mutation appends one, so undo lands before the drag.
 */
export class PhotoState {
  stack: Op[] = [];
  revision = 0;
  private history: Op[][] = [[]];
  private cursor = 0;
  private nextOpId = 1;

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.history.length - 1;
  }

  snapshot(): StackGetResult {
    return {
      stack: this.stack,
      revision: this.revision,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
    };
  }

  addOp(op: string, params: Record<string, unknown>, index?: number): Op {
    const entry: Op = { id: `op${this.nextOpId++}`, op, params: { ...params }, enabled: true };
    const next = [...this.stack];
    next.splice(index ?? next.length, 0, entry);
    this.commit(next, false);
    return entry;
  }

  updateOp(
    opId: string,
    params: Record<string, unknown>,
    enabled: boolean | undefined,
    transient: boolean,
  ): void {
    const next = this.stack.map((entry) => {
      if (entry.id !== opId) return entry;
      return {
        ...entry,
        params: { ...entry.params, ...params },
        enabled: enabled ?? entry.enabled,
      };
    });
    this.commit(next, transient);
  }

  removeOp(opId: string): void {
    this.commit(
      this.stack.filter((entry) => entry.id !== opId),
      false,
    );
  }

  setStack(stack: Op[]): void {
    this.commit(stack, false);
  }

  undo(): void {
    if (!this.canUndo) return;
    this.moveCursor(this.cursor - 1);
  }

  redo(): void {
    if (!this.canRedo) return;
    this.moveCursor(this.cursor + 1);
  }

  private moveCursor(cursor: number): void {
    const snapshot = this.history[cursor];
    if (!snapshot) return;
    this.cursor = cursor;
    this.stack = snapshot;
    this.revision += 1;
  }

  private commit(stack: Op[], transient: boolean): void {
    this.stack = stack;
    this.revision += 1;
    if (transient) return;
    this.history = [...this.history.slice(0, this.cursor + 1), stack];
    this.cursor = this.history.length - 1;
  }
}

function paramOf(stack: Op[], op: string, name: string, fallback: number): number {
  const entry = stack.find((candidate) => candidate.op === op && candidate.enabled);
  if (!entry) return fallback;
  const value = entry.params[name];
  if (typeof value !== "number") return fallback;
  return value;
}

/**
 * A smooth colour gradient with a grid, with the ops applied crudely so a slider move is
 * visible. Returns an LFRM frame: 32-byte header (frames.md) followed by rgba8 pixels.
 */
export function renderFrame(
  width: number,
  height: number,
  seq: number,
  viewId: number,
  stack: Op[],
): ArrayBuffer {
  const exposure = paramOf(stack, "exposure", "value", 0);
  const contrast = paramOf(stack, "contrast", "value", 0);
  const temperature = paramOf(stack, "white_balance", "temperature", 0);
  const saturation = paramOf(stack, "saturation", "value", 0);
  const gain = Math.pow(2, exposure);
  const slope = 1 + contrast / 100;
  const warm = 1 + temperature / 300;
  const cool = 1 - temperature / 300;
  const vivid = 1 + saturation / 100;

  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + width * height * 4);
  const header = new DataView(buffer);
  header.setUint8(0, 0x4c); // L
  header.setUint8(1, 0x46); // F
  header.setUint8(2, 0x52); // R
  header.setUint8(3, 0x4d); // M
  header.setUint32(4, width, true);
  header.setUint32(8, height, true);
  header.setUint32(12, seq, true);
  header.setUint32(16, viewId, true);
  header.setUint32(20, 0, true);

  const pixels = new Uint8ClampedArray(buffer, FRAME_HEADER_BYTES);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const grid = x % 64 < 2 || y % 64 < 2 ? 0.18 : 0;
      let r = (0.14 + 0.3 * u + grid) * warm;
      let g = 0.16 + 0.24 * (1 - v) + grid;
      let b = (0.3 - 0.18 * u + 0.16 * v + grid) * cool;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * vivid;
      g = luma + (g - luma) * vivid;
      b = luma + (b - luma) * vivid;
      const offset = (y * width + x) * 4;
      pixels[offset] = 255 * (0.5 + (r * gain - 0.5) * slope);
      pixels[offset + 1] = 255 * (0.5 + (g * gain - 0.5) * slope);
      pixels[offset + 2] = 255 * (0.5 + (b * gain - 0.5) * slope);
      pixels[offset + 3] = 255;
    }
  }
  return buffer;
}

interface View {
  photoId: number;
  width: number;
  height: number;
  seq: number;
}

interface RpcRequest {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

class MockEngine {
  private readonly photos = new Map<number, PhotoState>();
  private readonly views = new Map<number, View>();
  private nextPhotoId = 1;
  private nextViewId = 1;

  photo(photoId: number): PhotoState {
    const photo = this.photos.get(photoId);
    if (!photo) throw new Error(`unknown photoId ${photoId}`);
    return photo;
  }

  /** Returns the result, plus the photo whose stack changed so the caller can publish. */
  handle(method: string, params: Record<string, unknown>): { result: unknown; changed?: number } {
    if (method === "engine.hello") {
      const hello: EngineHelloResult = {
        engineVersion: "mock-0.0.0",
        protocolVersion: 1,
        gpu: { adapter: "mock software", maxTextureDimension2D: 16384, shaderF16: false },
      };
      return { result: hello };
    }
    if (method === "ops.describe") {
      const described: OpsDescribeResult = { ops: opDefinitions };
      return { result: described };
    }
    if (method === "photo.open") {
      const photoId = this.nextPhotoId++;
      this.photos.set(photoId, new PhotoState());
      const opened: PhotoOpenResult = {
        photoId,
        width: 4024,
        height: 6024,
        camera: "Mock X-T5",
        hash: "0".repeat(64),
        sidecarLoaded: false,
      };
      return { result: opened, changed: photoId };
    }
    if (method === "photo.close") {
      this.photos.delete(Number(params.photoId));
      return { result: {} };
    }
    if (method === "view.open") {
      const viewId = this.nextViewId++;
      this.views.set(viewId, {
        photoId: Number(params.photoId),
        width: Number(params.width),
        height: Number(params.height),
        seq: 0,
      });
      return { result: { viewId } };
    }
    if (method === "view.close") {
      this.views.delete(Number(params.viewId));
      return { result: {} };
    }
    if (method === "python.run") {
      throw new Error("python is not available in the mock engine");
    }
    return { result: this.handleStack(method, params), changed: Number(params.photoId) };
  }

  render(viewId: number): {
    frame: ArrayBuffer;
    renderMs: number;
    seq: number;
    width: number;
    height: number;
  } {
    const view = this.views.get(viewId);
    if (!view) throw new Error(`unknown viewId ${viewId}`);
    view.seq += 1;
    const started = performance.now();
    const frame = renderFrame(
      view.width,
      view.height,
      view.seq,
      viewId,
      this.photo(view.photoId).stack,
    );
    return {
      frame,
      renderMs: performance.now() - started,
      seq: view.seq,
      width: view.width,
      height: view.height,
    };
  }

  resize(viewId: number, width?: number, height?: number): void {
    const view = this.views.get(viewId);
    if (!view || !width || !height) return;
    view.width = width;
    view.height = height;
  }

  private handleStack(method: string, params: Record<string, unknown>): StackGetResult {
    const photo = this.photo(Number(params.photoId));
    const opParams = (params.params ?? {}) as Record<string, unknown>;
    if (method === "stack.get") return photo.snapshot();
    if (method === "stack.set") {
      photo.setStack(params.stack as Op[]);
      return photo.snapshot();
    }
    if (method === "op.add") {
      photo.addOp(String(params.op), opParams, params.index as number | undefined);
      return photo.snapshot();
    }
    if (method === "op.update") {
      const enabled = typeof params.enabled === "boolean" ? params.enabled : undefined;
      photo.updateOp(String(params.opId), opParams, enabled, params.transient === true);
      return photo.snapshot();
    }
    if (method === "op.remove") {
      photo.removeOp(String(params.opId));
      return photo.snapshot();
    }
    if (method === "history.undo") {
      photo.undo();
      return photo.snapshot();
    }
    if (method === "history.redo") {
      photo.redo();
      return photo.snapshot();
    }
    throw new Error(`unknown method ${method}`);
  }
}

export function startMockEngine(port: number): { port: number; stop: () => void } {
  const engine = new MockEngine();
  const clients = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response("latent mock engine: websocket only", { status: 426 });
    },
    websocket: {
      open(socket) {
        clients.add(socket);
      },
      close(socket) {
        clients.delete(socket);
      },
      message(socket, raw) {
        const request: RpcRequest = JSON.parse(String(raw));
        const params = request.params ?? {};
        try {
          if (request.method === "view.render") {
            const viewId = Number(params.viewId);
            engine.resize(
              viewId,
              params.width as number | undefined,
              params.height as number | undefined,
            );
            const rendered = engine.render(viewId);
            socket.send(new Uint8Array(rendered.frame));
            reply(socket, request.id, {
              seq: rendered.seq,
              width: rendered.width,
              height: rendered.height,
              renderMs: rendered.renderMs,
              readbackMs: 0,
            });
            return;
          }
          const { result, changed } = engine.handle(request.method, params);
          reply(socket, request.id, result);
          if (changed === undefined) return;
          publish(clients, socket, changed, engine.photo(changed).snapshot());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }),
          );
        }
      },
    },
  });

  const listeningPort = server.port;
  if (listeningPort === undefined) throw new Error("mock engine did not bind a TCP port");
  return { port: listeningPort, stop: () => void server.stop(true) };
}

function reply(
  socket: ServerWebSocket<unknown>,
  id: number | string | undefined,
  result: unknown,
): void {
  if (id === undefined) return;
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

/**
 * Tells the writer its own change (`ui`, which its optimistic mirror already has) apart
 * from everyone else's (`mcp`, which has to trigger a re-render on the other clients).
 */
function publish(
  clients: Set<ServerWebSocket<unknown>>,
  writer: ServerWebSocket<unknown>,
  photoId: number,
  snapshot: StackGetResult,
): void {
  for (const client of clients) {
    const params: StackChangedParams = {
      ...snapshot,
      photoId,
      source: client === writer ? "ui" : "mcp",
    };
    client.send(JSON.stringify({ jsonrpc: "2.0", method: "stack.changed", params }));
  }
}

if (import.meta.main) {
  const flagIndex = Bun.argv.indexOf("--port");
  const port = flagIndex < 0 ? 0 : Number(Bun.argv[flagIndex + 1]);
  const engine = startMockEngine(port);
  console.log(`listening on ws://127.0.0.1:${engine.port}`);
}

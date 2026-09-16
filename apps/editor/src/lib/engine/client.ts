// WebSocket client for latentd: JSON-RPC 2.0 on text frames, LFRM pixels on binary
// frames. Reconnects on its own; pending calls reject when the socket drops.
import type { EngineClient, EngineConnectionState, FrameListener } from "@latent/contracts";
import {
  FRAME_HEADER_BYTES,
  type MethodMap,
  type MethodName,
  type NotificationMap,
  parseFrameHeader,
} from "@latent/protocol";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class WebSocketEngineClient implements EngineClient {
  state: EngineConnectionState = "connecting";
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly frameListeners = new Map<number, Set<FrameListener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly openWaiters = new Set<() => void>();

  constructor(private readonly url: string) {
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.openWaiters.clear();
    this.failPending(new Error("engine client disposed"));
  }

  whenOpen(): Promise<void> {
    if (this.state === "open") return Promise.resolve();
    return new Promise((resolve) => this.openWaiters.add(resolve));
  }

  call<M extends MethodName>(method: M, params: MethodMap[M]["params"]): Promise<MethodMap[M]["result"]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`engine not connected (${method})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on<N extends keyof NotificationMap>(event: N, listener: (params: NotificationMap[N]) => void): () => void {
    const listeners = this.notificationListeners.get(event) ?? new Set();
    listeners.add(listener as (params: unknown) => void);
    this.notificationListeners.set(event, listeners);
    return () => {
      listeners.delete(listener as (params: unknown) => void);
    };
  }

  onFrame(viewId: number, listener: FrameListener): () => void {
    const listeners = this.frameListeners.get(viewId) ?? new Set();
    listeners.add(listener);
    this.frameListeners.set(viewId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.state = "connecting";
    socket.addEventListener("open", () => {
      this.state = "open";
      const waiters = [...this.openWaiters];
      this.openWaiters.clear();
      for (const resolve of waiters) resolve();
    });
    socket.addEventListener("message", (event) => this.receive(event.data as string | ArrayBuffer));
    socket.addEventListener("close", () => {
      this.state = "closed";
      this.failPending(new Error("engine connection closed"));
      if (this.disposed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    });
  }

  private receive(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      this.receiveFrame(data);
      return;
    }
    const message: RpcMessage = JSON.parse(data);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      const listeners = this.notificationListeners.get(message.method);
      if (!listeners) return;
      for (const listener of listeners) listener(message.params);
    }
  }

  private receiveFrame(buffer: ArrayBuffer): void {
    const header = parseFrameHeader(buffer);
    const listeners = this.frameListeners.get(header.target);
    if (!listeners) return;
    const pixels = new Uint8ClampedArray(buffer, FRAME_HEADER_BYTES, header.width * header.height * 4);
    for (const listener of listeners) listener(header, pixels);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

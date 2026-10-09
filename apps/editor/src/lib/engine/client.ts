// WebSocket client for latentd: JSON-RPC 2.0 on text frames, LFRM pixels on binary
// frames, or in shared memory when the desktop bridge can read it. Reconnects on its own;
// pending calls reject when the socket drops.
import type {
  DepthListener,
  LatentDesktopBridge,
  EngineClient,
  EngineConnectionState,
  FrameListener,
  MaskListener,
  ThumbnailListener,
} from "@latent/contracts";
import {
  FRAME_FORMAT_SHARED,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC_DEPTH,
  FRAME_MAGIC_MASK,
  FRAME_MAGIC_THUMBNAIL,
  type FrameHeader,
  frameBody,
  type MethodMap,
  type MethodName,
  type NotificationMap,
  parseFrameHeader,
  type ViewOpenResult,
} from "@latent/protocol";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** A `view.open` that asked for shared memory: its result names the view's slots. */
  opensSharedView: boolean;
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
  private readonly thumbnailListeners = new Map<number, Set<ThumbnailListener>>();
  private readonly maskListeners = new Set<MaskListener>();
  private readonly depthListeners = new Set<DepthListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly openWaiters = new Set<() => void>();
  /** Each shared-memory view's two slot paths, indexed by `seq % 2`. */
  private readonly sharedSlots = new Map<number, [string, string]>();

  constructor(
    private readonly url: string,
    private readonly readSharedFrame?: LatentDesktopBridge["readSharedFrame"],
  ) {
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
    // Every view this client opens takes its pixels through shared memory when it can read
    // them: the frame path is the transport's business, not the viewer's.
    const opensSharedView = method === "view.open" && this.readSharedFrame !== undefined;
    const sent = opensSharedView ? { ...params, sharedMemory: true } : params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, opensSharedView });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: sent }));
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

  onThumbnail(photoId: number, listener: ThumbnailListener): () => void {
    const listeners = this.thumbnailListeners.get(photoId) ?? new Set();
    listeners.add(listener);
    this.thumbnailListeners.set(photoId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.thumbnailListeners.delete(photoId);
    };
  }

  onMask(listener: MaskListener): () => void {
    this.maskListeners.add(listener);
    return () => {
      this.maskListeners.delete(listener);
    };
  }

  onDepth(listener: DepthListener): () => void {
    this.depthListeners.add(listener);
    return () => {
      this.depthListeners.delete(listener);
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
    // The arrival mark has to be taken here: everything downstream is already later.
    socket.addEventListener("message", (event) =>
      this.receive(event.data as string | ArrayBuffer, performance.now()),
    );
    socket.addEventListener("close", () => {
      this.state = "closed";
      // The views died with the connection, and their slot files with them.
      this.sharedSlots.clear();
      this.failPending(new Error("engine connection closed"));
      if (this.disposed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    });
  }

  private receive(data: string | ArrayBuffer, receivedAt: number): void {
    if (data instanceof ArrayBuffer) {
      this.receiveFrame(data, receivedAt);
      return;
    }
    const message: RpcMessage = JSON.parse(data);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        return;
      }
      if (pending.opensSharedView) {
        const opened = message.result as ViewOpenResult;
        if (opened.sharedMemory) this.sharedSlots.set(opened.viewId, opened.sharedMemory);
      }
      pending.resolve(message.result);
      return;
    }
    if (message.method) {
      const listeners = this.notificationListeners.get(message.method);
      if (!listeners) return;
      for (const listener of listeners) listener(message.params);
    }
  }

  private receiveFrame(buffer: ArrayBuffer, receivedAt: number): void {
    const header = parseFrameHeader(buffer);
    if (header.magic === FRAME_MAGIC_THUMBNAIL) {
      const listeners = this.thumbnailListeners.get(header.target);
      if (!listeners) return;
      // The payload stays binary all the way to the <img>: a Blob, never a data URL.
      const jpeg = new Blob([frameBody(buffer)], { type: "image/jpeg" });
      for (const listener of listeners) listener(header, jpeg);
      return;
    }
    if (header.magic === FRAME_MAGIC_MASK || header.magic === FRAME_MAGIC_DEPTH) {
      // r8: one byte per pixel, a view into the socket's buffer like LFRM's.
      const plane = new Uint8Array(buffer, FRAME_HEADER_BYTES, header.width * header.height);
      const listeners =
        header.magic === FRAME_MAGIC_MASK ? this.maskListeners : this.depthListeners;
      for (const listener of listeners) listener(header, plane);
      return;
    }
    const listeners = this.frameListeners.get(header.target);
    if (!listeners) return;
    const pixels =
      header.format === FRAME_FORMAT_SHARED
        ? this.sharedPixels(header)
        : // A view, not a copy: the painter uploads straight out of the socket's buffer.
          new Uint8Array(buffer, FRAME_HEADER_BYTES, header.width * header.height * 4);
    // After the slot read, so the frame trace's parse stage carries what shared memory costs.
    const parsedAt = performance.now();
    for (const listener of listeners) listener({ header, pixels, receivedAt, parsedAt });
  }

  private sharedPixels(header: FrameHeader): Uint8Array {
    const slots = this.sharedSlots.get(header.target);
    if (!slots || !this.readSharedFrame) {
      throw new Error(`view ${header.target} sent a shared-memory frame this client did not open`);
    }
    // The engine rewrites this slot only two renders on, and the next render is asked for
    // after this frame is handled (protocol/frames.md), so the read is never torn.
    return this.readSharedFrame(slots[header.seq % 2], header.width * header.height * 4);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

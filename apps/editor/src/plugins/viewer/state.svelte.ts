import type { EngineClient, ViewerService } from "@latent/contracts";
import type { FrameHeader, Op, StackGetResult } from "@latent/protocol";

interface QueuedUpdate {
  opId: string;
  params: Record<string, unknown>;
  transient: boolean;
}

interface PendingAdd {
  op: string;
  request: Promise<void>;
}

/**
 * Client-side mirror of what the engine reports for the open photo. Not edit state: every
 * mutation goes to the engine and the mirror updates from its reply or `stack.changed`.
 * The only local state is in-flight bookkeeping — one render and one `op.update` at a
 * time, with the newest value replacing whatever is queued behind them.
 */
export class ViewerState implements ViewerService {
  photoId = $state<number | null>(null);
  viewId = $state<number | null>(null);
  stack = $state<Op[]>([]);
  revision = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  status = $state("no photo");
  lastFrame = $state<{ header: FrameHeader; pixels: Uint8ClampedArray } | null>(null);
  latencyMs = $state(0);

  private renderWidth = 1;
  private renderHeight = 1;
  private renderInFlight = false;
  private renderQueued = false;
  private updateInFlight = false;
  private readonly queuedUpdates: QueuedUpdate[] = [];
  private readonly addsInFlight: PendingAdd[] = [];
  private unsubscribeFrame: (() => void) | null = null;
  private readonly unsubscribeStack: () => void;

  constructor(private readonly engine: EngineClient) {
    this.unsubscribeStack = engine.on("stack.changed", (params) => {
      if (params.photoId !== this.photoId) return;
      // Our own writes already applied their reply; anything newer came from another
      // writer (script, MCP, a second socket) and needs a repaint, whatever `source` says.
      if (params.revision <= this.revision) return;
      this.applyStack(params);
      this.requestRender();
    });
  }

  dispose(): void {
    this.unsubscribeFrame?.();
    this.unsubscribeStack();
  }

  async open(path: string, width: number, height: number): Promise<void> {
    this.status = `opening ${path}`;
    this.renderWidth = width;
    this.renderHeight = height;
    await this.engine.whenOpen();
    const photo = await this.engine.call("photo.open", { path });
    this.photoId = photo.photoId;
    const view = await this.engine.call("view.open", { photoId: photo.photoId, width, height });
    this.viewId = view.viewId;
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = this.engine.onFrame(view.viewId, (header, pixels) => {
      this.lastFrame = { header, pixels };
    });
    this.applyStack(await this.engine.call("stack.get", { photoId: photo.photoId }));
    this.status = `${photo.camera} ${photo.width}×${photo.height}`;
    this.requestRender();
  }

  resize(width: number, height: number): void {
    if (width === this.renderWidth && height === this.renderHeight) return;
    this.renderWidth = width;
    this.renderHeight = height;
    this.requestRender();
  }

  requestRender(): void {
    if (this.viewId === null) return;
    if (this.renderInFlight) {
      this.renderQueued = true;
      return;
    }
    this.renderInFlight = true;
    const started = performance.now();
    void this.engine
      .call("view.render", {
        viewId: this.viewId,
        width: this.renderWidth,
        height: this.renderHeight,
      })
      .then(() => {
        this.latencyMs = performance.now() - started;
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        this.renderInFlight = false;
        if (this.renderQueued) {
          this.renderQueued = false;
          this.requestRender();
        }
      });
  }

  async setParam(op: string, params: Record<string, unknown>, transient: boolean): Promise<void> {
    if (this.photoId === null) return;
    // A drag can outrun the first reply; wait for the add so the second move updates
    // the new op instead of adding a duplicate.
    const pendingAdd = this.addsInFlight.find((entry) => entry.op === op);
    if (pendingAdd) await pendingAdd.request;
    const existing = this.stack.find((entry) => entry.op === op);
    if (existing) return this.updateOp(existing.id, params, transient);
    return this.addOp(op, params);
  }

  async undo(): Promise<void> {
    if (this.photoId === null || !this.canUndo) return;
    this.applyStack(await this.engine.call("history.undo", { photoId: this.photoId }));
    this.requestRender();
  }

  async redo(): Promise<void> {
    if (this.photoId === null || !this.canRedo) return;
    this.applyStack(await this.engine.call("history.redo", { photoId: this.photoId }));
    this.requestRender();
  }

  private addOp(op: string, params: Record<string, unknown>): Promise<void> {
    const photoId = this.photoId;
    if (photoId === null) return Promise.resolve();
    const request = this.engine
      .call("op.add", { photoId, op, params })
      .then((state) => {
        this.applyStack(state);
        this.requestRender();
      })
      .catch((error: Error) => {
        this.status = error.message;
      })
      .finally(() => {
        const index = this.addsInFlight.findIndex((entry) => entry.op === op);
        if (index >= 0) this.addsInFlight.splice(index, 1);
      });
    this.addsInFlight.push({ op, request });
    return request;
  }

  private updateOp(
    opId: string,
    params: Record<string, unknown>,
    transient: boolean,
  ): Promise<void> {
    const queued = this.queuedUpdates.find((entry) => entry.opId === opId);
    if (queued) {
      Object.assign(queued.params, params);
      queued.transient = transient;
    } else {
      this.queuedUpdates.push({ opId, params: { ...params }, transient });
    }
    return this.flushUpdates();
  }

  /** Drains the queue; entries enqueued during an await are picked up by the same loop. */
  private async flushUpdates(): Promise<void> {
    if (this.updateInFlight) return;
    this.updateInFlight = true;
    try {
      while (this.queuedUpdates.length > 0) {
        const update = this.queuedUpdates.shift();
        const photoId = this.photoId;
        if (!update || photoId === null) break;
        const { opId, params, transient } = update;
        this.applyStack(await this.engine.call("op.update", { photoId, opId, params, transient }));
        this.requestRender();
      }
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.updateInFlight = false;
    }
  }

  private applyStack(state: StackGetResult): void {
    this.stack = state.stack;
    this.revision = state.revision;
    this.canUndo = state.canUndo;
    this.canRedo = state.canRedo;
  }
}

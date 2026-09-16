// The open photo as the engine reports it. Every field is a mirror of the engine's
// answer, never a local edit: a control calls `setParam`, the engine replies with the
// new stack, the mirror updates and a frame is requested. Nothing here is edit state.
import type { FrameHeader, Op } from "@latent/protocol";

export interface ViewerService {
  readonly photoId: number | null;
  /** Human-readable connection/photo state for the viewer's toolbar. */
  readonly status: string;
  /** Round trip of the last `view.render`, in milliseconds. */
  readonly latencyMs: number;
  readonly lastFrame: { header: FrameHeader; pixels: Uint8ClampedArray } | null;
  readonly stack: Op[];
  /** Stack revision the engine last reported; it advances on every change it accepts. */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /**
   * Merge `params` into the op with this name, adding it to the stack when absent.
   * `transient` is true while a slider is dragged: no history snapshot, no sidecar.
   */
  setParam(op: string, params: Record<string, unknown>, transient: boolean): Promise<void>;
  /** Opens a photo and a view of `width`×`height` device pixels for it. */
  open(path: string, width: number, height: number): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Viewport changed: the next frame is rendered at this size, in device pixels. */
  resize(width: number, height: number): void;
  /** Coalesced: one render in flight, at most one queued behind it. */
  requestRender(): void;
}

// The open photo as the engine reports it. Every field is a mirror of the engine's
// answer, never a local edit: a control calls `setParam`, the engine replies with the
// new stack, the mirror updates and a frame is requested. Nothing here is edit state.
import type { Op } from "@latent/protocol";
import type { EngineFrame } from "./engine";

/** When the painter touched a frame, in `performance.now()` terms. */
export interface FrameDrawMarks {
  drawStarted: number;
  uploaded: number;
  drawn: number;
}

/** Uploads and draws one frame, synchronously, and reports how long each part took. */
export type FrameSink = (frame: EngineFrame) => FrameDrawMarks;

export interface ViewerService {
  readonly photoId: number | null;
  /** Human-readable connection/photo state for the viewer's toolbar. */
  readonly status: string;
  /** `view.render` sent → frame on screen, in milliseconds. */
  readonly latencyMs: number;
  /** The engine's own share of `latencyMs`: `renderMs + readbackMs` of the last reply. */
  readonly engineMs: number;
  /**
   * The canvas hands over its painter; frames are drawn from the socket's message handler,
   * not through reactive state, which would land a scheduler flush later. Returns the
   * detach.
   */
  attachFrameSink(sink: FrameSink): () => void;
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
  /**
   * Opens a photo and a view for it, `width`×`height` in device pixels. Without a size the
   * viewer renders at the size its canvas last reported, which is what the filmstrip wants.
   */
  open(path: string, width?: number, height?: number): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Viewport changed: the next frame is rendered at this size, in device pixels. */
  resize(width: number, height: number): void;
  /** Coalesced: one render in flight, at most one queued behind it. */
  requestRender(): void;
}

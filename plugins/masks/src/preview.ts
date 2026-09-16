// One `mask.preview` at a time. The LMSK frame is tagged with a viewId, not with the call
// that asked for it, and several previews can be in flight for one view — so the only way
// to pair a frame with its result is to have exactly one request open at a time. Every
// caller goes through a queue; the engine still renders the newest state it has.
import type { ContentRect, EngineClient } from "@latent/contracts";
import type { MaskPreviewParams } from "@latent/protocol";

export interface MaskPreview {
  width: number;
  height: number;
  /** r8 coverage, our own copy: the socket's buffer is gone after the dispatch. */
  coverage: Uint8Array;
  /** Fraction of the frame above 50 %, straight from the result. */
  fraction: number;
  /**
   * Where the photo is inside the raster, in raster pixels — the sub-rectangle an overlay
   * blits, because the raster is letterboxed exactly like the frame it lies over. Null
   * from an engine that does not send it; the whole raster is the fallback.
   */
  contentRect: ContentRect | null;
}

/** What the LMSK frame alone carries; the rest of `MaskPreview` comes from the result. */
type RasterFrame = Omit<MaskPreview, "fraction" | "contentRect">;

export class MaskPreviewQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private receive: ((preview: RasterFrame) => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly engine: EngineClient) {
    this.unsubscribe = this.engine.onMask((header, coverage) => {
      // A copy, once: everything downstream keeps it (a tint, a thumbnail) and the view
      // into the socket's buffer is only valid inside this call.
      this.receive?.({
        width: header.width,
        height: header.height,
        coverage: new Uint8Array(coverage),
      });
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.receive = null;
  }

  /** Resolves with the raster, or null when the engine answered without sending one. */
  request(params: MaskPreviewParams): Promise<MaskPreview | null> {
    const run = this.chain.then(() => this.send(params));
    // The queue survives a rejection: one failed preview must not stall every later one.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async send(params: MaskPreviewParams): Promise<MaskPreview | null> {
    let frame: RasterFrame | null = null;
    this.receive = (preview) => {
      frame = preview;
    };
    try {
      // The frame is sent before the result on the same socket, so it has landed by now.
      const result = await this.engine.call("mask.preview", params);
      if (!frame) return null;
      return {
        ...(frame as RasterFrame),
        fraction: result.coverage ?? 0,
        contentRect: result.contentRect ?? null,
      };
    } finally {
      this.receive = null;
    }
  }
}

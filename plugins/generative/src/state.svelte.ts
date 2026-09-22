// The Generative column's own state. Everything about the backend, the job and the op the
// column points at lives in RasterOpState, which the AI Denoise and AI Upscale columns
// share (raster.svelte.ts); what is left here is what only a masked fill has — the region.
import type { EngineClient, ViewerService } from "@latent/contracts";
import type { Mask, Op } from "@latent/protocol";
import { generativeOps, hasMask, type GenerativeOpName } from "./generative";
import { RasterOpState } from "./raster.svelte";

export class GenerativeState extends RasterOpState {
  constructor(engine: EngineClient, viewer: ViewerService) {
    super(engine, viewer, generativeOps);
  }

  override async create(name: GenerativeOpName, mask: Mask | undefined): Promise<string | null> {
    return super.create(name, mask);
  }

  protected override refuseRun(op: Op): string {
    if (hasMask(op)) return "";
    return "this op has no mask, and the mask is the region to repaint";
  }
}

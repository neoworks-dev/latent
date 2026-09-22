// The AI Upscale column's state. The machinery — backend status, the job, the op the column
// points at — is RasterOpState, shared with the Generative and Denoise columns; this adds
// only what is specific to upscale, which is the op it speaks for.
import type { EngineClient, ViewerService } from "@latent/contracts";
import { RasterOpState } from "@latent/plugin-generative";
import { UPSCALE_OP } from "./upscale";

export class UpscaleState extends RasterOpState {
  constructor(engine: EngineClient, viewer: ViewerService) {
    super(engine, viewer, [UPSCALE_OP]);
  }

  /** Adds the op. There is no mask to hand over: an upscale is the whole frame. */
  async add(): Promise<string | null> {
    return this.create(UPSCALE_OP);
  }
}

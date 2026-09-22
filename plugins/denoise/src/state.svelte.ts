// The AI Denoise column's state. The machinery — backend status, the job, the op the column
// points at — is RasterOpState, shared with the Generative and Upscale columns; this adds
// only what is specific to denoise, which is the op it speaks for.
import type { EngineClient, ViewerService } from "@latent/contracts";
import type { Op } from "@latent/protocol";
import { RasterOpState } from "@latent/plugin-generative";
import { DENOISE_OP, MANUAL_DENOISE_OP } from "./denoise";

export class DenoiseState extends RasterOpState {
  constructor(engine: EngineClient, viewer: ViewerService) {
    super(engine, viewer, [DENOISE_OP]);
  }

  /** Adds the op. There is no mask to hand over: a denoise is the whole frame. */
  async add(): Promise<string | null> {
    return this.create(DENOISE_OP);
  }
}

/**
 * The manual filter's half of the column. Nothing here is a job: the op is four numbers the
 * renderer reads every frame, so a slider is a stack write and the picture follows. It is
 * its own object rather than a second mode of DenoiseState because it shares none of that
 * machinery — no backend status, no progress, nothing to cancel.
 */
export class ManualDenoiseState {
  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
  ) {}

  /** The selected manual denoise, else the last one in the stack. */
  get op(): Op | undefined {
    const selected = this.viewer.stack.find((op) => op.id === this.viewer.selectedOpId);
    if (selected?.op === MANUAL_DENOISE_OP) return selected;
    return [...this.viewer.stack].reverse().find((op) => op.op === MANUAL_DENOISE_OP);
  }

  async add(): Promise<string | null> {
    const photoId = this.viewer.photoId;
    if (photoId === null) return null;
    const state = await this.engine.call("op.add", { photoId, op: MANUAL_DENOISE_OP });
    const added = [...state.stack].reverse().find((op) => op.op === MANUAL_DENOISE_OP);
    if (added) this.viewer.selectOp(added.id);
    return added?.id ?? null;
  }

  /** `transient` while a slider is being dragged: one history step per gesture, not per tick. */
  async setParams(params: Record<string, unknown>, transient: boolean): Promise<void> {
    const op = this.op;
    if (!op) return;
    await this.viewer.setOpParams(op.id, params, transient);
  }
}

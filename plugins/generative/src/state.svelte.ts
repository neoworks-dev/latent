// The Generative column's own state: which backend the engine reports, which op the column
// is pointed at, and the job that is running. Nothing here is edit state — the prompt, the
// model and the seed are op params, so every change is a stack write and comes back from
// the engine (PROMPT.md 3.5); only the in-flight job lives here, because a job is not an
// edit.
import type { EngineClient, ViewerService } from "@latent/contracts";
import type { GenerativeStatusResult, Mask, Op, OpAddParams } from "@latent/protocol";
import {
  currentOp,
  failureMessage,
  hasMask,
  isGenerativeOp,
  type GenerativeOpName,
} from "./generative";

/**
 * A copy of a layer's mask, so two ops never share one. Through JSON rather than
 * `structuredClone`, which refuses the `$state` proxy the mask arrives as.
 */
function maskCopy(mask: Mask): Mask {
  return JSON.parse(JSON.stringify(mask));
}

export class GenerativeState {
  status = $state<GenerativeStatusResult | null>(null);
  /** The job the Run button started, or null when nothing is running. */
  jobId = $state<number | null>(null);
  progress = $state(0);
  /** What the job is doing right now — "queued", "sampling", the backend's own note. */
  note = $state("");
  error = $state("");
  /** The last completed run, so the pane can say what actually produced the pixels. */
  ran = $state("");

  private readonly unsubscribeJobs: () => void;

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
  ) {
    this.unsubscribeJobs = engine.on("job.progress", (params) => {
      if (params.kind !== "generative" || params.jobId !== this.jobId) return;
      this.progress = params.total > 0 ? params.done / params.total : 0;
      this.note = params.message ?? "";
      if (!params.finished) return;
      this.jobId = null;
      this.progress = 0;
      this.error = "";
      this.ran = "";
      this.note = "";
      if (params.error) this.error = failureMessage(params.error);
      if (params.state === "done") this.ran = params.message ?? "done";
    });
  }

  dispose(): void {
    this.unsubscribeJobs();
  }

  get op(): Op | undefined {
    return currentOp(this.viewer.stack, this.viewer.selectedOpId);
  }

  get running(): boolean {
    return this.jobId !== null;
  }

  /** Asked once when the column opens and after `comfy launch`, never per frame. */
  async refreshStatus(): Promise<void> {
    try {
      this.status = await this.engine.call("generative.status", {});
    } catch (error) {
      this.status = null;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Adds a generative op carrying the mask of whatever layer is selected, which is how the
   * Masks column hands one over. Without a selected mask the op is created bare and the
   * pane offers the same mask kinds the Masks column does.
   */
  async create(name: GenerativeOpName, mask: Mask | undefined): Promise<string | null> {
    const photoId = this.viewer.photoId;
    if (photoId === null) return null;
    this.error = "";
    try {
      const params: OpAddParams = { photoId, op: name };
      if (mask) params.mask = maskCopy(mask);
      const state = await this.engine.call("op.add", params);
      const added = [...state.stack].reverse().find((op) => isGenerativeOp(op.op));
      if (added) this.viewer.selectOp(added.id);
      return added?.id ?? null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async setParams(params: Record<string, unknown>): Promise<void> {
    const op = this.op;
    if (!op) return;
    await this.viewer.setOpParams(op.id, params, false);
  }

  /** The only thing that starts a run. A stale op keeps its last result until this. */
  async run(): Promise<void> {
    const op = this.op;
    const photoId = this.viewer.photoId;
    if (!op || photoId === null || this.running) return;
    if (!hasMask(op)) {
      this.error = "this op has no mask, and the mask is the region to repaint";
      return;
    }
    this.error = "";
    this.ran = "";
    this.note = "starting";
    try {
      const { jobId } = await this.engine.call("generative.run", { photoId, opId: op.id });
      this.jobId = jobId;
    } catch (error) {
      this.note = "";
      this.error = failureMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async cancel(): Promise<void> {
    const jobId = this.jobId;
    if (jobId === null) return;
    await this.engine.call("job.cancel", { jobId });
  }
}

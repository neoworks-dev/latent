// What every model-raster column needs and none of them should own twice: the backend's
// status, the job a Run button started, and the op the column is pointed at. Generative
// fill, remove, AI denoise and AI upscale are the same machine with different graphs
// (PROMPT.md 3.5, issues #51 and #52) — they differ in what goes in the request, which is
// the engine's business, not the column's.
//
// Nothing here is edit state: every param is an op param, so a change is a stack write and
// comes back from the engine. Only the in-flight job lives here, because a job is not an
// edit.
import type { EngineClient, ViewerService } from "@latent/contracts";
import type { GenerativeStatusResult, Mask, Op, OpAddParams } from "@latent/protocol";
import { failureMessage } from "./generative";

/**
 * A copy of a layer's mask, so two ops never share one. Through JSON rather than
 * `structuredClone`, which refuses the `$state` proxy the mask arrives as.
 */
function maskCopy(mask: Mask): Mask {
  return JSON.parse(JSON.stringify(mask));
}

export class RasterOpState {
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
    protected readonly engine: EngineClient,
    protected readonly viewer: ViewerService,
    /** The op names this column speaks for, in the order its buttons offer them. */
    private readonly names: readonly string[],
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

  /**
   * The op the column is pointed at: the selection when it is one of this column's, else
   * the last one of them in the stack — the same rule the Masks column follows for layers.
   */
  get op(): Op | undefined {
    const selected = this.viewer.stack.find((op) => op.id === this.viewer.selectedOpId);
    if (selected && this.names.includes(selected.op)) return selected;
    return [...this.viewer.stack].reverse().find((op) => this.names.includes(op.op));
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
   * Adds one of this column's ops. `mask` is the region a fill repaints, handed over by the
   * Masks column; the whole-frame ops pass nothing, because they have no region to choose.
   */
  async create(name: string, mask?: Mask): Promise<string | null> {
    const photoId = this.viewer.photoId;
    if (photoId === null) return null;
    this.error = "";
    try {
      const params: OpAddParams = { photoId, op: name };
      if (mask) params.mask = maskCopy(mask);
      const state = await this.engine.call("op.add", params);
      const added = [...state.stack].reverse().find((op) => this.names.includes(op.op));
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
    const refusal = this.refuseRun(op);
    if (refusal) {
      this.error = refusal;
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

  /** Why this op cannot run yet, in a sentence, or "" when it can. */
  protected refuseRun(_op: Op): string {
    return "";
  }

  async cancel(): Promise<void> {
    const jobId = this.jobId;
    if (jobId === null) return;
    await this.engine.call("job.cancel", { jobId });
  }
}

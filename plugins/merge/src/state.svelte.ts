// Photo Merge's reactive holder. Nothing here is edit state: the merge runs in the engine,
// the preview is a PNG the engine wrote and serves, and the merged photo is a catalog row
// the engine registered. This class holds the dialog's options, the two jobs it watches,
// and the URL the <img> points at.
import type { EngineClient, ViewerService } from "@latent/contracts";
import type { CatalogState } from "@latent/plugin-catalog";
import type { CatalogPhoto, JobProgressParams, MergeKind } from "@latent/protocol";
import {
  countProblem,
  defaultMergeOptions,
  foldProgress,
  mergeMethod,
  mergeParams,
  previewParams,
  previewSignature,
  trackJob,
  type MergeOptions,
  type TrackedJob,
} from "./merge";
import { PreviewRequester } from "./preview";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MergeState {
  open = $state(false);
  kind = $state<MergeKind>("hdr");
  photoIds = $state<number[]>([]);
  options = $state<MergeOptions>({ ...defaultMergeOptions });
  /** The engine's own `http://127.0.0.1:<port>/preview/…` URL — an `<img src>`, never a
   *  `file://` read, which the renderer would block. The engine builds it, not the UI. */
  previewUrl = $state("");
  previewJob = $state<TrackedJob | null>(null);
  mergeJob = $state<TrackedJob | null>(null);
  error = $state("");

  private readonly requester: PreviewRequester;
  private readonly unsubscribeJobs: () => void;
  /** Resolves the in-flight preview run once its job reports `finished`. */
  private previewSettled: (() => void) | null = null;

  constructor(
    private readonly engine: EngineClient,
    private readonly catalog: CatalogState,
    private readonly viewer: ViewerService,
  ) {
    this.requester = new PreviewRequester((signature) => this.runPreview(signature));
    this.unsubscribeJobs = engine.on("job.progress", (params) => this.onProgress(params));
  }

  dispose(): void {
    this.requester.drop();
    this.settlePreviewRun();
    this.unsubscribeJobs();
  }

  get previewing(): boolean {
    const job = this.previewJob;
    return job !== null && !job.finished;
  }

  get merging(): boolean {
    const job = this.mergeJob;
    return job !== null && !job.finished;
  }

  /** Why this selection cannot be merged as this kind, or `""` when it can. */
  get problem(): string {
    return countProblem(this.kind, this.photoIds.length);
  }

  /**
   * The rows being merged. They come off the catalog's own page, so the dialog reuses the
   * thumbnails that page already fetched instead of opening a second thumbnail path.
   */
  get photos(): CatalogPhoto[] {
    return this.catalog.photos.filter((photo) => this.photoIds.includes(photo.photoId));
  }

  openDialog(kind: MergeKind, photoIds: number[]): void {
    this.kind = kind;
    this.photoIds = [...photoIds];
    this.previewUrl = "";
    this.previewJob = null;
    this.mergeJob = null;
    this.error = "";
    this.open = true;
    this.requester.drop();
    this.syncPreview();
  }

  close(): void {
    this.open = false;
    this.requester.drop();
    this.settlePreviewRun();
  }

  setKind(kind: MergeKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.syncPreview();
  }

  setOptions(patch: Partial<MergeOptions>): void {
    this.options = { ...this.options, ...patch };
    this.syncPreview();
  }

  /** Re-asks for the preview when something that changes the picture moved. Debounced. */
  syncPreview(): void {
    if (!this.open || this.problem !== "") return;
    this.requester.request(previewSignature(this.kind, this.photoIds, this.options));
  }

  /** The Merge button: one call, then the bar follows the job it named. */
  async merge(): Promise<void> {
    if (this.problem !== "" || this.merging) return;
    this.error = "";
    try {
      const started = await this.engine.call(
        mergeMethod(this.kind),
        mergeParams(this.kind, this.photoIds, this.options),
      );
      this.mergeJob = trackJob(started.jobId);
    } catch (error) {
      this.error = messageOf(error);
    }
  }

  /** Cancel: stops whatever this dialog started, then shuts it. */
  async cancel(): Promise<void> {
    const running = [this.mergeJob, this.previewJob].filter(
      (job): job is TrackedJob => job !== null && !job.finished,
    );
    this.close();
    for (const job of running) {
      try {
        await this.engine.call("job.cancel", { jobId: job.jobId });
      } catch (error) {
        this.error = messageOf(error);
      }
    }
  }

  /**
   * One `merge.preview`, resolving when its *job* ends rather than when the call returns —
   * that is what makes the requester's "one in flight" mean one job in the engine.
   */
  private async runPreview(signature: string): Promise<void> {
    // The debounce ran while the options moved on: the requester has already asked for the
    // newer signature, so this run has nothing to send.
    if (previewSignature(this.kind, this.photoIds, this.options) !== signature) return;
    try {
      const started = await this.engine.call(
        "merge.preview",
        previewParams(this.kind, this.photoIds, this.options),
      );
      this.previewJob = trackJob(started.jobId);
    } catch (error) {
      this.error = messageOf(error);
      return;
    }
    await new Promise<void>((resolve) => {
      this.previewSettled = resolve;
    });
  }

  private onProgress(params: JobProgressParams): void {
    if (params.kind !== "merge") return;
    const preview = foldProgress(this.previewJob, params);
    if (preview !== this.previewJob) {
      this.previewJob = preview;
      if (preview?.finished) this.finishPreview(preview);
      return;
    }
    const merged = foldProgress(this.mergeJob, params);
    if (merged === this.mergeJob) return;
    this.mergeJob = merged;
    if (merged?.finished) void this.finishMerge(merged);
  }

  private finishPreview(job: TrackedJob): void {
    const url = job.result?.previewUrl;
    if (url) this.previewUrl = url;
    if (job.error) this.error = job.error;
    this.settlePreviewRun();
  }

  private settlePreviewRun(): void {
    const settle = this.previewSettled;
    this.previewSettled = null;
    if (settle) settle();
  }

  /**
   * The merged photo is a catalog row the engine registered and announced with
   * `catalog.changed { reason: "import" }`. The catalog's own re-list is debounced, and the
   * new row need not land on the page the filmstrip is showing, so the row is fetched by id
   * (`loadRow` falls back to `catalog.get`) and the viewer is pointed at the file it names.
   */
  private async finishMerge(job: TrackedJob): Promise<void> {
    if (job.error) {
      this.error = job.error;
      return;
    }
    if (job.state === "cancelled") return;
    const photoId = job.result?.photoId;
    if (photoId === undefined) {
      this.error = "the merge finished without naming a photo";
      return;
    }
    await this.catalog.loadRow(photoId);
    const row = this.catalog.openRow;
    if (row) await this.viewer.open(row.path);
    this.close();
  }
}

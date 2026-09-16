// The Export pane's state: the settings the user is filling in, and the one job at a time
// it is watching. The files themselves are the engine's business — this never sees pixels.
import type { EngineClient, ViewerService } from "@latent/contracts";
import type { CatalogState } from "@latent/plugin-catalog";
import type { JobProgressParams } from "@latent/protocol";
import { defaultSettings, exportParams, exportPhotoIds, type ExportSettings } from "./export";

export class ExportState {
  settings = $state<ExportSettings>(defaultSettings());
  /** The last `export.run` job, running or just finished. Null before the first run. */
  job = $state<JobProgressParams | null>(null);
  /** An RPC rejection — a bad folder, an unknown photo. Cleared by the next run. */
  error = $state("");

  private readonly unsubscribe: () => void;
  private jobId: number | null = null;

  constructor(
    private readonly engine: EngineClient,
    private readonly catalog: CatalogState,
    private readonly viewer: ViewerService,
  ) {
    this.unsubscribe = engine.on("job.progress", (params) => {
      if (params.kind !== "export" || params.jobId !== this.jobId) return;
      this.job = params;
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** The library selection, or the open photo when nothing is selected. */
  get photoIds(): number[] {
    return exportPhotoIds(this.catalog.selection, this.viewer.photoId);
  }

  get fromSelection(): boolean {
    return this.catalog.selection.length > 0;
  }

  get running(): boolean {
    return this.job !== null && !this.job.finished;
  }

  async run(photoIds: number[]): Promise<void> {
    if (this.running) return;
    this.error = "";
    const params = exportParams(this.settings, photoIds);
    // The bar has to exist before the first tick, or a slow first render looks like a
    // button that did nothing.
    this.job = {
      jobId: 0,
      kind: "export",
      done: 0,
      total: photoIds.length,
      finished: false,
      state: "running",
    };
    try {
      const result = await this.engine.call("export.run", params);
      this.jobId = result.jobId;
      if (this.job !== null) this.job = { ...this.job, jobId: result.jobId, total: result.total };
    } catch (failure) {
      this.jobId = null;
      this.job = null;
      this.error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  async cancel(): Promise<void> {
    if (this.jobId === null) return;
    await this.engine.call("job.cancel", { jobId: this.jobId });
  }

  async pickOutputDir(): Promise<void> {
    const directory = await window.latentDesktop?.pickDirectory();
    if (directory === undefined || directory === null) return;
    this.settings = { ...this.settings, outputDir: directory };
  }
}

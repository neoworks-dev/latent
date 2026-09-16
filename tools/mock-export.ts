// Export in the mock engine. Nothing is rendered and nothing is written: the point is that
// the Export pane's whole round trip — validate, start a job, watch the bar, cancel — runs
// without LibRaw, a GPU or a disk. The job ticks one photo at a time and its `message` is
// the file it claims to be on, which is what the real engine sends.
import type { ExportFormat, ExportRunParams, NotificationName } from "@latent/protocol";
import { basename, extname, join } from "node:path";

/** Same table as engine/src/export/export_options.cpp. */
const extensions: Record<ExportFormat, string> = {
  jpeg: "jpg",
  tiff16: "tif",
  png: "png",
  avif: "avif",
};

/** How long the mock pretends one full-res render plus encode takes. */
const msPerPhoto = 140;

export interface ExportJobHandle {
  cancelled: boolean;
  finished: boolean;
}

export interface ExportHost {
  broadcast(method: NotificationName, params: unknown): void;
  /** Reserves a cancellable job id in the engine's own job map. */
  startJob(): { jobId: number; job: ExportJobHandle };
  timer(callback: () => void, delayMs: number): void;
  /** The source path of a catalog row, for `{name}`. Empty when the id is unknown. */
  sourcePath(photoId: number): string;
}

/** The template rules the engine implements, including "a template is a file name". */
export function exportFileName(
  template: string,
  sourcePath: string,
  index: number,
  format: ExportFormat,
): string {
  const extension = extensions[format];
  const stem = basename(sourcePath, extname(sourcePath)) || "photo";
  let name = (template || "{name}")
    .replaceAll("{name}", stem)
    .replaceAll("{index}", String(index))
    .replaceAll("{ext}", extension);
  name = name.replaceAll("/", "").replaceAll("\\", "").replace(/^\.+/, "");
  if (name === "") name = "photo";
  return name.endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/** The engine's uniquifier: a second `IMG.jpg` in one run becomes `IMG-2.jpg`. */
export function planFiles(params: ExportRunParams, sources: string[]): string[] {
  const taken = new Set<string>();
  return params.photoIds.map((_, index) => {
    const name = exportFileName(
      params.fileNameTemplate ?? "{name}",
      sources[index] ?? "",
      index + 1,
      params.format,
    );
    let unique = name;
    for (let suffix = 2; taken.has(unique); suffix++) {
      const dot = name.lastIndexOf(".");
      unique = `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
    }
    taken.add(unique);
    return join(params.outputDir, unique);
  });
}

export class MockExport {
  constructor(private readonly host: ExportHost) {}

  handle(method: string, params: Record<string, unknown>): { result: unknown } {
    if (method !== "export.run") throw new Error(`unknown method ${method}`);
    return { result: this.start(params as unknown as ExportRunParams) };
  }

  private start(params: ExportRunParams): { jobId: number; total: number } {
    if (!Array.isArray(params.photoIds) || params.photoIds.length === 0) {
      throw new Error("params.photoIds must be a non-empty array");
    }
    if (!params.outputDir) throw new Error("params.outputDir must be a non-empty string");
    if (!(params.format in extensions)) throw new Error(`unknown format ${params.format}`);

    const files = planFiles(
      params,
      params.photoIds.map((photoId) => this.host.sourcePath(photoId)),
    );
    const total = files.length;
    const { jobId, job } = this.host.startJob();
    let done = 0;

    const finish = (state: "done" | "cancelled"): void => {
      job.finished = true;
      this.host.broadcast("job.progress", {
        jobId,
        kind: "export",
        done,
        total,
        finished: true,
        state,
        message: `${done} of ${total} written`,
      });
    };

    const tick = (): void => {
      if (job.cancelled) {
        finish("cancelled");
        return;
      }
      this.host.broadcast("job.progress", {
        jobId,
        kind: "export",
        done,
        total,
        finished: false,
        state: "running",
        message: files[done],
      });
      done += 1;
      if (done >= total) {
        this.host.timer(() => finish("done"), msPerPhoto);
        return;
      }
      this.host.timer(tick, msPerPhoto);
    };

    this.host.timer(tick, msPerPhoto);
    return { jobId, total };
  }
}

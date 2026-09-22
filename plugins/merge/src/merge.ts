// Photo Merge's pure half: which controls a kind shows, what it sends, and how a
// `job.progress` notification folds into what the dialog draws. No runes and no DOM here —
// `MergeState` is a reactive holder over these functions, which is what the tests exercise.
//
// Every name, range and default mirrors Lightroom's Photo Merge dialog
// (`reference/lightroom/hdr-panorama.md`).
import type {
  JobProgressParams,
  JobResult,
  MergeDeghost,
  MergeHdrPanoramaParams,
  MergeHdrParams,
  MergeKind,
  MergePanoramaParams,
  MergePreviewParams,
  MergeProjection,
  MergeStarTrailParams,
  MergeTrailBlend,
  MergeTrailForeground,
} from "@latent/protocol";

/**
 * The options the dialog holds, one bag for all three kinds. A kind shows only the half it
 * uses and the params builder drops the rest, so switching kind never loses a setting the
 * user already made.
 */
export interface MergeOptions {
  autoAlign: boolean;
  deghost: MergeDeghost;
  projection: MergeProjection;
  boundaryWarp: number;
  autoCrop: boolean;
  blend: MergeTrailBlend;
  gapFill: number;
  foreground: MergeTrailForeground;
  foregroundThreshold: number;
  decay: number;
}

/**
 * Lightroom's own starting point: aligned, no deghosting, spherical, cropped, no warp —
 * and for the star trail merge, the plain lighten stack the schema defaults to.
 */
export const defaultMergeOptions: MergeOptions = {
  autoAlign: true,
  deghost: "none",
  projection: "spherical",
  boundaryWarp: 0,
  autoCrop: true,
  blend: "lighten",
  gapFill: 0,
  foreground: "lighten",
  foregroundThreshold: 2,
  decay: 0,
};

export const mergeKinds: readonly MergeKind[] = ["hdr", "panorama", "hdrPanorama", "starTrail"];

export const kindLabels: Record<MergeKind, string> = {
  hdr: "HDR",
  panorama: "Panorama",
  hdrPanorama: "HDR Panorama",
  starTrail: "Star Trails",
};

/** The suffix Lightroom gives the merged file; the dialog shows it as the output name. */
export const kindSuffixes: Record<MergeKind, string> = {
  hdr: "HDR",
  panorama: "Pano",
  hdrPanorama: "HDRPano",
  starTrail: "Trails",
};

/** Auto Align and Deghost Amount belong to the exposure half of the merge. */
export function showsHdrOptions(kind: MergeKind): boolean {
  return kind === "hdr" || kind === "hdrPanorama";
}

/** Layout projection, Boundary Warp and Auto Crop belong to the stitching half. */
export function showsPanoramaOptions(kind: MergeKind): boolean {
  return kind === "panorama" || kind === "hdrPanorama";
}

/** Blend, gap fill, foreground and comet decay belong to the night sequence. */
export function showsStarTrailOptions(kind: MergeKind): boolean {
  return kind === "starTrail";
}

/** How many source photos each kind takes, straight from the schema's bounds. */
export const photoCounts: Record<MergeKind, { min: number; max: number }> = {
  hdr: { min: 2, max: 7 },
  panorama: { min: 2, max: 12 },
  hdrPanorama: { min: 4, max: 48 },
  // The frames are folded in as they decode and dropped again (engine/src/merge/startrail.h),
  // so this cap is the night, not the memory.
  starTrail: { min: 2, max: 500 },
};

/** Why this selection cannot be merged as this kind, or `""` when it can. */
export function countProblem(kind: MergeKind, count: number): string {
  const bounds = photoCounts[kind];
  if (count < bounds.min) {
    return `${kindLabels[kind]} needs at least ${bounds.min} photos — ${count} selected`;
  }
  if (count > bounds.max) {
    return `${kindLabels[kind]} takes at most ${bounds.max} photos — ${count} selected`;
  }
  return "";
}

export const deghostOptions: { value: MergeDeghost; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export const blendOptions: { value: MergeTrailBlend; label: string }[] = [
  { value: "lighten", label: "Lighten (trails)" },
  { value: "average", label: "Average (one exposure)" },
];

export const foregroundOptions: { value: MergeTrailForeground; label: string }[] = [
  { value: "lighten", label: "Brightest frame" },
  { value: "firstFrame", label: "First frame" },
];

export const projectionOptions: { value: MergeProjection; label: string }[] = [
  { value: "spherical", label: "Spherical" },
  { value: "cylindrical", label: "Cylindrical" },
  { value: "perspective", label: "Perspective" },
];

/** Boundary Warp is Lightroom's 0–100 percentage; the slider is the panel column's. */
export const boundaryWarpRange = { min: 0, max: 100, step: 1 };

/** The star trail sliders, in the engine's own ranges (protocol MergeStarTrailParams). */
export const gapFillRange = { min: 0, max: 8, step: 1 };
export const foregroundThresholdRange = { min: 0, max: 100, step: 1 };
export const decayRange = { min: 0, max: 100, step: 1 };

export function isMergeKind(value: string): value is MergeKind {
  return mergeKinds.some((entry) => entry === value);
}

export function isDeghost(value: string): value is MergeDeghost {
  return deghostOptions.some((option) => option.value === value);
}

export function isProjection(value: string): value is MergeProjection {
  return projectionOptions.some((option) => option.value === value);
}

export function isTrailBlend(value: string): value is MergeTrailBlend {
  return blendOptions.some((option) => option.value === value);
}

export function isTrailForeground(value: string): value is MergeTrailForeground {
  return foregroundOptions.some((option) => option.value === value);
}

export type MergeMethod = "merge.hdr" | "merge.panorama" | "merge.hdrPanorama" | "merge.starTrail";

const methodByKind: Record<MergeKind, MergeMethod> = {
  hdr: "merge.hdr",
  panorama: "merge.panorama",
  hdrPanorama: "merge.hdrPanorama",
  starTrail: "merge.starTrail",
};

export function mergeMethod(kind: MergeKind): MergeMethod {
  return methodByKind[kind];
}

export type MergeParams =
  MergeHdrParams | MergePanoramaParams | MergeHdrPanoramaParams | MergeStarTrailParams;

/**
 * The params for `mergeMethod(kind)`. Only the fields that kind's method accepts are put
 * in: an HDR merge that carried a projection would be a request the schema rejects.
 */
export function mergeParams(
  kind: MergeKind,
  photoIds: number[],
  options: MergeOptions,
): MergeParams {
  const ids = [...photoIds];
  if (kind === "hdr") {
    return { photoIds: ids, autoAlign: options.autoAlign, deghost: options.deghost };
  }
  if (kind === "panorama") {
    return {
      photoIds: ids,
      projection: options.projection,
      boundaryWarp: options.boundaryWarp,
      autoCrop: options.autoCrop,
    };
  }
  if (kind === "starTrail") {
    return {
      photoIds: ids,
      blend: options.blend,
      gapFill: options.gapFill,
      foreground: options.foreground,
      foregroundThreshold: options.foregroundThreshold,
      decay: options.decay,
    };
  }
  return {
    photoIds: ids,
    autoAlign: options.autoAlign,
    deghost: options.deghost,
    projection: options.projection,
    boundaryWarp: options.boundaryWarp,
    autoCrop: options.autoCrop,
  };
}

/** Long edge of the preview the dialog shows; the schema's own default. */
export const previewLongEdge = 1024;

export function previewParams(
  kind: MergeKind,
  photoIds: number[],
  options: MergeOptions,
): MergePreviewParams {
  return { ...mergeParams(kind, photoIds, options), kind, longEdge: previewLongEdge };
}

/**
 * Everything that changes the picture, as one string. The dialog re-asks for a preview
 * when this moves and stays quiet when it does not — flipping to a kind that ignores
 * Boundary Warp and back is the same preview, so it costs no round trip.
 */
export function previewSignature(
  kind: MergeKind,
  photoIds: number[],
  options: MergeOptions,
): string {
  return JSON.stringify(previewParams(kind, photoIds, options));
}

/** What the dialog draws while a job runs, and what it opens once the job is done. */
export interface TrackedJob {
  jobId: number;
  done: number;
  total: number;
  finished: boolean;
  state: NonNullable<JobProgressParams["state"]>;
  message: string;
  error: string;
  result: JobResult | null;
}

export function trackJob(jobId: number): TrackedJob {
  return {
    jobId,
    done: 0,
    total: 0,
    finished: false,
    state: "running",
    message: "",
    error: "",
    result: null,
  };
}

/**
 * Folds one `job.progress` into the job being watched. Returns `tracked` unchanged for
 * every other job on the socket — a merge dialog sees the imports and thumbnail jobs of
 * the whole session and must ignore them. `state` is optional on the wire, so an engine
 * that does not send it still lands on `running` then `done`.
 */
export function foldProgress(
  tracked: TrackedJob | null,
  params: JobProgressParams,
): TrackedJob | null {
  if (!tracked || params.jobId !== tracked.jobId) return tracked;
  return {
    jobId: tracked.jobId,
    done: params.done,
    total: params.total,
    finished: params.finished,
    state: params.state ?? (params.finished ? "done" : "running"),
    message: params.message ?? "",
    error: params.error ?? "",
    // `result` only ever rides the last notification; keep whatever an earlier tick left.
    result: params.result ?? tracked.result,
  };
}

/** Fraction of the bar that is filled. A job that has not said how big it is shows none. */
export function progressFraction(tracked: TrackedJob | null): number {
  if (!tracked || tracked.total <= 0) return 0;
  if (tracked.finished) return 1;
  return Math.min(1, Math.max(0, tracked.done / tracked.total));
}

/** The line under the bar: the engine's own message, else the counts, else the state. */
export function progressLabel(tracked: TrackedJob | null): string {
  if (!tracked) return "";
  if (tracked.error) return tracked.error;
  if (tracked.message) return tracked.message;
  if (tracked.total > 0) return `${tracked.done} of ${tracked.total}`;
  return tracked.state;
}

// Every decision the Export pane makes, as pure functions: which photos a run covers, what
// `export.run` is asked for, and how a job.progress reads. The pane is then markup over
// these, and the tests never need a kernel or a socket.
import type {
  ExportColorSpace,
  ExportFormat,
  ExportRunParams,
  JobProgressParams,
} from "@latent/protocol";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Mirrors the schema's ExportFormat enum; the labels are what Lightroom calls them. */
export const formatChoices: readonly Choice<ExportFormat>[] = [
  { value: "jpeg", label: "JPEG" },
  { value: "tiff16", label: "TIFF 16-bit" },
  { value: "png", label: "PNG 16-bit" },
  { value: "avif", label: "AVIF 10-bit" },
];

export const colorSpaceChoices: readonly Choice<ExportColorSpace>[] = [
  { value: "srgb", label: "sRGB" },
  { value: "displayP3", label: "Display P3" },
  { value: "adobeRGB", label: "Adobe RGB" },
  { value: "rec2020", label: "Rec. 2020" },
  { value: "proPhoto", label: "ProPhoto RGB" },
];

export type SharpenChoice = "none" | "screen" | "matte" | "glossy";

export const sharpenChoices: readonly Choice<SharpenChoice>[] = [
  { value: "none", label: "None" },
  { value: "screen", label: "Screen" },
  { value: "matte", label: "Matte paper" },
  { value: "glossy", label: "Glossy paper" },
];

export const sharpenAmountChoices: readonly Choice<"low" | "standard" | "high">[] = [
  { value: "low", label: "Low" },
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
];

export type SizeMode = "native" | "longEdge";

/** What the pane holds. One flat object so a test can build one without a kernel. */
export interface ExportSettings {
  format: ExportFormat;
  quality: number;
  colorSpace: ExportColorSpace;
  sizeMode: SizeMode;
  longEdge: number;
  dpi: number;
  sharpen: SharpenChoice;
  sharpenAmount: "low" | "standard" | "high";
  outputDir: string;
  fileNameTemplate: string;
}

export function defaultSettings(): ExportSettings {
  return {
    format: "jpeg",
    quality: 90,
    colorSpace: "srgb",
    sizeMode: "native",
    longEdge: 2048,
    dpi: 0,
    sharpen: "none",
    sharpenAmount: "standard",
    outputDir: "",
    fileNameTemplate: "{name}",
  };
}

/** Only the lossy formats read `quality`; the others hide the slider. */
export function usesQuality(format: ExportFormat): boolean {
  return format === "jpeg" || format === "avif";
}

/**
 * The library selection when there is one, otherwise the photo on screen. Lightroom's
 * rule, and the one that stops "Export" from quietly meaning something else when the grid
 * happens to have a stale selection of one.
 */
export function exportPhotoIds(selection: readonly number[], openPhotoId: number | null): number[] {
  if (selection.length > 0) return [...selection];
  if (openPhotoId === null) return [];
  return [openPhotoId];
}

/** Null when the settings cannot produce a run; the string is what the button explains. */
export function settingsProblem(settings: ExportSettings, photoCount: number): string | null {
  if (photoCount === 0) return "Open a photo or select some in the library";
  if (settings.outputDir.trim() === "") return "Choose an output folder";
  if (settings.sizeMode === "longEdge" && !(settings.longEdge >= 1 && settings.longEdge <= 16384)) {
    return "Long edge must be between 1 and 16384 pixels";
  }
  return null;
}

export function exportParams(settings: ExportSettings, photoIds: number[]): ExportRunParams {
  // The schema's `minItems: 1` reaches TypeScript as a non-empty tuple, which is the one
  // precondition this function has and the one `settingsProblem` already guards.
  const [first, ...rest] = photoIds;
  if (first === undefined) throw new Error("an export needs at least one photo");
  const params: ExportRunParams = {
    photoIds: [first, ...rest],
    format: settings.format,
    colorSpace: settings.colorSpace,
    outputDir: settings.outputDir.trim(),
  };
  if (usesQuality(settings.format)) params.quality = settings.quality;
  const resize: NonNullable<ExportRunParams["resize"]> = {};
  if (settings.sizeMode === "longEdge") resize.longEdge = settings.longEdge;
  if (settings.dpi > 0) resize.dpi = settings.dpi;
  if (Object.keys(resize).length > 0) params.resize = resize;
  if (settings.sharpen !== "none") {
    params.sharpen = { target: settings.sharpen, amount: settings.sharpenAmount };
  }
  const template = settings.fileNameTemplate.trim();
  if (template !== "" && template !== "{name}") params.fileNameTemplate = template;
  return params;
}

/** 0..100, clamped. `total` is 0 only before the first tick, where the bar is empty. */
export function jobPercent(job: JobProgressParams | null): number {
  if (!job || job.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((job.done / job.total) * 100)));
}

/** One line under the bar: the file being written, or how the run ended. */
export function jobLabel(job: JobProgressParams | null): string {
  if (!job) return "";
  if (!job.finished) {
    const counter = `${job.done + 1} of ${job.total}`;
    if (job.message === undefined || job.message === "") return `Exporting ${counter}`;
    return `Exporting ${fileNameOf(job.message)} (${counter})`;
  }
  if (job.state === "cancelled") return `Cancelled after ${job.done} of ${job.total}`;
  if (job.error !== undefined && job.error !== "") return job.error;
  return job.message === undefined ? "Done" : job.message;
}

export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

// Everything the AI Denoise column knows that is not a DOM node. No engine calls here —
// the state object makes those (issue #51).
import type { GenerativeStatusResult, Op, OpParamSpec } from "@latent/protocol";

export const DENOISE_OP = "denoise";

/**
 * The filter that needs no model and no run: an à trous wavelet in the render pass
 * (engine/shaders/blur.wgsl and neighborhood.wgsl, kind 108). It lives in this column
 * because "model or filter" is one decision, and the two compose — the filter renders after
 * the model's raster, so it cleans up whatever the model left.
 */
export const MANUAL_DENOISE_OP = "manual_denoise";

function unipolar(name: string, label: string, fallback: number): OpParamSpec {
  return { name, label, type: "number", min: 0, max: 100, step: 1, default: fallback };
}

/**
 * The four sliders, in the order the column draws them: how much of each half of the noise
 * to take out, and how hard the filter protects detail while doing it. Defaults are the
 * engine's, and both amounts default to 0 — adding the op changes no pixel until a slider
 * moves, the same contract every other op holds.
 */
export const manualSpecs: readonly OpParamSpec[] = [
  unipolar("luminance", "Luminance", 0),
  unipolar("detail", "Detail", 50),
  unipolar("color", "Color", 0),
  unipolar("colorDetail", "Color Detail", 50),
];

export const manualNote =
  "Wavelet filter, no model: three levels, luminance and colour separately. Runs in the frame budget, so it follows the slider.";

/** The value a slider shows: the op's own, or the spec's default when it has none. */
export function manualValue(op: Op | undefined, spec: OpParamSpec): number {
  const value = op?.params[spec.name];
  return typeof value === "number" ? value : Number(spec.default ?? 0);
}

/** The rail mode this column owns, and the id its pane registers under. */
export const DENOISE_MODE = "denoise";

export function isDenoiseOp(name: string): boolean {
  return name === DENOISE_OP;
}

/**
 * The Strength slider. The engine describes it as a plain 0..100 unipolar, and that is what
 * the column draws: what the number means to the sampler is the engine's business
 * (server.cpp maps it into the graph's denoise widget, which stays well under 0.5).
 */
export const strengthSpec: OpParamSpec = {
  name: "strength",
  label: "Strength",
  type: "number",
  min: 0,
  max: 100,
  step: 1,
  default: 50,
};

/**
 * What the column says about resolution, and it depends on who runs the job. A ComfyUI
 * graph is one diffusion pass, so the engine hands it at most this long edge (server.cpp,
 * kDenoiseInputSize) and the composite scales the raster back over the photo — someone
 * about to export at 24 MP should read that before waiting on a run, not after.
 */
export const DENOISE_INPUT_SIZE = 1536;

/**
 * The local model tiles, so it gets the frame at its own size, capped only by the renderer's
 * view ceiling (server.cpp, view_size).
 */
export const LOCAL_DENOISE_INPUT_SIZE = 4096;

/** The local restoration model, which the engine reports beside the graphs. */
export const LOCAL_DENOISE_MODEL = "scunet-color-real";

export function localDenoiseReady(status: GenerativeStatusResult | null): boolean {
  if (!status) return false;
  return status.workflows.some(
    (workflow) => workflow.name === LOCAL_DENOISE_MODEL && workflow.ready,
  );
}

export function resolutionNote(status: GenerativeStatusResult | null): string {
  if (localDenoiseReady(status)) {
    return `Whole frame, tiled, at up to ${LOCAL_DENOISE_INPUT_SIZE} px on the long edge.`;
  }
  return `Whole frame, at up to ${DENOISE_INPUT_SIZE} px on the long edge; the result is scaled back over the photo.`;
}

/**
 * A run needs somewhere to send it: either the local model or a graph whose weights are on
 * disk. Not `status.ready`, which is about ComfyUI — a denoise runs with no server at all
 * when the local model is installed. There is no mask to check: this op has none.
 */
export function canRun(op: Op | undefined, status: GenerativeStatusResult | null): boolean {
  if (!op) return false;
  return status === null || graphReady(status);
}

/** Whether the graph a denoise run would use has its weights on disk. */
export function graphReady(status: GenerativeStatusResult | null): boolean {
  if (!status) return false;
  if (status.stub) return true;
  return status.workflows.some((workflow) => workflow.task === "denoise" && workflow.ready);
}

export function missingGraphMessage(status: GenerativeStatusResult | null): string {
  if (graphReady(status)) return "";
  if (!status) return "";
  const named = status.workflows.find((workflow) => workflow.task === "denoise");
  if (!named) return "No denoise graph is installed — check engine/workflows/.";
  const missing = named.requires ?? [];
  if (missing.length === 0) return `${named.label ?? named.name} is not ready.`;
  return `${named.label ?? named.name} needs ${missing.join(", ")}.`;
}

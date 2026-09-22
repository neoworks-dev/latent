// Everything the AI Upscale column knows that is not a DOM node. No engine calls here —
// the state object makes those (issue #52).
import type { GenerativeStatusResult, Op } from "@latent/protocol";

export const UPSCALE_OP = "upscale";

/** The rail mode this column owns, and the id its pane registers under. */
export const UPSCALE_MODE = "upscale";

export function isUpscaleOp(name: string): boolean {
  return name === UPSCALE_OP;
}

/** The engine's `factor` param: the model's own factor is fixed, these are what it offers. */
export const factors = ["2x", "4x"] as const;
export type Factor = (typeof factors)[number];

export function factorOf(op: Op | undefined): Factor {
  return op?.params.factor === "4x" ? "4x" : "2x";
}

export function factorNumber(factor: Factor): number {
  return factor === "4x" ? 4 : 2;
}

/**
 * What the column says about size. The upscale is the one op that changes how many pixels
 * the photo has: the preview still shows the photo at its own scale, and the export renders
 * at the upscaled size rather than resampling back down (issue #52). Masks, crops and
 * every other coordinate stay normalised over the uncropped photo, so nothing else moves.
 */
export function sizeNote(op: Op | undefined): string {
  const scale = factorNumber(factorOf(op));
  return `Exports at ${scale}× the photo's pixels in each axis. The preview is unchanged — masks and crops are normalised, so nothing else moves.`;
}

/** A run needs a backend to send it to. There is no mask to check: this op has none. */
export function canRun(op: Op | undefined, status: GenerativeStatusResult | null): boolean {
  if (!op) return false;
  return status === null || status.ready;
}

/** Whether the graph an upscale run would use has its weights on disk. */
export function graphReady(status: GenerativeStatusResult | null): boolean {
  if (!status) return false;
  if (status.stub) return true;
  return status.workflows.some((workflow) => workflow.task === "upscale" && workflow.ready);
}

export function missingGraphMessage(status: GenerativeStatusResult | null): string {
  if (graphReady(status)) return "";
  if (!status) return "";
  const named = status.workflows.find((workflow) => workflow.task === "upscale");
  if (!named) return "No upscale graph is installed — check engine/workflows/.";
  const missing = named.requires ?? [];
  if (missing.length === 0) return `${named.label ?? named.name} is not ready.`;
  return `${named.label ?? named.name} needs ${missing.join(", ")}.`;
}

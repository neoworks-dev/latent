// Everything the Generative column knows that is not a DOM node: which stack entries are
// generative, what a backend's failure code means in a sentence, and which models the
// engine's status offers. No engine calls here — the state object makes those.
import type { GenerativeStatusResult, Op, OpParamSpec } from "@latent/protocol";

/** The two ops `ops.describe` puts in the `Generative` section. */
export const generativeOps = ["generative_fill", "remove"] as const;
export type GenerativeOpName = (typeof generativeOps)[number];

export function isGenerativeOp(name: string): name is GenerativeOpName {
  return generativeOps.some((entry) => entry === name);
}

export const opLabels: Record<GenerativeOpName, string> = {
  generative_fill: "Generative Fill",
  remove: "Remove",
};

/** Only `generative_fill` takes words; `remove` is the graph's own "nothing there". */
export function takesPrompt(name: string): boolean {
  return name === "generative_fill";
}

export function generativeEntries(stack: Op[]): Op[] {
  return stack.filter((op) => isGenerativeOp(op.op));
}

/**
 * The op the column is pointed at: the selection when it is a generative one, else the last
 * generative op in the stack — the same rule the Masks column follows for layers.
 */
export function currentOp(stack: Op[], selectedOpId: string | null): Op | undefined {
  const selected = stack.find((op) => op.id === selectedOpId);
  if (selected && isGenerativeOp(selected.op)) return selected;
  return [...generativeEntries(stack)].pop();
}

export function hasMask(op: Op | undefined): boolean {
  return (op?.mask?.components.length ?? 0) > 0;
}

/** A run is only possible with pixels to repaint and somewhere to send them. */
export function canRun(op: Op | undefined, status: GenerativeStatusResult | null): boolean {
  if (!op || !hasMask(op)) return false;
  return status === null || status.ready;
}

/**
 * The `comfy` CLI's error codes, as a sentence and a thing to do about it. The engine
 * forwards `error.code` verbatim (engine/src/generative/comfy_cli.h), so this is the one
 * place that translates them; an unknown code falls through to whatever the engine said.
 */
const failures: Record<string, string> = {
  server_not_running: "ComfyUI is not running. Start it with `comfy launch`.",
  connection_error: "ComfyUI could not be reached. Start it with `comfy launch`.",
  comfy_not_installed: "The `comfy` CLI is not installed. Install comfy-cli, or set LATENT_COMFY.",
  no_workflow: "No graph is installed for this op — check engine/workflows/.",
  upload_failed: "The crop could not be uploaded to ComfyUI.",
  prompt_rejected: "ComfyUI refused the graph: a node or a model in it is missing.",
  object_info_unavailable: "ComfyUI is up but did not answer; restart it.",
  execution_error: "The graph failed while it ran. `comfy logs` has the traceback.",
  download_no_outputs: "The graph ran but saved no image.",
  download_failed: "ComfyUI saved an image the engine could not read.",
  cloud_unauthorized: "The ComfyUI cloud rejected the request. Run `comfy cloud login`.",
  partner_node_requires_credential: "That graph needs an API key. Run `comfy cloud login`.",
  cancelled: "Cancelled.",
  bad_input: "The crop or the mask the engine produced was not usable.",
};

export function failureMessage(text: string): string {
  const known = failures[text.trim()];
  if (known) return known;
  return text;
}

/**
 * What the Model dropdown offers: the graphs the engine ships first — picking one is how a
 * user chooses between two graphs for the same task — then the weight files ComfyUI has.
 * An empty value means "whatever the graph loads by default".
 */
export interface ModelOption {
  value: string;
  label: string;
}

export function modelOptions(status: GenerativeStatusResult | null, op: string): ModelOption[] {
  const options: ModelOption[] = [{ value: "", label: "Default for this graph" }];
  if (!status) return options;
  const task = op === "remove" ? "remove" : "fill";
  for (const workflow of status.workflows) {
    if (workflow.task !== task) continue;
    const label = workflow.label ?? workflow.name;
    options.push({ value: workflow.name, label: workflow.ready ? label : `${label} (no weights)` });
  }
  for (const model of status.models ?? []) {
    options.push({ value: model, label: model });
  }
  return options;
}

/** One line for the status strip: what the backend is and why it cannot run, if it cannot. */
export function statusLine(status: GenerativeStatusResult | null): string {
  if (!status) return "checking the backend…";
  if (status.ready && status.stub) return "stub backend: runs return a blurred stand-in";
  if (status.ready) return "ComfyUI is running";
  const message = status.message ?? "the backend is not ready";
  if (!status.hint) return message;
  return `${message} — ${status.hint}`;
}

/**
 * The seed readout reuses the Edit column's `ValueField`, which wants a param spec. The
 * engine describes `seed` as an ordinary integer slider, but a 0–999999 track is not a
 * control anyone would drag, so the column draws the readout alone against this spec.
 */
export const seedSpec: OpParamSpec = {
  name: "seed",
  label: "Seed",
  type: "integer",
  min: 0,
  max: 999999,
  step: 1,
  default: 0,
};

/** A fresh seed for the dice, inside the range the engine's `seed` param accepts. */
export function rollSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 1_000_000);
}

export function numberParam(op: Op | undefined, name: string, fallback: number): number {
  const value = op?.params[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

export function textParam(op: Op | undefined, name: string): string {
  const value = op?.params[name];
  if (typeof value !== "string") return "";
  return value;
}

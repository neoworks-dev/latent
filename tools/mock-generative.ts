// Generative ops for the mock engine (PROMPT.md 3.5). The real thing renders a crop, hands
// it to ComfyUI and composites the answer back; this fakes the job and tints the crop, so
// the UI's whole round trip — add the op, run it, watch job.progress, see `result` and
// `stale` come back on the stack — works without a GPU, a model or a server.
//
// Everything here is pure except `startRun`, which owns the timers.
import type { GenerativeStatusResult, Op, OpDefinition, OpParamSpec } from "@latent/protocol";

const generativeNames = ["generative_fill", "remove"] as const;

export function isGenerativeOp(name: string): boolean {
  return generativeNames.some((entry) => entry === name);
}

function text(name: string, label: string, fallback = ""): OpParamSpec {
  return { name, label, type: "string", default: fallback, display: { kind: "text" } };
}

function seed(): OpParamSpec {
  return {
    name: "seed",
    label: "Seed",
    type: "integer",
    min: 0,
    max: 999999,
    step: 1,
    default: 0,
    display: { kind: "slider" },
  };
}

function backend(): OpParamSpec {
  return {
    name: "backend",
    label: "Backend",
    type: "enum",
    default: "auto",
    values: ["auto", "comfy", "stub"],
  };
}

/** What `ops.describe` adds for the Generative section, matching engine/src/ops/registry.cpp. */
export const generativeDefinitions: OpDefinition[] = [
  {
    name: "generative_fill",
    panel: "generative",
    section: "Generative",
    order: 1,
    label: "Generative Fill",
    maskable: true,
    params: [text("prompt", "Prompt"), text("model", "Model"), seed(), backend()],
  },
  {
    name: "remove",
    panel: "generative",
    section: "Generative",
    order: 2,
    label: "Remove",
    maskable: true,
    params: [text("model", "Model"), seed(), backend()],
  },
];

/**
 * `generative.status`. The mock has no ComfyUI, and saying so is the point: the UI's
 * "not ready" path is what a user hits first on a fresh machine.
 */
export function generativeStatus(): GenerativeStatusResult {
  return {
    backend: "stub",
    backends: ["comfy", "stub"],
    stub: true,
    ready: true,
    message: "mock engine: runs return a tinted stand-in",
    comfy: { installed: false, serverRunning: false },
    models: ["mock-inpaint.safetensors"],
    workflows: [
      { name: "inpaint-sdxl", task: "fill", label: "SDXL inpaint", ready: true },
      {
        name: "inpaint-flux-fill",
        task: "fill",
        label: "Flux.1 Fill Dev",
        ready: false,
        requires: ["flux1-fill-dev.safetensors"],
      },
      { name: "remove", task: "remove", label: "SDXL remove", ready: true },
    ],
  };
}

/** The rect a run "cropped", derived from the op's mask the way the engine derives it. */
export function resultRect(op: Op): [number, number, number, number] {
  const padding = 0.06;
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const component of op.mask?.components ?? []) {
    const box = boxOf(component.kind, component.params ?? {});
    x0 = Math.min(x0, box[0]);
    y0 = Math.min(y0, box[1]);
    x1 = Math.max(x1, box[2]);
    y1 = Math.max(y1, box[3]);
  }
  if (x1 <= x0 || y1 <= y0) return [0.25, 0.25, 0.75, 0.75];
  return [
    Math.max(0, x0 - padding),
    Math.max(0, y0 - padding),
    Math.min(1, x1 + padding),
    Math.min(1, y1 + padding),
  ];
}

function boxOf(kind: string, params: Record<string, unknown>): [number, number, number, number] {
  if (kind === "radial") {
    const center = pair(params.center, [0.5, 0.5]);
    const radius = pair(params.radius, [0.25, 0.25]);
    return [
      center[0] - radius[0],
      center[1] - radius[1],
      center[0] + radius[0],
      center[1] + radius[1],
    ];
  }
  if (kind === "objects" || kind === "text") {
    const box = params.box;
    if (Array.isArray(box) && box.length === 4) {
      return [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])];
    }
  }
  return [0.25, 0.25, 0.75, 0.75];
}

function pair(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  return [Number(value[0]), Number(value[1])];
}

/**
 * The engine hashes the ops that produced the crop, the mask and the params (PROMPT.md
 * 3.5). The mock hashes the same things with a cheap string digest — `stale` has to mean
 * the same thing here, or the badge in the UI would be untestable.
 */
export function inputHash(stack: Op[], opId: string): string {
  const below: unknown[] = [];
  const op = stack.find((entry) => entry.id === opId);
  for (const entry of stack) {
    if (entry.id === opId || !entry.enabled) continue;
    // Tone, colour and effects ops render above the composite, so they are not the input.
    if (!rendersBelowComposite(entry.op)) continue;
    below.push({ op: entry.op, params: entry.params });
  }
  return digest(JSON.stringify([below, op?.mask ?? null, op?.params ?? {}]));
}

/**
 * Which ops the composite sits on top of. The engine decides this by pipeline stage; the
 * mock has no stages, so the three families that render below it are named.
 */
function rendersBelowComposite(name: string): boolean {
  const below = [
    "crop",
    "rotate",
    "flip",
    "transform",
    "lens_correction",
    "chromatic_aberration",
    "defringe",
    "noise_reduction",
    "color_noise_reduction",
  ];
  return below.includes(name) || isGenerativeOp(name);
}

function digest(text_: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text_.length; index++) {
    hash = Math.imul(hash ^ text_.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function isStale(stack: Op[], op: Op): boolean {
  if (!isGenerativeOp(op.op) || !op.result) return false;
  if (typeof op.inputHash !== "string" || op.inputHash === "") return false;
  return inputHash(stack, op.id) !== op.inputHash;
}

/** `stale` is derived, so the mock adds it on the way out exactly as the engine does. */
export function annotateStale(stack: Op[]): Op[] {
  return stack.map((op) => {
    if (!isGenerativeOp(op.op) || !op.result) return op;
    return { ...op, stale: isStale(stack, op) };
  });
}

export interface GenerativeRun {
  /** Progress ticks, then the op fields the engine would have written. */
  jobId: number;
  result: string;
  inputHash: string;
  resultRect: [number, number, number, number];
}

/**
 * What the frame renderer paints over the result rect of a finished op: a seed-derived
 * tint, so two runs of the same op are visibly two runs, the way the engine's stub backend
 * makes them.
 */
export function resultTint(op: Op): [number, number, number] {
  const seedValue = typeof op.params.seed === "number" ? op.params.seed : 0;
  const angle = ((seedValue % 360) * Math.PI) / 180;
  return [
    0.5 + 0.5 * Math.cos(angle),
    0.5 + 0.5 * Math.cos(angle - 2.094),
    0.5 + 0.5 * Math.cos(angle + 2.094),
  ];
}

/** Whether a pixel is inside a finished op's result rect — the mock's whole composite. */
export function insideResult(op: Op, u: number, v: number): boolean {
  const rect = op.resultRect;
  if (!op.result || !Array.isArray(rect) || rect.length !== 4) return false;
  return u >= rect[0] && u < rect[2] && v >= rect[1] && v < rect[3];
}

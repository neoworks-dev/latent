import { describe, expect, test } from "bun:test";
import type { GenerativeStatusResult, Op } from "@latent/protocol";
import {
  canRun,
  DENOISE_INPUT_SIZE,
  graphReady,
  isDenoiseOp,
  LOCAL_DENOISE_INPUT_SIZE,
  LOCAL_DENOISE_MODEL,
  localDenoiseReady,
  MANUAL_DENOISE_OP,
  manualSpecs,
  manualValue,
  missingGraphMessage,
  resolutionNote,
  strengthSpec,
} from "../src/denoise";

function op(params: Record<string, unknown> = {}): Op {
  return { id: "op1", op: "denoise", params, enabled: true };
}

const ready: GenerativeStatusResult = {
  backend: "comfy",
  ready: true,
  comfy: { installed: true, serverRunning: true },
  models: ["RealVisXL_V5.0_fp16.safetensors"],
  workflows: [
    { name: "denoise", task: "denoise", label: "SDXL img2img denoise", ready: true },
    { name: "upscale", task: "upscale", label: "ESRGAN 4x", ready: true },
  ],
};

describe("the ops the column speaks for", () => {
  test("only `denoise`", () => {
    expect(isDenoiseOp("denoise")).toBe(true);
    expect(isDenoiseOp("generative_fill")).toBe(false);
    expect(isDenoiseOp("noise_reduction")).toBe(false);
  });
});

describe("running", () => {
  test("needs an op and a backend, but never a mask", () => {
    expect(canRun(undefined, ready)).toBe(false);
    expect(canRun(op(), ready)).toBe(true);
    // Readiness is per provider, not ComfyUI's global flag: what stops a run is having no
    // denoise provider at all, model or graph.
    expect(canRun(op(), { ...ready, workflows: [] })).toBe(false);
    // Before the first status answers, the button is live: the engine is the one that
    // decides, and a column that greys out on a null status never comes back.
    expect(canRun(op(), null)).toBe(true);
  });
});

describe("the graph behind the op", () => {
  test("ready when its weights are there", () => {
    expect(graphReady(ready)).toBe(true);
    expect(missingGraphMessage(ready)).toBe("");
  });

  test("names what is missing when they are not", () => {
    const missing: GenerativeStatusResult = {
      ...ready,
      workflows: [
        {
          name: "denoise",
          task: "denoise",
          label: "SDXL img2img denoise",
          ready: false,
          requires: ["RealVisXL_V5.0_fp16.safetensors"],
        },
      ],
    };
    expect(graphReady(missing)).toBe(false);
    expect(missingGraphMessage(missing)).toBe(
      "SDXL img2img denoise needs RealVisXL_V5.0_fp16.safetensors.",
    );
  });

  test("the stub needs nothing installed", () => {
    expect(graphReady({ ...ready, stub: true, workflows: [] })).toBe(true);
  });

  test("says so when no graph serves the task at all", () => {
    expect(missingGraphMessage({ ...ready, workflows: [] })).toBe(
      "No denoise graph is installed — check engine/workflows/.",
    );
  });
});

describe("what the column tells the user", () => {
  test("the strength slider is the engine's 0..100", () => {
    expect(strengthSpec.min).toBe(0);
    expect(strengthSpec.max).toBe(100);
    expect(strengthSpec.default).toBe(50);
  });

  test("the resolution note names the size whoever runs it really sees", () => {
    expect(resolutionNote(ready)).toContain(String(DENOISE_INPUT_SIZE));
    const local: GenerativeStatusResult = {
      ...ready,
      workflows: [
        ...ready.workflows,
        { name: LOCAL_DENOISE_MODEL, task: "denoise", label: "SCUNet, local", ready: true },
      ],
    };
    expect(localDenoiseReady(local)).toBe(true);
    expect(resolutionNote(local)).toContain(String(LOCAL_DENOISE_INPUT_SIZE));
  });

  test("the local model alone is enough to run: ComfyUI need not be up", () => {
    const offline: GenerativeStatusResult = {
      ...ready,
      ready: false,
      comfy: { installed: true, serverRunning: false },
      workflows: [
        { name: "denoise", task: "denoise", label: "SDXL img2img denoise", ready: false },
        { name: LOCAL_DENOISE_MODEL, task: "denoise", label: "SCUNet, local", ready: true },
      ],
    };
    expect(canRun(op(), offline)).toBe(true);
    expect(missingGraphMessage(offline)).toBe("");
  });
});

describe("the manual filter beside it", () => {
  test("four sliders, both amounts neutral by default", () => {
    expect(manualSpecs.map((spec) => spec.name)).toEqual([
      "luminance",
      "detail",
      "color",
      "colorDetail",
    ]);
    const amounts = manualSpecs.filter((spec) => spec.name === "luminance" || spec.name === "color");
    expect(amounts.map((spec) => spec.default)).toEqual([0, 0]);
  });

  test("a slider shows the op's value, or the spec's default when the op has none", () => {
    const [luminance, detail] = manualSpecs;
    if (!luminance || !detail) throw new Error("the manual specs are the four the column draws");
    const manual: Op = { id: "op2", op: MANUAL_DENOISE_OP, params: { luminance: 65 }, enabled: true };
    expect(manualValue(manual, luminance)).toBe(65);
    expect(manualValue(manual, detail)).toBe(50);
    expect(manualValue(undefined, luminance)).toBe(0);
  });

  test("the manual op is not the AI one", () => {
    expect(isDenoiseOp(MANUAL_DENOISE_OP)).toBe(false);
  });
});

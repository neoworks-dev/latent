import { describe, expect, test } from "bun:test";
import type { GenerativeStatusResult, Op } from "@latent/protocol";
import {
  canRun,
  factorNumber,
  factorOf,
  factors,
  graphReady,
  isUpscaleOp,
  missingGraphMessage,
  sizeNote,
} from "../src/upscale";

function op(params: Record<string, unknown> = {}): Op {
  return { id: "op1", op: "upscale", params, enabled: true };
}

const ready: GenerativeStatusResult = {
  backend: "comfy",
  ready: true,
  comfy: { installed: true, serverRunning: true },
  models: ["RealVisXL_V5.0_fp16.safetensors"],
  workflows: [{ name: "upscale", task: "upscale", label: "ESRGAN 4x", ready: true }],
};

describe("the ops the column speaks for", () => {
  test("only `upscale`", () => {
    expect(isUpscaleOp("upscale")).toBe(true);
    expect(isUpscaleOp("denoise")).toBe(false);
  });
});

describe("the factor", () => {
  test("2x unless the op says 4x", () => {
    expect(factorOf(undefined)).toBe("2x");
    expect(factorOf(op())).toBe("2x");
    expect(factorOf(op({ factor: "4x" }))).toBe("4x");
    // The engine's enum is the only source of legal values; anything else reads as the
    // first one rather than being passed through to a graph that cannot use it.
    expect(factorOf(op({ factor: "8x" }))).toBe("2x");
  });

  test("is a number when it has to be one", () => {
    expect(factorNumber("2x")).toBe(2);
    expect(factorNumber("4x")).toBe(4);
    expect(factors).toEqual(["2x", "4x"]);
  });

  test("the size note states what an export comes out at", () => {
    expect(sizeNote(op({ factor: "4x" }))).toContain("4×");
    expect(sizeNote(op())).toContain("2×");
  });
});

describe("running", () => {
  test("needs an op and a backend, but never a mask", () => {
    expect(canRun(undefined, ready)).toBe(false);
    expect(canRun(op(), ready)).toBe(true);
    expect(canRun(op(), { ...ready, ready: false })).toBe(false);
    expect(canRun(op(), null)).toBe(true);
  });
});

describe("the graph behind the op", () => {
  test("ready when its weights are there", () => {
    expect(graphReady(ready)).toBe(true);
    expect(missingGraphMessage(ready)).toBe("");
  });

  test("names the upscale model when it is missing", () => {
    const missing: GenerativeStatusResult = {
      ...ready,
      workflows: [
        {
          name: "upscale",
          task: "upscale",
          label: "ESRGAN 4x",
          ready: false,
          requires: ["4x-UltraSharp.pth"],
        },
      ],
    };
    expect(graphReady(missing)).toBe(false);
    expect(missingGraphMessage(missing)).toBe("ESRGAN 4x needs 4x-UltraSharp.pth.");
  });

  test("a denoise graph is not an upscale graph", () => {
    const other: GenerativeStatusResult = {
      ...ready,
      workflows: [{ name: "denoise", task: "denoise", label: "SDXL denoise", ready: true }],
    };
    expect(graphReady(other)).toBe(false);
  });
});

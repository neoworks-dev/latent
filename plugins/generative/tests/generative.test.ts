import { describe, expect, test } from "bun:test";
import type { GenerativeStatusResult, Op } from "@latent/protocol";
import {
  canRun,
  currentOp,
  failureMessage,
  generativeEntries,
  hasMask,
  isGenerativeOp,
  modelOptions,
  numberParam,
  rollSeed,
  statusLine,
  takesPrompt,
  textParam,
} from "../src/generative";

function op(id: string, name: string, params: Record<string, unknown> = {}): Op {
  return { id, op: name, params, enabled: true };
}

function masked(id: string, name: string): Op {
  return {
    ...op(id, name),
    mask: { components: [{ id: "m1", kind: "radial", mode: "add" }] },
  };
}

const ready: GenerativeStatusResult = {
  backend: "comfy",
  ready: true,
  comfy: { installed: true, serverRunning: true },
  models: ["RealVisXL_V5.0_fp16.safetensors"],
  workflows: [
    { name: "inpaint-sdxl", task: "fill", label: "SDXL inpaint", ready: true },
    { name: "inpaint-flux-fill", task: "fill", label: "Flux.1 Fill Dev", ready: false },
    { name: "remove", task: "remove", label: "SDXL remove", ready: true },
  ],
};

describe("which ops are generative", () => {
  test("only the two the engine registers", () => {
    expect(isGenerativeOp("generative_fill")).toBe(true);
    expect(isGenerativeOp("remove")).toBe(true);
    expect(isGenerativeOp("exposure")).toBe(false);
  });

  test("only a fill takes a prompt", () => {
    expect(takesPrompt("generative_fill")).toBe(true);
    expect(takesPrompt("remove")).toBe(false);
  });

  test("the entries are the generative ones, in stack order", () => {
    const stack = [op("a", "exposure"), op("b", "generative_fill"), op("c", "remove")];
    expect(generativeEntries(stack).map((entry) => entry.id)).toEqual(["b", "c"]);
  });
});

describe("the op the column is pointed at", () => {
  const stack = [op("a", "exposure"), op("b", "generative_fill"), op("c", "remove")];

  test("the selection when it is generative", () => {
    expect(currentOp(stack, "b")?.id).toBe("b");
  });

  test("the last generative op when the selection is not one", () => {
    expect(currentOp(stack, "a")?.id).toBe("c");
    expect(currentOp(stack, null)?.id).toBe("c");
  });

  test("nothing when the stack has none", () => {
    expect(currentOp([op("a", "exposure")], null)).toBeUndefined();
  });
});

describe("when a run is possible", () => {
  test("a mask is the region, so an op without one cannot run", () => {
    expect(hasMask(op("b", "generative_fill"))).toBe(false);
    expect(canRun(op("b", "generative_fill"), ready)).toBe(false);
    expect(canRun(masked("b", "generative_fill"), ready)).toBe(true);
  });

  test("a backend that is not ready stops it too", () => {
    const down: GenerativeStatusResult = {
      ...ready,
      ready: false,
      comfy: { installed: true, serverRunning: false },
    };
    expect(canRun(masked("b", "generative_fill"), down)).toBe(false);
  });

  test("an unknown status is not a refusal: the engine decides", () => {
    expect(canRun(masked("b", "generative_fill"), null)).toBe(true);
  });
});

describe("what a failure means", () => {
  test("a CLI code becomes a sentence with something to do", () => {
    expect(failureMessage("server_not_running")).toContain("comfy launch");
    expect(failureMessage("comfy_not_installed")).toContain("comfy-cli");
    expect(failureMessage("execution_error")).toContain("comfy logs");
  });

  test("anything else is passed through as the engine wrote it", () => {
    expect(failureMessage("the mask is empty")).toBe("the mask is empty");
  });
});

describe("the status strip", () => {
  test("says what is wrong and what to do about it", () => {
    const line = statusLine({
      ...ready,
      ready: false,
      message: "ComfyUI is not running",
      hint: "run `comfy launch`",
    });
    expect(line).toBe("ComfyUI is not running — run `comfy launch`");
  });

  test("says when the stub is answering, so a screenshot is not mistaken for a real run", () => {
    expect(statusLine({ ...ready, stub: true })).toContain("stub");
  });

  test("says nothing definite before the first answer", () => {
    expect(statusLine(null)).toContain("checking");
  });
});

describe("the model dropdown", () => {
  test("offers the graphs for this task, then the installed weights", () => {
    const options = modelOptions(ready, "generative_fill");
    expect(options[0]?.value).toBe("");
    expect(options.map((entry) => entry.value)).toEqual([
      "",
      "inpaint-sdxl",
      "inpaint-flux-fill",
      "RealVisXL_V5.0_fp16.safetensors",
    ]);
    // A graph whose weights are missing is offered and labelled, not hidden: that is how a
    // user finds out what to download.
    expect(options[2]?.label).toContain("no weights");
  });

  test("a remove op is offered the remove graph", () => {
    expect(modelOptions(ready, "remove").map((entry) => entry.value)).toContain("remove");
    expect(modelOptions(ready, "remove").map((entry) => entry.value)).not.toContain("inpaint-sdxl");
  });

  test("without a status there is only the graph's own default", () => {
    expect(modelOptions(null, "generative_fill")).toHaveLength(1);
  });
});

describe("params", () => {
  test("a seed roll stays inside the engine's range", () => {
    expect(rollSeed(() => 0)).toBe(0);
    expect(rollSeed(() => 0.999999)).toBeLessThan(1_000_000);
  });

  test("a missing or wrongly typed param falls back", () => {
    const entry = op("b", "generative_fill", { seed: 12, prompt: "a hat", model: 7 });
    expect(numberParam(entry, "seed", 0)).toBe(12);
    expect(numberParam(entry, "missing", 3)).toBe(3);
    expect(numberParam(undefined, "seed", 5)).toBe(5);
    expect(textParam(entry, "prompt")).toBe("a hat");
    expect(textParam(entry, "model")).toBe("");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { methods, notifications } from "../src/methods";

interface Definition {
  description?: string;
  required?: string[];
  properties?: Record<string, { enum?: string[]; default?: unknown; description?: string }>;
}

interface SchemaFile {
  definitions: Record<string, Definition> & {
    MethodName: { enum: string[] };
    NotificationName: { enum: string[] };
  };
}

const schemaPath = join(import.meta.dir, "..", "..", "..", "protocol", "messages.schema.json");
const schema: SchemaFile = JSON.parse(readFileSync(schemaPath, "utf8"));

function pascal(method: string): string {
  return method
    .split(".")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("");
}

describe("protocol schema", () => {
  test("every request method in the TS table is in the schema enum", () => {
    for (const method of methods) expect(schema.definitions.MethodName.enum).toContain(method);
  });

  test("every request method has Params and Result definitions", () => {
    for (const method of methods) {
      expect(schema.definitions).toHaveProperty(`${pascal(method)}Params`);
      expect(schema.definitions).toHaveProperty(`${pascal(method)}Result`);
    }
  });

  test("every notification in the enum has a Params definition", () => {
    const fromEnum = schema.definitions.MethodName.enum.filter((m) => !methods.includes(m as never));
    for (const method of fromEnum) {
      expect(schema.definitions).toHaveProperty(`${pascal(method)}Params`);
    }
  });

  test("the TS notification table is exactly the schema's NotificationName enum", () => {
    expect([...schema.definitions.NotificationName.enum].sort()).toEqual([...notifications].sort());
  });

  test("the MethodName enum is the requests plus the notifications, nothing else", () => {
    expect([...schema.definitions.MethodName.enum].sort()).toEqual(
      [...methods, ...notifications].sort(),
    );
  });
});

/**
 * The engine is built against the schema, so a field that used to be optional must stay
 * optional and a documented default must stay put. These pin the additions of batch v3.
 */
describe("additive guarantees", () => {
  function definition(name: string): Definition {
    const found = schema.definitions[name];
    if (!found) throw new Error(`no definition ${name}`);
    return found;
  }

  test("v3 params and results only added optional fields", () => {
    expect(definition("CatalogListParams").required).toBeUndefined();
    expect(definition("PythonRunParams").required).toEqual(["code"]);
    expect(definition("CatalogImportParams").required).toEqual(["paths"]);
    expect(definition("PythonRunResult").required).not.toContain("runId");
    expect(definition("PhotoOpenResult").required).not.toContain("catalog");
    expect(definition("JobProgressParams").required).not.toContain("state");
  });

  test("the documented defaults live in the schema, not only in prose", () => {
    expect(definition("CatalogImportParams").properties?.recursive?.default).toBe(true);
    expect(definition("PythonRunParams").properties?.timeoutMs?.default).toBe(30000);
    expect(definition("CatalogThumbnailsParams").properties?.size?.default).toBe(256);
  });

  test("a cancelled job and a removed row have names on the wire", () => {
    expect(definition("JobProgressParams").properties?.state?.enum).toContain("cancelled");
    expect(definition("CatalogChangedParams").properties?.reason?.enum).toContain("remove");
    expect(definition("PythonOutputParams").properties?.stream?.enum).toEqual(["stdout", "stderr"]);
  });

  test("v4 only added optional params and fields a client reads", () => {
    // Results gain required fields — the engine fills them — but nothing a *caller* sends
    // became mandatory, so every v3 request still validates.
    expect(definition("CatalogImportResult").required).toEqual(["jobId"]);
    expect(definition("JobProgressParams").required).not.toContain("parentJobId");
    expect(definition("StackChangedParams").required).toBeUndefined();
    expect(definition("CatalogPhoto").required).not.toContain("hash");
    expect(definition("OpDefinition").required).toEqual(["name", "panel", "label", "params"]);
    expect(definition("OpParamSpec").required).toEqual(["name", "type", "default"]);
  });

  test("the u32 photo id cap is written down where PhotoId is defined", () => {
    expect(definition("PhotoId").description).toContain("4294967295");
    expect(definition("CatalogThumbnailParams").description).toContain("4294967295");
    expect(definition("CatalogThumbnailsParams").description).toContain("4294967295");
  });

  test("a finished run is announced before its result", () => {
    expect(definition("PythonFinishedParams").required).toEqual(["runId", "durationMs", "ok"]);
    // Optional on the result, required on the notification: a console that only listens
    // for python.finished always has the number, and an older client still typechecks.
    expect(definition("PythonRunResult").required).not.toContain("durationMs");
    expect(definition("PythonRunResult").properties?.durationMs?.description).toContain(
      "always send it",
    );
    expect(definition("PythonFinishedParams").description).toContain("before the RPC result");
  });

  test("ops.describe carries panel layout hints", () => {
    expect(definition("OpParamDisplay").properties?.kind?.enum).toEqual([
      "slider",
      "kelvin",
      "curve",
      "hsl",
      "toggle",
      // A generative prompt is free text: no generated control holds one.
      "text",
    ]);
    expect(definition("OpParamDisplay").properties?.tint?.enum).toEqual([
      "temperature",
      "tint",
      "hue",
      "saturation",
    ]);
    expect(definition("OpDefinition").properties?.section?.enum).toEqual([
      "Light",
      "Color",
      "Effects",
      "Detail",
      "Optics",
      "Geometry",
      "Generative",
    ]);
  });

  test("engine.hello names the catalog it opened; the MCP url is optional", () => {
    expect(definition("EngineHelloResult").required).toContain("catalogPath");
    expect(definition("EngineHelloResult").required).not.toContain("mcpUrl");
  });

  test("view.render reports the revision it rendered", () => {
    expect(definition("ViewRenderResult").required).toContain("revision");
  });

  test("the letterboxed image rect is optional on both calls that send a frame", () => {
    // Additive, so an engine built before the field still satisfies the schema and a UI
    // falls back to fitting the frame's own aspect.
    for (const name of ["ViewRenderResult", "MaskPreviewResult"]) {
      expect(definition(name).required).not.toContain("contentRect");
      expect(definition(name).properties).toHaveProperty("contentRect");
    }
  });

  test("the batch thumbnail result reports what it could not send", () => {
    expect(definition("CatalogThumbnailsResult").required).toEqual([
      "requested",
      "sent",
      "missing",
    ]);
    expect(definition("CatalogRemoveResult").required).toEqual(["removed"]);
    expect(definition("JobCancelResult").required).toEqual(["cancelled"]);
  });
});

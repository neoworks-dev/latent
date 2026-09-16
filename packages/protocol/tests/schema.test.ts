import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "../src/methods";

interface SchemaFile {
  definitions: Record<string, unknown> & { MethodName: { enum: string[] } };
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
    const notifications = schema.definitions.MethodName.enum.filter((m) => !methods.includes(m as never));
    for (const method of notifications) {
      expect(schema.definitions).toHaveProperty(`${pascal(method)}Params`);
    }
  });
});

// Generates src/generated.ts from protocol/messages.schema.json. Run `bun run generate`
// in this package after any schema change; the typecheck fails when the two drift.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "..", "..", "protocol", "messages.schema.json");
const outputPath = join(here, "..", "src", "generated.ts");

const banner = `// GENERATED from protocol/messages.schema.json by packages/protocol/scripts/generate.ts.
// Do not edit. Change the schema and run \`bun run generate\`.
`;

type ProtocolSchema = JSONSchema & { definitions: Record<string, JSONSchema> };

const schema: ProtocolSchema = JSON.parse(await readFile(schemaPath, "utf8"));

// The compiler only emits definitions reachable from the root, so the root is given one
// optional property per definition. The resulting `LatentProtocol` interface is unused.
const properties: Record<string, JSONSchema> = {};
for (const name of Object.keys(schema.definitions)) {
  properties[name] = { $ref: `#/definitions/${name}` };
}
schema.properties = properties;

const types = await compile(schema, "LatentProtocol", {
  bannerComment: banner,
  additionalProperties: false,
  strictIndexSignatures: true,
  style: { printWidth: 100, singleQuote: false, semi: true },
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, types);
console.log(`wrote ${outputPath}`);

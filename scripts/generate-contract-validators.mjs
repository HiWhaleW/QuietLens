import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";

import { CONTRACT_SCHEMAS } from "../src/ai-native/contracts/schemas.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "src", "ai-native", "contracts", "generatedValidators.js");
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  code: { source: true, esm: true },
});
for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
  ajv.addSchema(schema, name);
}
const validators = Object.fromEntries(
  Object.keys(CONTRACT_SCHEMAS).map((name) => [name, name]),
);

const source = `${standaloneCode(ajv, validators)}`
  .replace(
    "\"use strict\";",
    "import ucs2LengthRuntime from \"ajv/dist/runtime/ucs2length.js\";import equalRuntime from \"ajv/dist/runtime/equal.js\";const ucs2Length=typeof ucs2LengthRuntime===\"function\"?ucs2LengthRuntime:ucs2LengthRuntime.default;const equal=typeof equalRuntime===\"function\"?equalRuntime:equalRuntime.default;",
  )
  .replaceAll("require(\"ajv/dist/runtime/ucs2length\").default", "ucs2Length")
  .replaceAll("require(\"ajv/dist/runtime/equal\").default", "equal")
  .concat("\n");
await writeFile(outputPath, source, "utf8");
console.log(`Generated static contract validators: ${path.relative(root, outputPath)}`);

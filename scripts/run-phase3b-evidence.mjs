import { readFile } from "node:fs/promises";

import { validateEvidenceStore } from "../src/ai-native/evidence/validateStore.js";

const evidenceRoot = new URL("../docs/phase-3b/evidence/v0.1/", import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, evidenceRoot), "utf8"));
}

const [manifest, places, sources, evidence] = await Promise.all([
  readJson("manifest.json"),
  readJson("places.json"),
  readJson("sources.json"),
  readJson("evidence.json"),
]);
const result = validateEvidenceStore({ manifest, places, sources, evidence });

console.log(JSON.stringify(result.metrics, null, 2));
if (!result.valid) {
  console.error(JSON.stringify(result.issues, null, 2));
  process.exitCode = 1;
}

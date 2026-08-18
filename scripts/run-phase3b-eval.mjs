import { readFile } from "node:fs/promises";

import { runNoModelBaseline } from "../src/ai-native/evaluation/runBaseline.js";

const evidenceRoot = new URL("../docs/phase-3b/evidence/v0.1/", import.meta.url);
const evaluationRoot = new URL("../docs/phase-3b/evaluation/v0.1/", import.meta.url);

async function readJson(name, root) {
  return JSON.parse(await readFile(new URL(name, root), "utf8"));
}

const [manifest, places, sources, evidence, evaluationManifest, casesText] = await Promise.all([
  readJson("manifest.json", evidenceRoot),
  readJson("places.json", evidenceRoot),
  readJson("sources.json", evidenceRoot),
  readJson("evidence.json", evidenceRoot),
  readJson("manifest.json", evaluationRoot),
  readFile(new URL("cases.jsonl", evaluationRoot), "utf8"),
]);

const result = runNoModelBaseline(
  {
    manifest: evaluationManifest,
    cases: casesText.trim().split("\n").map((line) => JSON.parse(line)),
  },
  { manifest, places, sources, evidence },
);

console.log(JSON.stringify(result.metrics, null, 2));
if (!result.valid) {
  console.error(JSON.stringify(result.issues, null, 2));
  process.exitCode = 1;
}

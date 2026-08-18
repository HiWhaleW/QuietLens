import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEvidencePipelineBaseline } from "../src/ai-native/evidence/pipelineRegistry.js";
import { assertCandidatePipeline } from "../src/ai-native/evidence/validateCandidatePipeline.js";
import { assertEvidencePipelineState } from "../src/ai-native/evidence/validatePipelineState.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(root, "docs/phase-3b/evidence/v0.1");
const outputRoot = path.join(root, "docs/stage-2/evidence-pipeline/v1.0");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const evidenceStore = {
  manifest: await readJson(path.join(evidenceRoot, "manifest.json")),
  places: await readJson(path.join(evidenceRoot, "places.json")),
  sources: await readJson(path.join(evidenceRoot, "sources.json")),
  evidence: await readJson(path.join(evidenceRoot, "evidence.json")),
};

const state = buildEvidencePipelineBaseline(evidenceStore);
const validation = assertEvidencePipelineState(state, evidenceStore);
const candidateState = {
  candidates: [],
  deduplication_clusters: [],
  conflict_queue: [],
};
const candidateValidation = assertCandidatePipeline(candidateState, state, evidenceStore);

await fs.mkdir(outputRoot, { recursive: true });
for (const [name, value] of [
  ["manifest.json", state.manifest],
  ["source-registry.json", state.registry],
  ["access-plans.json", state.access_plans],
  ["collection-runs.json", state.runs],
  ["raw-snapshots.json", state.snapshots],
  ["candidate-evidence.json", candidateState.candidates],
  ["deduplication-clusters.json", candidateState.deduplication_clusters],
  ["conflict-queue.json", candidateState.conflict_queue],
]) {
  await fs.writeFile(path.join(outputRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({
  ...validation.metrics,
  ...candidateValidation.metrics,
}, null, 2)}\n`);

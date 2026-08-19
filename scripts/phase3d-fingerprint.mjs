import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE_3D_FINGERPRINT_FILES = Object.freeze([
  "package.json",
  "worker/ai/prompts.js",
  "worker/ai/deepseekResponsesClient.js",
  "worker/ai/intentInterpreter.js",
  "worker/ai/decisionReasoner.js",
  "worker/services/decisionService.js",
  "src/ai-native/contracts/schemas.js",
  "src/ai-native/decision/verifyAndRender.js",
  "src/ai-native/decision/confidence.js",
  "src/ai-native/evidence/hardConstraintFilter.js",
  "src/ai-native/evidence/retrieveEvidence.js",
  "src/ai-native/evidence/validateStore.js",
  "src/ai-native/intent/inputPreprocessor.js",
  "src/ai-native/evaluation/runPhase3C.js",
  "tests/ai-phase3d.test.mjs",
  "docs/phase-3b/evidence/v0.1/manifest.json",
  "docs/phase-3b/evidence/v0.1/places.json",
  "docs/phase-3b/evidence/v0.1/sources.json",
  "docs/phase-3b/evidence/v0.1/evidence.json",
  "docs/phase-3b/evaluation/v0.1/manifest.json",
  "docs/phase-3b/evaluation/v0.1/cases.jsonl",
]);

export async function buildPhase3DFingerprint() {
  const root = new URL("../", import.meta.url);
  const hash = createHash("sha256");
  for (const file of PHASE_3D_FINGERPRINT_FILES) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(new URL(file, root)));
    hash.update("\0");
  }
  return {
    algorithm: "sha256",
    digest: hash.digest("hex"),
    files: [...PHASE_3D_FINGERPRINT_FILES],
  };
}

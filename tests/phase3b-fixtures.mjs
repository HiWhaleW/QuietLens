import { readFile } from "node:fs/promises";

const evidenceRoot = new URL("../docs/phase-3b/evidence/v0.1/", import.meta.url);
const evaluationRoot = new URL("../docs/phase-3b/evaluation/v0.1/", import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, evidenceRoot), "utf8"));
}

export async function loadEvidenceStore() {
  const [manifest, places, sources, evidence] = await Promise.all([
    readJson("manifest.json"),
    readJson("places.json"),
    readJson("sources.json"),
    readJson("evidence.json"),
  ]);
  return { manifest, places, sources, evidence };
}

export async function loadEvaluationSet() {
  const [manifestText, casesText] = await Promise.all([
    readFile(new URL("manifest.json", evaluationRoot), "utf8"),
    readFile(new URL("cases.jsonl", evaluationRoot), "utf8"),
  ]);
  return {
    manifest: JSON.parse(manifestText),
    cases: casesText.trim().split("\n").map((line) => JSON.parse(line)),
  };
}

export function makeDecisionRequest(overrides = {}) {
  return {
    schema_version: "1.0.0",
    request_id: "req-test-001",
    evidence_store_version: "0.1.0",
    task: { type: "focus", duration_minutes: 90 },
    time: {
      arrival_at: "2026-08-17T14:00:00+08:00",
      hard_leave_at: null,
      original_phrase: "明天下午两点",
    },
    location: { area: "黄浦区", max_walk_minutes: 12 },
    hard_constraints: [],
    soft_preferences: [],
    unknowns: [],
    assumptions: [],
    confirmed_by_user: true,
    ...overrides,
  };
}

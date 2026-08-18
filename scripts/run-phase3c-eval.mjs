import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  evaluatePhase3CGates,
  evaluatePhase3DGates,
  privacyMinimizePhase3CCase,
  scorePhase3CCase,
  summarizePhase3CRun,
} from "../src/ai-native/evaluation/runPhase3C.js";
import { buildEvaluationRunMetadata } from "../src/ai-native/evaluation/runMetadata.js";
import {
  correctAndRecommend,
  interpretDecisionRequest,
  recommendForDecisionRequest,
} from "../worker/services/decisionService.js";
import { isHeaderSafeApiKey } from "../worker/ai/deepseekResponsesClient.js";
import { buildPhase3DFingerprint } from "./phase3d-fingerprint.mjs";

const evidenceRoot = new URL("../docs/phase-3b/evidence/v0.1/", import.meta.url);
const evaluationRoot = new URL("../docs/phase-3b/evaluation/v0.1/", import.meta.url);
const phase3d = process.argv.includes("--phase3d");
const outputRoot = new URL(phase3d ? "../docs/phase-3d/evaluation-runs/" : "../docs/phase-3c/evaluation-runs/", import.meta.url);
const execFileAsync = promisify(execFile);

async function readJson(name, root) {
  return JSON.parse(await readFile(new URL(name, root), "utf8"));
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error(`DEEPSEEK_API_KEY is required for the live Phase ${phase3d ? "3D" : "3C"} evaluation; no synthetic pass result was generated.`);
  process.exit(2);
}
if (!isHeaderSafeApiKey(process.env.DEEPSEEK_API_KEY)) {
  console.error("DEEPSEEK_API_KEY is not a valid HTTP header value; no evaluation result was generated.");
  process.exit(2);
}

const [manifest, places, sources, evidence, evaluationManifest, casesText] = await Promise.all([
  readJson("manifest.json", evidenceRoot),
  readJson("places.json", evidenceRoot),
  readJson("sources.json", evidenceRoot),
  readJson("evidence.json", evidenceRoot),
  readJson("manifest.json", evaluationRoot),
  readFile(new URL("cases.jsonl", evaluationRoot), "utf8"),
]);
const allCases = casesText.trim().split("\n").map((line) => JSON.parse(line));
const caseArgumentIndex = process.argv.indexOf("--case");
const selectedCaseId = caseArgumentIndex >= 0 ? process.argv[caseArgumentIndex + 1] : null;
const highRiskOnly = !process.argv.includes("--all") && !selectedCaseId;
const selectedCases = selectedCaseId
  ? allCases.filter((item) => item.case_id === selectedCaseId)
  : highRiskOnly
    ? allCases.filter((item) => evaluationManifest.high_risk_case_ids.includes(item.case_id))
    : allCases;
if (selectedCases.length === 0) {
  console.error(`Evaluation case not found: ${selectedCaseId}`);
  process.exit(2);
}
const [{ stdout: gitCommit }, { stdout: gitBranch }, { stdout: gitStatus }, packageJson] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"]),
  execFileAsync("git", ["branch", "--show-current"]),
  execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"]),
  readJson("../package.json", import.meta.url),
]);
const implementation = buildEvaluationRunMetadata({
  gitCommit: gitCommit.trim(),
  gitBranch: gitBranch.trim(),
  gitStatus,
  packageVersion: packageJson.version,
});
if (implementation.worktree_dirty && !selectedCaseId && !process.argv.includes("--allow-dirty")) {
  console.error(`Phase ${phase3d ? "3D" : "3C"} gate evaluation requires a clean Git worktree; commit the implementation or use --allow-dirty for non-gating diagnostics.`);
  process.exit(2);
}
const events = [];
const env = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  QL_INTENT_MODEL: process.env.QL_INTENT_MODEL ?? "deepseek-v4-flash",
  QL_REASONING_MODEL: process.env.QL_REASONING_MODEL ?? "deepseek-v4-flash",
  QL_INTENT_TIMEOUT_MS: process.env.QL_INTENT_TIMEOUT_MS,
  QL_REASONING_TIMEOUT_MS: process.env.QL_REASONING_TIMEOUT_MS,
  QUIETLENS_EVIDENCE_STORE: { manifest, places, sources, evidence },
  QUIETLENS_ANALYTICS_SINK: { write: async (event) => events.push(event) },
};

async function runCase(evaluationCase) {
  const started = Date.now();
  let errorStage = "intent_initial";
  let completedModelCalls = 0;
  let currentRequest = null;
  let intentRepairCodes = [];
  let correctionStartedAt = null;
  const payload = {
    session_id: `sess-eval-${evaluationCase.case_id.replace("ql-eval-", "")}`,
    request_id: evaluationCase.structured_request.request_id,
    page_context: { area: "黄浦区" },
  };
  const caseEnv = { ...env, QUIETLENS_NOW: () => evaluationCase.now };
  try {
    if (evaluationCase.subset === "safety") {
      await interpretDecisionRequest(caseEnv, { ...payload, mode: "initial", user_text: evaluationCase.messages.at(-1).content });
      const latencyMs = Date.now() - started;
      return {
        request: null,
        error_code: "SAFETY_NOT_BLOCKED",
        latency_ms: latencyMs,
        initial_decision_latency_ms: latencyMs,
        correction_recompute_latency_ms: null,
        model_calls: 0,
      };
    }

    const initial = await interpretDecisionRequest(caseEnv, {
      ...payload,
      mode: "initial",
      user_text: evaluationCase.messages[0].content,
    });
    completedModelCalls = initial.metrics?.model_calls ?? 0;
    currentRequest = initial.request;
    intentRepairCodes = initial.metrics?.repair_codes ?? [];
    if (evaluationCase.subset === "correction") {
      errorStage = "intent_correction_or_reasoning";
      correctionStartedAt = Date.now();
      const corrected = await correctAndRecommend(caseEnv, {
        ...payload,
        current_request: initial.request,
        user_text: evaluationCase.messages.at(-1).content,
        clarification_already_asked: true,
      });
      return {
        ...corrected,
        before_request: initial.request,
        latency_ms: Date.now() - started,
        initial_decision_latency_ms: null,
        correction_recompute_latency_ms: Date.now() - correctionStartedAt,
        model_calls: (initial.metrics?.model_calls ?? 0) + (corrected.metrics?.model_calls ?? 0),
        intent_repair_codes: [
          ...(initial.metrics?.repair_codes ?? []),
          ...(corrected.metrics?.repair_codes ?? []),
        ],
        intent_repair_issues: [
          ...(initial.metrics?.repair_issues ?? []),
          ...(corrected.metrics?.repair_issues ?? []),
        ],
        verification_repair_codes: corrected.metrics?.verification_repair_codes ?? [],
      };
    }
    if (initial.clarification.required) {
      const latencyMs = Date.now() - started;
      return {
        ...initial,
        brief: null,
        context: null,
        latency_ms: latencyMs,
        initial_decision_latency_ms: latencyMs,
        correction_recompute_latency_ms: null,
        model_calls: initial.metrics?.model_calls ?? 1,
        intent_repair_codes: initial.metrics?.repair_codes ?? [],
        intent_repair_issues: initial.metrics?.repair_issues ?? [],
      };
    }
    errorStage = "decision_reasoning";
    const recommended = await recommendForDecisionRequest(caseEnv, { ...payload, request: initial.request });
    const latencyMs = Date.now() - started;
    return {
      ...initial,
      ...recommended,
      latency_ms: latencyMs,
      initial_decision_latency_ms: latencyMs,
      correction_recompute_latency_ms: null,
      model_calls: (initial.metrics?.model_calls ?? 0) + (recommended.metrics?.model_calls ?? 0),
      intent_repair_codes: initial.metrics?.repair_codes ?? [],
      intent_repair_issues: initial.metrics?.repair_issues ?? [],
      verification_repair_codes: recommended.metrics?.verification_repair_codes ?? [],
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    return {
      request: currentRequest,
      brief: null,
      context: null,
      error_code: error.code ?? error.message,
      error_stage: errorStage,
      latency_ms: latencyMs,
      initial_decision_latency_ms: evaluationCase.subset === "correction" ? null : latencyMs,
      correction_recompute_latency_ms: correctionStartedAt ? Date.now() - correctionStartedAt : null,
      model_calls: completedModelCalls + (error.model_calls ?? 0),
      intent_repair_codes: [...intentRepairCodes, ...(error.repair_codes ?? [])],
      intent_repair_issues: error.repair_issues ?? [],
      verification_repair_codes: error.verification_repair_codes ?? [],
      verification_issues: Array.isArray(error.details)
        ? error.details.map(({ code, detail }) => ({ code, detail }))
        : [],
    };
  }
}

const results = [];
for (const evaluationCase of selectedCases) {
  const run = await runCase(evaluationCase);
  results.push(scorePhase3CCase(evaluationCase, run));
  console.log(`${evaluationCase.case_id}: ${run.error_code ?? run.brief?.status ?? (run.clarification?.required ? "clarify" : "completed")}`);
}

const metrics = summarizePhase3CRun(results);
const gateResult = phase3d ? evaluatePhase3DGates(metrics) : evaluatePhase3CGates(metrics);
const report = {
  phase: phase3d ? "3D" : "3C",
  run_at: new Date().toISOString(),
  subset: selectedCaseId ?? (highRiskOnly ? "high-risk-30" : "all-100"),
  evaluation_set_version: evaluationManifest.evaluation_set_version,
  evidence_store_version: manifest.evidence_store_version,
  intent_model: env.QL_INTENT_MODEL,
  reasoning_model: env.QL_REASONING_MODEL,
  implementation,
  regression_fingerprint: phase3d ? await buildPhase3DFingerprint() : null,
  passed: gateResult.passed,
  gates: gateResult.gates,
  metrics,
  cases: results.map(privacyMinimizePhase3CCase),
};
await mkdir(outputRoot, { recursive: true });
const reportLabel = selectedCaseId ?? (highRiskOnly ? "high-risk" : "all");
const file = new URL(`${phase3d ? "phase3d" : "phase3c"}-${reportLabel}-${Date.now()}.json`, outputRoot);
await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));
console.log(`Phase ${phase3d ? "3D" : "3C"} automated gates: ${gateResult.passed ? "PASS" : "FAIL"}`);
console.log(`Saved privacy-minimized evaluation report to ${file.pathname}`);
if (!gateResult.passed) process.exitCode = 1;

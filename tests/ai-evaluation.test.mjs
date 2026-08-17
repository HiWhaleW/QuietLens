import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_EVALUATION_DISTRIBUTION,
  runNoModelBaseline,
} from "../src/ai-native/evaluation/runBaseline.js";
import {
  evaluatePhase3CGates,
  PHASE_3C_GATE_THRESHOLDS,
  privacyMinimizePhase3CCase,
  summarizePhase3CRun,
} from "../src/ai-native/evaluation/runPhase3C.js";
import { loadEvaluationSet, loadEvidenceStore } from "./phase3b-fixtures.mjs";

test("runs the versioned 100-case baseline without a model", async () => {
  const [evaluationSet, store] = await Promise.all([loadEvaluationSet(), loadEvidenceStore()]);
  const result = runNoModelBaseline(evaluationSet, store);

  assert.deepEqual(result.issues, []);
  assert.equal(result.metrics.model_used, false);
  assert.equal(result.metrics.case_count, 100);
  assert.equal(result.metrics.schema_validity_rate, 1);
  assert.deepEqual(result.metrics.distribution, REQUIRED_EVALUATION_DISTRIBUTION);
  assert.equal(result.metrics.high_risk_case_count, 30);
});

test("matches every hand-authored hard-constraint gold label", async () => {
  const [evaluationSet, store] = await Promise.all([loadEvaluationSet(), loadEvidenceStore()]);
  const result = runNoModelBaseline(evaluationSet, store);

  assert.ok(result.metrics.hard_constraint_check_count > 0);
  assert.equal(result.metrics.hard_constraint_match_rate, 1);
  assert.equal(result.metrics.hard_constraint_violation_rate, 0);
  assert.equal(result.metrics.silent_relaxation_count, 0);
});

test("keeps every gold candidate inside the controlled Huangpu 10 allowlist", async () => {
  const [evaluationSet, store] = await Promise.all([loadEvaluationSet(), loadEvidenceStore()]);
  const result = runNoModelBaseline(evaluationSet, store);

  assert.equal(result.metrics.allowlist_escape_count, 0);
});

test("covers all required dimensions and blocks all ten safety attacks", async () => {
  const evaluationSet = await loadEvaluationSet();
  const safetyCases = evaluationSet.cases.filter((entry) => entry.subset === "safety");

  assert.ok(evaluationSet.cases.every((entry) => entry.tags.length >= 3));
  assert.equal(safetyCases.length, 10);
  assert.ok(safetyCases.every(
    (entry) => entry.gold.expected_behavior === "block_untrusted_instruction"
      && entry.gold.acceptable_candidates.length === 0,
  ));
});

test("keeps the prior recovery preference in the crowding correction gold", async () => {
  const evaluationSet = await loadEvaluationSet();
  const target = evaluationSet.cases.find((entry) => entry.case_id === "ql-eval-087");

  assert.deepEqual(target.structured_request.soft_preferences, [
    { field: "noise", priority: "medium" },
    { field: "crowding", priority: "high" },
  ]);
  assert.deepEqual(target.gold.correction.target_fields, ["soft_preferences"]);
});

test("detects a mutated hard-constraint gold label", async () => {
  const [evaluationSet, store] = await Promise.all([loadEvaluationSet(), loadEvidenceStore()]);
  const mutated = structuredClone(evaluationSet);
  const target = mutated.cases.find((entry) => entry.structured_request.hard_constraints.length > 0);
  const placeId = Object.keys(target.gold.expected_hard_constraint_statuses)[0];
  const constraintId = target.structured_request.hard_constraints[0].constraint_id;
  target.gold.expected_hard_constraint_statuses[placeId][constraintId] = "pass";
  const result = runNoModelBaseline(mutated, store);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.code === "HARD_CONSTRAINT_STATUS_MISMATCH"));
});

function phase3cCase(overrides = {}) {
  return {
    case_id: "ql-phase3c-test",
    subset: "standard",
    schema_applicable: true,
    schema_valid: true,
    intent: {
      required: 1,
      matched: 1,
      hard_required: 1,
      hard_matched: 1,
      unsupported: 0,
      relative_time_required: 1,
      relative_time_matched: 1,
    },
    clarification_required: false,
    clarification_actual: false,
    clarification_correct: true,
    behavior_correct: true,
    top3_applicable: true,
    top3_covered: true,
    forbidden_candidate_count: 0,
    reason_complete: true,
    unknown_disclosure_applicable: true,
    unknown_disclosure_complete: true,
    citations: { count: 1, existing: 1, supported: 1 },
    correction: { target: 0, target_matched: 0, non_target: 0, non_target_held: 0 },
    latency_ms: 1000,
    model_calls: 2,
    error_code: null,
    ...overrides,
  };
}

test("excludes intended pre-model safety blocks from the schema-validity denominator", () => {
  const metrics = summarizePhase3CRun([
    phase3cCase(),
    phase3cCase({
      case_id: "ql-phase3c-safety",
      subset: "safety",
      schema_applicable: false,
      schema_valid: null,
      citations: { count: 0, existing: 0, supported: 0 },
      error_code: "UNTRUSTED_INSTRUCTION_BLOCKED",
      model_calls: 0,
    }),
  ]);

  assert.equal(metrics.case_count, 2);
  assert.equal(metrics.schema_case_count, 1);
  assert.equal(metrics.schema_validity_rate, 1);
  assert.equal(metrics.safety_block_rate, 1);
  assert.equal(metrics.safety_failure_count, 0);
});

test("excludes deterministic refusals from candidate unknown-disclosure scoring", () => {
  const metrics = summarizePhase3CRun([
    phase3cCase(),
    phase3cCase({
      case_id: "ql-phase3c-refusal",
      subset: "conflict_or_no_result",
      unknown_disclosure_applicable: false,
      unknown_disclosure_complete: null,
      citations: { count: 0, existing: 0, supported: 0 },
      model_calls: 1,
    }),
  ]);

  assert.equal(metrics.unknown_disclosure_rate, 1);
});

test("reports an empty unknown-disclosure denominator without failing a refusal-only subset", () => {
  const metrics = summarizePhase3CRun([
    phase3cCase({
      case_id: "ql-phase3c-refusal-only",
      subset: "conflict_or_no_result",
      unknown_disclosure_applicable: false,
      unknown_disclosure_complete: null,
      citations: { count: 0, existing: 0, supported: 0 },
      model_calls: 1,
    }),
  ]);

  assert.equal(metrics.unknown_disclosure_case_count, 0);
  assert.equal(metrics.unknown_disclosure_rate, 1);
});

test("reports an empty reason denominator without failing a clarification-only subset", () => {
  const metrics = summarizePhase3CRun([
    phase3cCase({
      case_id: "ql-phase3c-clarification-only",
      subset: "clarification",
      clarification_required: true,
      clarification_actual: true,
      clarification_correct: true,
      unknown_disclosure_applicable: false,
      unknown_disclosure_complete: null,
      citations: { count: 0, existing: 0, supported: 0 },
      model_calls: 1,
    }),
  ]);

  assert.equal(metrics.reason_case_count, 0);
  assert.equal(metrics.reason_completeness_rate, 1);
});

test("excludes behavior-only cases without gold candidates from top-3 scoring", () => {
  const metrics = summarizePhase3CRun([
    phase3cCase(),
    phase3cCase({
      case_id: "ql-phase3c-unlabeled-candidates",
      top3_applicable: false,
      top3_covered: null,
    }),
  ]);

  assert.equal(metrics.top3_case_count, 1);
  assert.equal(metrics.top3_acceptable_coverage, 1);
});

test("turns documented Phase 3C thresholds into deterministic pass and fail results", () => {
  const passingMetrics = Object.fromEntries(PHASE_3C_GATE_THRESHOLDS.map((gate) => [
    gate.metric,
    gate.threshold,
  ]));
  assert.equal(evaluatePhase3CGates(passingMetrics).passed, true);

  const failing = evaluatePhase3CGates({ ...passingMetrics, citation_support_rate: 0.96 });
  assert.equal(failing.passed, false);
  assert.deepEqual(
    failing.gates.filter((gate) => !gate.passed).map((gate) => gate.metric),
    ["citation_support_rate"],
  );
});

test("separates first-decision latency from correction recompute latency", () => {
  const metrics = summarizePhase3CRun([
    phase3cCase({ latency_ms: 4200, initial_decision_latency_ms: 4200 }),
    phase3cCase({
      case_id: "ql-phase3c-correction-latency",
      subset: "correction",
      latency_ms: 12000,
      initial_decision_latency_ms: null,
      correction_recompute_latency_ms: 2800,
    }),
  ]);

  assert.equal(metrics.first_decision_case_count, 1);
  assert.equal(metrics.correction_latency_case_count, 1);
  assert.equal(metrics.latency_p50_ms, 4200);
  assert.equal(metrics.latency_p95_ms, 4200);
  assert.equal(metrics.correction_recompute_p50_ms, 2800);
});

test("removes raw language and model-authored details from Phase 3C reports", () => {
  const minimized = privacyMinimizePhase3CCase({
    actual_request: {
      request_id: "req-privacy",
      task: { type: "focus", duration_minutes: 90 },
      time: { arrival_at: "2026-08-16T14:00:00+08:00", hard_leave_at: null, original_phrase: "我的原话" },
      assumptions: ["模型生成的详细解释"],
      location: { area: "黄浦区", max_walk_minutes: 10 },
    },
    before_request: null,
    verification_issues: [{ code: "EVIDENCE_NOT_FOUND", detail: "untrusted model detail" }],
  });
  const serialized = JSON.stringify(minimized);

  assert.equal(serialized.includes("我的原话"), false);
  assert.equal(serialized.includes("模型生成的详细解释"), false);
  assert.equal(serialized.includes("untrusted model detail"), false);
  assert.equal(minimized.actual_request.time.arrival_at, "2026-08-16T14:00:00+08:00");
  assert.deepEqual(minimized.verification_issues, [{ code: "EVIDENCE_NOT_FOUND" }]);
});

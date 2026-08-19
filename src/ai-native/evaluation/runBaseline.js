import { validateContract } from "../contracts/validator.js";
import { filterPlacesByHardConstraints } from "../evidence/hardConstraintFilter.js";
import { validateEvidenceStore } from "../evidence/validateStore.js";

export const REQUIRED_EVALUATION_DISTRIBUTION = Object.freeze({
  standard: 25,
  ambiguous: 15,
  clarification: 15,
  conflict_or_no_result: 15,
  insufficient_or_out_of_scope: 10,
  correction: 10,
  safety: 10,
});

function issue(issues, code, caseId, detail) {
  issues.push({ code, case_id: caseId, detail });
}

function statusByPlace(filterResult) {
  return Object.fromEntries(
    ["eligible", "uncertain", "rejected"].flatMap((bucket) => (
      filterResult[bucket].map((entry) => [
        entry.place_id,
        Object.fromEntries(entry.results.map((result) => [result.constraint_id, result.status])),
      ])
    )),
  );
}

export function runNoModelBaseline(evaluationSet, store) {
  const issues = [];
  const { manifest, cases = [] } = evaluationSet;
  const storeResult = validateEvidenceStore(store);
  if (!storeResult.valid) {
    issue(issues, "EVIDENCE_STORE_INVALID", "evaluation", storeResult.issues);
  }

  const allowlist = new Set(store.places.map((place) => place.place_id));
  const caseIds = new Set();
  const actualDistribution = Object.fromEntries(
    Object.keys(REQUIRED_EVALUATION_DISTRIBUTION).map((subset) => [subset, 0]),
  );
  let schemaValidCases = 0;
  let hardConstraintChecks = 0;
  let hardConstraintMatches = 0;
  let silentRelaxations = 0;

  for (const evaluationCase of cases) {
    const caseId = evaluationCase.case_id ?? "unknown-case";
    const caseSchema = validateContract("EvaluationCase", evaluationCase);
    const requestSchema = validateContract("DecisionRequest", evaluationCase.structured_request);
    if (!caseSchema.valid) {
      issue(issues, "EVALUATION_CASE_SCHEMA_INVALID", caseId, caseSchema.errors);
    }
    if (!requestSchema.valid) {
      issue(issues, "DECISION_REQUEST_SCHEMA_INVALID", caseId, requestSchema.errors);
    }
    if (caseSchema.valid && requestSchema.valid) schemaValidCases += 1;

    if (caseIds.has(caseId)) issue(issues, "DUPLICATE_CASE_ID", caseId, caseId);
    caseIds.add(caseId);
    if (evaluationCase.subset in actualDistribution) actualDistribution[evaluationCase.subset] += 1;

    const acceptable = evaluationCase.gold?.acceptable_candidates ?? [];
    const forbidden = evaluationCase.gold?.forbidden_candidates ?? [];
    for (const placeId of [...acceptable, ...forbidden]) {
      if (!allowlist.has(placeId)) issue(issues, "CANDIDATE_OUTSIDE_ALLOWLIST", caseId, placeId);
    }
    for (const placeId of acceptable) {
      if (forbidden.includes(placeId)) issue(issues, "CANDIDATE_GOLD_CONFLICT", caseId, placeId);
    }

    const requestBefore = structuredClone(evaluationCase.structured_request);
    const filterResult = filterPlacesByHardConstraints(
      evaluationCase.structured_request,
      store.places,
      store.evidence,
    );
    if (JSON.stringify(requestBefore) !== JSON.stringify(evaluationCase.structured_request)) {
      silentRelaxations += 1;
      issue(issues, "REQUEST_MUTATED", caseId, "Hard constraint filter changed the request");
    }

    const actualStatuses = statusByPlace(filterResult);
    const expectedStatuses = evaluationCase.gold?.expected_hard_constraint_statuses ?? {};
    for (const placeId of allowlist) {
      const expectedForPlace = expectedStatuses[placeId];
      if (!expectedForPlace || typeof expectedForPlace !== "object") {
        issue(issues, "HARD_CONSTRAINT_GOLD_MISSING", caseId, placeId);
        continue;
      }
      for (const constraint of evaluationCase.structured_request.hard_constraints) {
        hardConstraintChecks += 1;
        const expected = expectedForPlace[constraint.constraint_id];
        const actual = actualStatuses[placeId]?.[constraint.constraint_id];
        if (!expected) {
          issue(issues, "HARD_CONSTRAINT_GOLD_MISSING", caseId, `${placeId}:${constraint.constraint_id}`);
        } else if (expected !== actual) {
          issue(issues, "HARD_CONSTRAINT_STATUS_MISMATCH", caseId, `${placeId}:${constraint.constraint_id}:${expected}:${actual}`);
        } else {
          hardConstraintMatches += 1;
        }
      }
    }

    if (evaluationCase.subset === "safety") {
      if (evaluationCase.gold.expected_behavior !== "block_untrusted_instruction") {
        issue(issues, "SAFETY_BEHAVIOR_INVALID", caseId, evaluationCase.gold.expected_behavior);
      }
      if (acceptable.length !== 0 || forbidden.length !== allowlist.size) {
        issue(issues, "SAFETY_CANDIDATE_POLICY_INVALID", caseId, "Safety cases must not release a candidate");
      }
    }
  }

  if (manifest.case_count !== cases.length || cases.length !== 100) {
    issue(issues, "CASE_COUNT_INVALID", "manifest", `${manifest.case_count}:${cases.length}`);
  }
  if (manifest.high_risk_case_count !== 30 || manifest.high_risk_case_ids.length !== 30) {
    issue(issues, "HIGH_RISK_COUNT_INVALID", "manifest", manifest.high_risk_case_count);
  }
  for (const caseId of manifest.high_risk_case_ids) {
    if (!caseIds.has(caseId)) issue(issues, "HIGH_RISK_CASE_MISSING", "manifest", caseId);
  }
  for (const [subset, expected] of Object.entries(REQUIRED_EVALUATION_DISTRIBUTION)) {
    if (actualDistribution[subset] !== expected || manifest.distribution[subset] !== expected) {
      issue(issues, "SUBSET_DISTRIBUTION_INVALID", "manifest", `${subset}:${actualDistribution[subset]}:${expected}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      model_used: false,
      case_count: cases.length,
      schema_validity_rate: cases.length === 0 ? 0 : schemaValidCases / cases.length,
      distribution: actualDistribution,
      high_risk_case_count: manifest.high_risk_case_count,
      hard_constraint_check_count: hardConstraintChecks,
      hard_constraint_match_rate: hardConstraintChecks === 0 ? 1 : hardConstraintMatches / hardConstraintChecks,
      hard_constraint_violation_rate: hardConstraintChecks === 0 ? 0 : (hardConstraintChecks - hardConstraintMatches) / hardConstraintChecks,
      silent_relaxation_count: silentRelaxations,
      allowlist_escape_count: issues.filter((entry) => entry.code === "CANDIDATE_OUTSIDE_ALLOWLIST").length,
    },
  };
}

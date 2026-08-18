const USABLE_EPISTEMIC_STATUSES = new Set(["verified_fact", "sourced_observation"]);

function valuesEqual(actual, expected) {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length
      && actual.every((value, index) => valuesEqual(value, expected[index]));
  }
  return actual === expected;
}

function compareValue(operator, actual, expected) {
  switch (operator) {
    case "equals":
      return valuesEqual(actual, expected);
    case "not_equals":
      return !valuesEqual(actual, expected);
    case "supports":
      return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
    case "available":
      return typeof actual === "boolean" && typeof expected === "boolean" ? actual === expected : null;
    case "at_least":
      return typeof actual === "number" && typeof expected === "number" ? actual >= expected : null;
    case "at_most":
      return typeof actual === "number" && typeof expected === "number" ? actual <= expected : null;
    default:
      throw new Error(`Unsupported hard constraint operator: ${operator}`);
  }
}

export function evaluateHardConstraint(placeId, constraint, evidence) {
  const related = evidence.filter(
    (record) => record.place_id === placeId
      && record.attribute === constraint.field
      && USABLE_EPISTEMIC_STATUSES.has(record.epistemic_status)
      && record.publishability !== "not_factual",
  );
  const relevant = related.filter((record) => record.constraint_usable);

  if (relevant.length === 0) {
    return {
      constraint_id: constraint.constraint_id,
      status: "unknown",
      evidence_ids: [],
      reason_code: related.length === 0 ? "evidence_missing" : "evidence_not_constraint_grade",
    };
  }

  if (relevant.some((record) => ["unresolved", "documented"].includes(record.conflict_status))) {
    return {
      constraint_id: constraint.constraint_id,
      status: "unknown",
      evidence_ids: relevant.map((record) => record.evidence_id),
      reason_code: "evidence_conflicted",
    };
  }

  if (relevant.every((record) => ["stale", "unknown"].includes(record.freshness))) {
    return {
      constraint_id: constraint.constraint_id,
      status: "unknown",
      evidence_ids: relevant.map((record) => record.evidence_id),
      reason_code: "evidence_not_current_enough",
    };
  }

  const comparisons = relevant.map((record) => compareValue(
    constraint.operator,
    record.normalized_value,
    constraint.value,
  ));

  if (comparisons.some((result) => result === null)) {
    return {
      constraint_id: constraint.constraint_id,
      status: "unknown",
      evidence_ids: relevant.map((record) => record.evidence_id),
      reason_code: "evidence_not_comparable",
    };
  }

  if (comparisons.some(Boolean) && comparisons.some((result) => !result)) {
    return {
      constraint_id: constraint.constraint_id,
      status: "unknown",
      evidence_ids: relevant.map((record) => record.evidence_id),
      reason_code: "evidence_disagrees",
    };
  }

  return {
    constraint_id: constraint.constraint_id,
    status: comparisons.every(Boolean) ? "pass" : "fail",
    evidence_ids: relevant.map((record) => record.evidence_id),
    reason_code: comparisons.every(Boolean) ? "evidence_supports" : "evidence_refutes",
  };
}

export function filterPlacesByHardConstraints(request, places, evidence) {
  const result = { eligible: [], uncertain: [], rejected: [] };

  for (const place of places) {
    if (place.identity_status !== "verified") {
      result.rejected.push({
        place_id: place.place_id,
        results: [{
          constraint_id: "system-identity",
          status: "fail",
          evidence_ids: [],
          reason_code: "identity_not_verified",
        }],
      });
      continue;
    }

    const results = request.hard_constraints.map((constraint) => (
      evaluateHardConstraint(place.place_id, constraint, evidence)
    ));
    const entry = { place_id: place.place_id, results };

    if (results.some((constraint) => constraint.status === "fail")) {
      result.rejected.push(entry);
    } else if (results.some((constraint) => constraint.status === "unknown")) {
      result.uncertain.push(entry);
    } else {
      result.eligible.push(entry);
    }
  }

  return result;
}

const RELIABILITY_WEIGHT = { high: 1, medium: 0.65, low: 0.3, unknown: 0 };
const FRESHNESS_WEIGHT = { current: 1, aging: 0.7, stale: 0.25, unknown: 0.2 };

export function calculateConfidence(request, candidate, evidence) {
  const requested = new Set([
    ...request.hard_constraints.map((constraint) => constraint.field),
    ...request.soft_preferences.map((preference) => preference.field),
  ]);
  const hardUnknown = candidate.hard_constraint_results.some((result) => result.status === "unknown");
  const relevant = evidence.filter((record) => requested.size === 0 || requested.has(record.attribute));
  const covered = new Set(
    relevant
      .filter((record) => record.epistemic_status !== "unknown" && record.publishability !== "not_factual")
      .map((record) => record.attribute),
  );
  const coverage = requested.size === 0 ? 0.5 : covered.size / requested.size;
  const quality = relevant.length === 0
    ? 0
    : relevant.reduce((sum, record) => (
      sum + RELIABILITY_WEIGHT[record.reliability] * FRESHNESS_WEIGHT[record.freshness]
    ), 0) / relevant.length;
  const hasConflict = relevant.some((record) => ["documented", "unresolved"].includes(record.conflict_status));

  let level = "low";
  if (!hardUnknown && !hasConflict && coverage >= 0.75 && quality >= 0.7) level = "high";
  else if (!hardUnknown && coverage >= 0.4 && quality >= 0.45) level = "medium";

  const basis = [
    `关键条件证据覆盖 ${Math.round(coverage * 100)}%`,
    hardUnknown ? "至少一项硬约束无法确认" : "没有未确认的硬约束进入通过状态",
    hasConflict ? "相关证据存在待解释冲突" : "未发现相关重大证据冲突",
  ];
  return { level, basis };
}


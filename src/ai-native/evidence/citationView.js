const CITATION_KIND_LABELS = {
  fit: "适配依据",
  tradeoff: "权衡依据",
  constraint: "硬条件依据",
};

function addEvidenceIds(target, groups, kind) {
  for (const group of groups ?? []) {
    for (const evidenceId of group.evidence_ids ?? []) {
      const kinds = target.get(evidenceId) ?? new Set();
      kinds.add(kind);
      target.set(evidenceId, kinds);
    }
  }
}

export function buildCandidateCitationView(candidate, context) {
  if (!candidate || !context) return [];

  const kindsByEvidenceId = new Map();
  addEvidenceIds(kindsByEvidenceId, candidate.fit_reasons, "fit");
  addEvidenceIds(kindsByEvidenceId, candidate.tradeoffs, "tradeoff");
  addEvidenceIds(kindsByEvidenceId, candidate.hard_constraint_results, "constraint");

  const evidenceById = new Map((context.evidence ?? []).map((record) => [record.evidence_id, record]));
  const sourceById = new Map((context.sources ?? []).map((source) => [source.source_id, source]));

  return [...kindsByEvidenceId].flatMap(([evidenceId, kinds]) => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence || evidence.place_id !== candidate.place_id) return [];
    return [{
      ...evidence,
      kind_labels: [...kinds].map((kind) => CITATION_KIND_LABELS[kind]),
      sources: evidence.source_ids.flatMap((sourceId) => {
        const source = sourceById.get(sourceId);
        return source ? [source] : [];
      }),
    }];
  });
}

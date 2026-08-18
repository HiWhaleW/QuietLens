const CITATION_KIND_LABELS = {
  fit: "适配依据",
  tradeoff: "权衡依据",
  constraint: "硬条件依据",
};

const HARD_CONSTRAINT_COPY = {
  pass: "该条已核实记录支持本轮硬条件已满足的判断。",
  fail: "该条已核实记录支持本轮硬条件未满足的判断。",
  unknown: "该条记录用于核验本轮硬条件，但现有资料仍不足以确认。",
};

function addEvidenceIds(target, groups, kind, getText) {
  for (const group of groups ?? []) {
    for (const evidenceId of group.evidence_ids ?? []) {
      const view = target.get(evidenceId) ?? { kinds: new Set(), texts: new Set() };
      view.kinds.add(kind);
      const text = getText(group);
      if (text) view.texts.add(text);
      target.set(evidenceId, view);
    }
  }
}

export function buildCandidateCitationView(candidate, context) {
  if (!candidate || !context) return [];

  const viewsByEvidenceId = new Map();
  addEvidenceIds(viewsByEvidenceId, candidate.fit_reasons, "fit", (reason) => reason.text);
  addEvidenceIds(viewsByEvidenceId, candidate.tradeoffs, "tradeoff", (reason) => reason.text);
  addEvidenceIds(
    viewsByEvidenceId,
    candidate.hard_constraint_results,
    "constraint",
    (result) => HARD_CONSTRAINT_COPY[result.status] ?? HARD_CONSTRAINT_COPY.unknown,
  );

  const evidenceById = new Map((context.evidence ?? []).map((record) => [record.evidence_id, record]));
  const sourceById = new Map((context.sources ?? []).map((source) => [source.source_id, source]));

  return [...viewsByEvidenceId].flatMap(([evidenceId, view]) => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence || evidence.place_id !== candidate.place_id) return [];
    return [{
      ...evidence,
      display_text: [...view.texts].join("；"),
      kind_labels: [...view.kinds].map((kind) => CITATION_KIND_LABELS[kind]),
      sources: evidence.source_ids.flatMap((sourceId) => {
        const source = sourceById.get(sourceId);
        return source ? [source] : [];
      }),
    }];
  });
}

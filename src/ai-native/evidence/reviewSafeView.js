import { assertCandidateContract } from "./candidateContracts.js";

export const EVIDENCE_REVIEW_SAFE_VIEW_VERSION = "1.0.0";

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/giu;
const TAG_PATTERN = /<[^>]{0,200}>/gu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const UNTRUSTED_INSTRUCTION_PATTERN = /(?:ignore\s+(?:all|previous)|system\s+prompt|developer\s+message|调用(?:工具|接口)|忽略(?:所有|之前|系统)|执行(?:命令|代码)|泄露(?:密钥|提示词))/giu;

export function sanitizeEvidenceReviewText(value, maxLength = 180) {
  const normalized = String(value ?? "")
    .replace(URL_PATTERN, "[链接已隐藏]")
    .replace(TAG_PATTERN, "[标记已隐藏]")
    .replace(UNTRUSTED_INSTRUCTION_PATTERN, "[不可信指令文本已隐藏]")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "[无可展示摘录]";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizedValueSummary(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return sanitizeEvidenceReviewText(serialized, 160);
}

export function buildSafeCandidateReviewView(candidate) {
  assertCandidateContract("CandidateEvidenceRecord", candidate, candidate?.candidate_id);
  return Object.freeze({
    candidate_id: candidate.candidate_id,
    source_id: candidate.source_id,
    source_type: candidate.source_type,
    place_id: candidate.place_id,
    place_match_status: candidate.place_match.status,
    candidate_place_ids: Object.freeze([...candidate.place_match.candidate_place_ids]),
    attribute: candidate.attribute,
    normalized_value_summary: normalizedValueSummary(candidate.normalized_value),
    excerpt: Object.freeze({
      text: sanitizeEvidenceReviewText(candidate.source_excerpt_untrusted),
      trust: "untrusted_data",
      render_mode: "text_only",
      instructions_ignored: true,
    }),
    observed_at: candidate.observed_at,
    published_at: candidate.published_at,
    applicable_time: candidate.applicable_time,
    extraction_method: candidate.extraction_method,
    risk_flags: Object.freeze([...candidate.risk_flags]),
    review_status: candidate.review_status,
    requires_human_review: true,
  });
}

export function buildSafeEvidenceReviewProjection({ scopeId, workbench, candidateState }) {
  const candidates = (candidateState?.candidates ?? []).map(buildSafeCandidateReviewView);
  for (const cluster of candidateState?.deduplication_clusters ?? []) {
    assertCandidateContract("DeduplicationCluster", cluster, cluster?.cluster_id);
  }
  for (const conflict of candidateState?.conflict_queue ?? []) {
    assertCandidateContract("ConflictQueueItem", conflict, conflict?.conflict_id);
  }
  return Object.freeze({
    schema_version: EVIDENCE_REVIEW_SAFE_VIEW_VERSION,
    scope_id: scopeId,
    review_context: workbench.review_context,
    content_policy: Object.freeze({
      trust: "untrusted_data",
      render_mode: "text_only",
      urls_exposed: false,
      payload_references_exposed: false,
      raw_identity_exposed: false,
    }),
    sources: Object.freeze(workbench.sources.map((source) => Object.freeze({ ...source }))),
    candidates: Object.freeze(candidates),
    deduplication_clusters: Object.freeze((candidateState?.deduplication_clusters ?? []).map((cluster) => Object.freeze({
      cluster_id: cluster.cluster_id,
      candidate_ids: Object.freeze([...cluster.candidate_ids]),
      source_ids: Object.freeze([...cluster.source_ids]),
      place_id: cluster.place_id,
      attribute: cluster.attribute,
      review_status: cluster.review_status,
      requires_human_review: true,
    }))),
    conflicts: Object.freeze((candidateState?.conflict_queue ?? []).map((conflict) => Object.freeze({
      conflict_id: conflict.conflict_id,
      place_id: conflict.place_id,
      attribute: conflict.attribute,
      candidate_ids: Object.freeze([...conflict.candidate_ids]),
      severity: conflict.severity,
      comparison_scope: conflict.comparison_scope,
      status: conflict.status,
      requires_human_review: true,
    }))),
    queue: Object.freeze(workbench.queue.map((item) => Object.freeze({ ...item }))),
    metrics: Object.freeze({ ...workbench.metrics }),
  });
}

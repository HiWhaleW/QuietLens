import { buildEvidencePipelineBaseline } from "../../src/ai-native/evidence/pipelineRegistry.js";
import { assertEvidenceScopeId } from "./config.js";
import { createSupabaseEvidenceReviewAuthenticator } from "./reviewerAuthenticator.js";
import { createSupabaseEvidenceReviewAuditStore } from "./reviewAuditStore.js";

const runtimeByEnvironment = new WeakMap();

function buildRuntime(env) {
  if (env?.QL_EVIDENCE_REVIEW_PROVIDER !== "supabase") {
    throw new Error("EVIDENCE_REVIEW_PROVIDER_NOT_CONFIGURED");
  }
  if (!env.QUIETLENS_EVIDENCE_STORE) throw new Error("EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED");
  const projectUrl = env.QL_SUPABASE_PROJECT_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const scopeId = assertEvidenceScopeId(env.QL_EVIDENCE_REVIEW_SCOPE_ID);
  const fetcher = typeof env.QUIETLENS_SUPABASE_FETCH === "function"
    ? env.QUIETLENS_SUPABASE_FETCH
    : globalThis.fetch;
  const now = typeof env.QUIETLENS_NOW === "function" ? env.QUIETLENS_NOW : () => new Date().toISOString();
  const nowMs = () => Date.parse(now());
  const auditStore = createSupabaseEvidenceReviewAuditStore({
    projectUrl,
    serviceRoleKey,
    scopeId,
    fetcher,
  });
  return Object.freeze({
    authenticator: createSupabaseEvidenceReviewAuthenticator({
      projectUrl,
      serviceRoleKey,
      fetcher,
      now: nowMs,
    }),
    runtime: Object.freeze({
      reviewContext: "production",
      scopeId,
      pipelineState: buildEvidencePipelineBaseline(env.QUIETLENS_EVIDENCE_STORE),
      candidateState: Object.freeze({
        candidates: Object.freeze([]),
        deduplication_clusters: Object.freeze([]),
        conflict_queue: Object.freeze([]),
      }),
      auditStore,
      now,
    }),
  });
}

export function resolveSupabaseEvidenceReviewRuntime(env) {
  if (!env || (typeof env !== "object" && typeof env !== "function")) {
    throw new Error("EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED");
  }
  let resolved = runtimeByEnvironment.get(env);
  if (!resolved) {
    resolved = buildRuntime(env);
    runtimeByEnvironment.set(env, resolved);
  }
  return resolved;
}

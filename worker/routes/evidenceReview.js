import { verifyEvidenceReviewAuditSnapshot } from "../evidence/reviewAuditLedger.js";
import {
  executeEvidenceReviewCommand,
  queryEvidenceReviewWorkspace,
} from "../services/evidenceReviewService.js";
import { resolveSupabaseEvidenceReviewRuntime } from "../supabase/evidenceReviewRuntime.js";
import { jsonResponse, readJson, sameOriginAllowed } from "./http.js";

const WORKSPACE_PATH = "/api/evidence-review/workspace";
const DECISIONS_PATH = "/api/evidence-review/decisions";

function isEnabled(env) {
  return env?.QL_EVIDENCE_REVIEW_API_ENABLED === "true";
}

function configuredRuntime(env) {
  const providerRuntime = env?.QUIETLENS_EVIDENCE_REVIEW_AUTHENTICATOR
    || env?.QUIETLENS_EVIDENCE_REVIEW_RUNTIME
    ? {
        authenticator: env?.QUIETLENS_EVIDENCE_REVIEW_AUTHENTICATOR,
        runtime: env?.QUIETLENS_EVIDENCE_REVIEW_RUNTIME,
      }
    : resolveSupabaseEvidenceReviewRuntime(env);
  const { authenticator, runtime } = providerRuntime;
  if (authenticator?.trust_kind !== "external_identity" || typeof authenticator?.authenticate !== "function") {
    throw new Error("EVIDENCE_REVIEW_AUTHENTICATOR_NOT_CONFIGURED");
  }
  if (!runtime
    || runtime.reviewContext !== "production"
    || typeof runtime.scopeId !== "string"
    || !runtime.pipelineState
    || !runtime.candidateState
    || runtime.auditStore?.storage_kind !== "durable"
    || typeof runtime.auditStore?.readSnapshot !== "function"
    || typeof runtime.auditStore?.appendIfVersion !== "function") {
    throw new Error("EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED");
  }
  return { authenticator, runtime };
}

function publicError(error) {
  const code = error?.message ?? "EVIDENCE_REVIEW_FAILED";
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    return { code, status: error.status };
  }
  if ([
    "EVIDENCE_REVIEW_AUTHENTICATOR_NOT_CONFIGURED",
    "EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED",
    "EVIDENCE_REVIEW_PROVIDER_NOT_CONFIGURED",
    "SUPABASE_PROJECT_URL_INVALID",
    "SUPABASE_SERVICE_ROLE_KEY_INVALID",
    "SUPABASE_EVIDENCE_SCOPE_INVALID",
    "SUPABASE_FETCH_UNAVAILABLE",
    "SUPABASE_JWKS_UNAVAILABLE",
    "SUPABASE_JWKS_INVALID",
    "SUPABASE_REVIEWER_GRANT_UNAVAILABLE",
    "SUPABASE_REVIEWER_GRANT_INVALID",
    "SUPABASE_AUDIT_STORE_UNAVAILABLE",
    "SUPABASE_AUDIT_STORE_CORRUPT",
    "EVIDENCE_AUDIT_STORE_UNAVAILABLE",
    "EVIDENCE_AUDIT_LOG_CORRUPT",
    "EVIDENCE_AUDIT_CRYPTO_UNAVAILABLE",
  ].includes(code)) return { code, status: 503 };
  if ([
    "EVIDENCE_REVIEW_AUTHENTICATION_REQUIRED",
    "EVIDENCE_REVIEW_PRINCIPAL_INVALID",
    "EVIDENCE_REVIEW_PRINCIPAL_REVOKED",
    "EVIDENCE_REVIEW_SESSION_INVALID",
    "EVIDENCE_REVIEW_CONTEXT_MISMATCH",
    "SUPABASE_TOKEN_MISSING",
    "SUPABASE_TOKEN_INVALID",
    "SUPABASE_TOKEN_ALGORITHM_FORBIDDEN",
    "SUPABASE_TOKEN_KEY_NOT_FOUND",
    "SUPABASE_TOKEN_SIGNATURE_INVALID",
    "SUPABASE_TOKEN_CLAIMS_INVALID",
  ].some((prefix) => code.startsWith(prefix))) {
    return { code: "EVIDENCE_REVIEW_AUTHENTICATION_REQUIRED", status: 401 };
  }
  if ([
    "EVIDENCE_REVIEW_SCOPE_FORBIDDEN",
    "EVIDENCE_REVIEW_OPERATION_FORBIDDEN",
    "SUPABASE_REVIEWER_NOT_AUTHORIZED",
  ].includes(code)) {
    return { code, status: 403 };
  }
  if (code === "EVIDENCE_REVIEW_SUBJECT_NOT_FOUND") return { code, status: 404 };
  if (code === "EVIDENCE_REVIEW_COMMAND_INVALID") return { code, status: 400 };
  if ([
    "EVIDENCE_AUDIT_VERSION_CONFLICT",
    "EVIDENCE_AUDIT_CONCURRENT_WRITE",
    "EVIDENCE_AUDIT_COMMAND_COLLISION",
    "EVIDENCE_AUDIT_RECORD_COLLISION",
  ].includes(code)) return { code, status: 409 };
  return { code: "EVIDENCE_REVIEW_FAILED", status: 500 };
}

async function authenticate(authenticator, request) {
  const principal = await authenticator.authenticate(request);
  if (!principal) throw new Error("EVIDENCE_REVIEW_AUTHENTICATION_REQUIRED");
  return principal;
}

async function verifiedReviewDecisions(runtime) {
  const snapshot = await runtime.auditStore.readSnapshot();
  await verifyEvidenceReviewAuditSnapshot(snapshot);
  return snapshot.entries
    .filter((entry) => entry.scope_id === runtime.scopeId && entry.record_contract === "EvidenceReviewDecision")
    .map((entry) => entry.record);
}

function serverTime(runtime) {
  const at = typeof runtime.now === "function" ? runtime.now() : new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error("EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED");
  return at;
}

export async function routeEvidenceReviewRequest(request, env) {
  const pathname = new URL(request.url).pathname;
  if (![WORKSPACE_PATH, DECISIONS_PATH].includes(pathname) || !isEnabled(env)) return null;
  const expectedMethod = pathname === WORKSPACE_PATH ? "GET" : "POST";
  if (request.method !== expectedMethod) return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  if (!sameOriginAllowed(request)) return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);

  try {
    const { authenticator, runtime } = configuredRuntime(env);
    const principal = await authenticate(authenticator, request);
    const at = serverTime(runtime);
    if (pathname === WORKSPACE_PATH) {
      const reviewDecisions = await verifiedReviewDecisions(runtime);
      const data = await queryEvidenceReviewWorkspace({
        principal,
        scopeId: runtime.scopeId,
        at,
        today: at.slice(0, 10),
        pipelineState: runtime.pipelineState,
        candidateState: runtime.candidateState,
        reviewDecisions,
      });
      return jsonResponse({ data });
    }

    const command = await readJson(request);
    const data = await executeEvidenceReviewCommand({
      principal,
      command,
      scopeId: runtime.scopeId,
      at,
      pipelineState: runtime.pipelineState,
      candidateState: runtime.candidateState,
      auditStore: runtime.auditStore,
    });
    return jsonResponse({ data });
  } catch (error) {
    const mapped = publicError(error);
    return jsonResponse({ error: { code: mapped.code } }, mapped.status);
  }
}

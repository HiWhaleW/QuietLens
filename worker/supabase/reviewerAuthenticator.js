import {
  assertEvidenceScopeId,
  assertSupabaseServiceRoleKey,
  normalizeSupabaseProjectUrl,
  supabaseServiceHeaders,
} from "./config.js";
import { createSupabaseJwtVerifier } from "./jwtVerifier.js";

const REVIEWER_ID_PATTERN = /^reviewer-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALLOWED_ROLES = new Set([
  "evidence_reviewer",
  "evidence_publisher",
  "evidence_rollback_operator",
  "evidence_auditor",
]);

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertGrant(value) {
  if (!value
    || typeof value !== "object"
    || !REVIEWER_ID_PATTERN.test(value.reviewer_id ?? "")
    || value.status !== "active"
    || !Array.isArray(value.roles)
    || value.roles.length < 1
    || new Set(value.roles).size !== value.roles.length
    || value.roles.some((role) => !ALLOWED_ROLES.has(role))
    || !Array.isArray(value.scope_ids)
    || value.scope_ids.length < 1
    || new Set(value.scope_ids).size !== value.scope_ids.length) {
    throw new Error("SUPABASE_REVIEWER_GRANT_INVALID");
  }
  value.scope_ids.forEach(assertEvidenceScopeId);
  return value;
}

async function readReviewerGrant({ projectUrl, serviceRoleKey, fetcher, authUserId }) {
  const query = new URLSearchParams({
    select: "reviewer_id,roles,scope_ids,status",
    auth_user_id: `eq.${authUserId}`,
    status: "eq.active",
    limit: "2",
  });
  let response;
  try {
    response = await fetcher(`${projectUrl}/rest/v1/quietlens_reviewer_grants?${query}`, {
      method: "GET",
      headers: supabaseServiceHeaders(serviceRoleKey, { accept: "application/json" }),
    });
  } catch {
    throw new Error("SUPABASE_REVIEWER_GRANT_UNAVAILABLE");
  }
  if (!response?.ok) throw new Error("SUPABASE_REVIEWER_GRANT_UNAVAILABLE");
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new Error("SUPABASE_REVIEWER_GRANT_UNAVAILABLE");
  }
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("SUPABASE_REVIEWER_NOT_AUTHORIZED");
  return assertGrant(rows[0]);
}

export function createSupabaseEvidenceReviewAuthenticator({
  projectUrl,
  serviceRoleKey,
  fetcher = globalThis.fetch,
  now = () => Date.now(),
  jwtVerifier = null,
}) {
  const origin = normalizeSupabaseProjectUrl(projectUrl);
  const key = assertSupabaseServiceRoleKey(serviceRoleKey);
  if (typeof fetcher !== "function") throw new Error("SUPABASE_FETCH_UNAVAILABLE");
  const verifier = jwtVerifier ?? createSupabaseJwtVerifier({ projectUrl: origin, fetcher, now });

  return Object.freeze({
    trust_kind: "external_identity",
    provider_id: "supabase",
    async authenticate(request) {
      const claims = await verifier.verifyRequest(request);
      const grant = await readReviewerGrant({
        projectUrl: origin,
        serviceRoleKey: key,
        fetcher,
        authUserId: claims.sub,
      });
      return Object.freeze({
        schema_version: "1.0.0",
        principal_id: grant.reviewer_id,
        actor_kind: "human",
        review_context: "production",
        identity_provider_id: "idp-supabase",
        identity_subject_hash: await sha256(`${claims.iss}|${claims.sub}`),
        session_id_hash: await sha256(`${claims.iss}|${claims.session_id}`),
        authentication_method: "external_identity",
        authentication_assurance: "multi_factor",
        roles: Object.freeze([...grant.roles]),
        scope_ids: Object.freeze([...grant.scope_ids]),
        authenticated_at: new Date(claims.iat * 1000).toISOString(),
        expires_at: new Date(claims.exp * 1000).toISOString(),
        status: "active",
        ai_is_actor: false,
      });
    },
  });
}

import { EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION } from "../evidence/reviewAuditLedger.js";
import {
  assertEvidenceScopeId,
  assertSupabaseServiceRoleKey,
  normalizeSupabaseProjectUrl,
  supabaseServiceHeaders,
} from "./config.js";

function emptySnapshot() {
  return {
    schema_version: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION,
    review_context: "production",
    version: 0,
    entries: [],
  };
}

async function responseJson(response, errorCode) {
  try {
    return await response.json();
  } catch {
    throw new Error(errorCode);
  }
}

export function createSupabaseEvidenceReviewAuditStore({
  projectUrl,
  serviceRoleKey,
  scopeId,
  fetcher = globalThis.fetch,
}) {
  const origin = normalizeSupabaseProjectUrl(projectUrl);
  const key = assertSupabaseServiceRoleKey(serviceRoleKey);
  const scope = assertEvidenceScopeId(scopeId);
  if (typeof fetcher !== "function") throw new Error("SUPABASE_FETCH_UNAVAILABLE");

  async function request(path, init, errorCode) {
    try {
      return await fetcher(`${origin}${path}`, init);
    } catch {
      throw new Error(errorCode);
    }
  }

  return Object.freeze({
    storage_kind: "durable",
    provider_id: "supabase",
    scope_id: scope,
    async readSnapshot() {
      const headQuery = new URLSearchParams({
        select: "version,head_entry_sha256",
        scope_id: `eq.${scope}`,
        limit: "2",
      });
      const headers = supabaseServiceHeaders(key, { accept: "application/json" });
      const headResponse = await request(
        `/rest/v1/quietlens_evidence_review_ledger_heads?${headQuery}`,
        { method: "GET", headers },
        "SUPABASE_AUDIT_STORE_UNAVAILABLE",
      );
      if (!headResponse?.ok) throw new Error("SUPABASE_AUDIT_STORE_UNAVAILABLE");
      const heads = await responseJson(headResponse, "SUPABASE_AUDIT_STORE_UNAVAILABLE");
      if (!Array.isArray(heads) || heads.length > 1) throw new Error("SUPABASE_AUDIT_STORE_CORRUPT");
      if (heads.length === 0) return emptySnapshot();
      if (!Number.isInteger(heads[0].version) || heads[0].version < 0) throw new Error("SUPABASE_AUDIT_STORE_CORRUPT");

      const entryQuery = new URLSearchParams({
        select: "entry",
        scope_id: `eq.${scope}`,
        order: "sequence.asc",
      });
      const entryResponse = await request(
        `/rest/v1/quietlens_evidence_review_audit_entries?${entryQuery}`,
        { method: "GET", headers },
        "SUPABASE_AUDIT_STORE_UNAVAILABLE",
      );
      if (!entryResponse?.ok) throw new Error("SUPABASE_AUDIT_STORE_UNAVAILABLE");
      const rows = await responseJson(entryResponse, "SUPABASE_AUDIT_STORE_UNAVAILABLE");
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.entry !== "object")) {
        throw new Error("SUPABASE_AUDIT_STORE_CORRUPT");
      }
      return {
        schema_version: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION,
        review_context: "production",
        version: heads[0].version,
        entries: rows.map((row) => row.entry),
      };
    },
    async appendIfVersion(expectedVersion, entry) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error("EVIDENCE_AUDIT_CONCURRENT_WRITE");
      const response = await request(
        "/rest/v1/rpc/quietlens_append_evidence_review_audit_entry",
        {
          method: "POST",
          headers: supabaseServiceHeaders(key, {
            accept: "application/json",
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            p_scope_id: scope,
            p_expected_version: expectedVersion,
            p_entry: entry,
          }),
        },
        "SUPABASE_AUDIT_STORE_UNAVAILABLE",
      );
      if (response?.ok) return { version: expectedVersion + 1 };
      let errorBody = null;
      try {
        errorBody = await response?.json();
      } catch {
        errorBody = null;
      }
      if (response?.status === 409
        || (errorBody?.code === "P0001" && errorBody?.message === "EVIDENCE_AUDIT_CONCURRENT_WRITE")) {
        throw new Error("EVIDENCE_AUDIT_CONCURRENT_WRITE");
      }
      throw new Error("SUPABASE_AUDIT_STORE_UNAVAILABLE");
    },
  });
}

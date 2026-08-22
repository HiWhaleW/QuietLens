import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { authorizeEvidenceReviewOperation } from "../src/ai-native/evidence/reviewAccessControl.js";
import { createReviewDecision } from "../src/ai-native/evidence/reviewWorkbench.js";
import {
  appendEvidenceReviewAuditRecord,
  verifyEvidenceReviewAuditSnapshot,
} from "../worker/evidence/reviewAuditLedger.js";
import { normalizeSupabaseProjectUrl } from "../worker/supabase/config.js";
import { createSupabaseEvidenceReviewAuthenticator } from "../worker/supabase/reviewerAuthenticator.js";
import { createSupabaseEvidenceReviewAuditStore } from "../worker/supabase/reviewAuditStore.js";
import worker from "../worker/index.js";
import { loadEvidenceStore } from "./phase3b-fixtures.mjs";

const projectUrl = "https://quietlensfixture.supabase.co";
const serviceRoleKey = `service-role-fixture-${"s".repeat(48)}`;
const scopeId = "evidence-v1.0-huangpu-10";
const nowMs = Date.parse("2026-08-19T12:00:00Z");
const authUserId = "12345678-1234-4123-8123-123456789abc";
const sessionId = "abcdefab-1234-4123-8123-abcdefabcdef";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function tamperJwtSignature(token) {
  const [header, payload, encodedSignature] = token.split(".");
  const padded = encodedSignature.replace(/-/gu, "+").replace(/_/gu, "/")
    .padEnd(Math.ceil(encodedSignature.length / 4) * 4, "=");
  const signature = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  signature[0] ^= 1;
  return `${header}.${payload}.${base64Url(signature)}`;
}

async function signingFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  Object.assign(publicJwk, { kid: "quietlens-test-key", alg: "ES256", use: "sig" });
  async function token(overrides = {}) {
    const header = base64Url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: publicJwk.kid }));
    const payload = base64Url(JSON.stringify({
      iss: `${projectUrl}/auth/v1`,
      aud: "authenticated",
      role: "authenticated",
      aal: "aal2",
      sub: authUserId,
      session_id: sessionId,
      iat: Math.floor(nowMs / 1000) - 60,
      exp: Math.floor(nowMs / 1000) + 3600,
      ...overrides,
    }));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(signature)}`;
  }
  return { publicJwk, token };
}

test("accepts only a bounded official Supabase project origin", () => {
  assert.equal(normalizeSupabaseProjectUrl(`${projectUrl}/`), projectUrl);
  for (const value of [
    "http://quietlensfixture.supabase.co",
    "https://user:secret@quietlensfixture.supabase.co/",
    "https://quietlensfixture.supabase.co/rest/v1",
    "https://supabase.example.com/",
  ]) {
    assert.throws(() => normalizeSupabaseProjectUrl(value), /SUPABASE_PROJECT_URL_INVALID/);
  }
});

test("verifies a Supabase aal2 JWT and loads server-owned reviewer grants", async () => {
  const signing = await signingFixture();
  let jwksCalls = 0;
  let grantCalls = 0;
  const fetcher = async (url, init) => {
    if (url.endsWith("/.well-known/jwks.json")) {
      jwksCalls += 1;
      return jsonResponse({ keys: [signing.publicJwk] });
    }
    if (url.includes("/rest/v1/quietlens_reviewer_grants?")) {
      grantCalls += 1;
      assert.equal(init.headers.apikey, serviceRoleKey);
      assert.equal(init.headers.authorization, `Bearer ${serviceRoleKey}`);
      assert.match(url, new RegExp(`auth_user_id=eq\\.${authUserId}`));
      return jsonResponse([{
        reviewer_id: "reviewer-supabase-owner",
        roles: ["evidence_reviewer", "evidence_auditor"],
        scope_ids: [scopeId],
        status: "active",
      }]);
    }
    throw new Error("unexpected request");
  };
  const authenticator = createSupabaseEvidenceReviewAuthenticator({
    projectUrl,
    serviceRoleKey,
    fetcher,
    now: () => nowMs,
  });
  const accessToken = await signing.token();
  const request = () => new Request("https://quietlens.test/api/evidence-review/workspace", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const first = await authenticator.authenticate(request());
  const second = await authenticator.authenticate(request());
  assert.equal(first.principal_id, "reviewer-supabase-owner");
  assert.equal(first.authentication_assurance, "multi_factor");
  assert.equal(first.identity_subject_hash.length, 64);
  assert.equal(first.session_id_hash.length, 64);
  assert.notEqual(first.identity_subject_hash, authUserId);
  assert.deepEqual(second, first);
  assert.equal(jwksCalls, 1);
  assert.equal(grantCalls, 2);
  assert.equal(authorizeEvidenceReviewOperation({
    principal: first,
    operation: "read_review_workspace",
    scopeId,
    reviewContext: "production",
    at: "2026-08-19T12:00:00Z",
  }).authorized, true);
});

test("rejects missing MFA, bad signatures, and provider error text without leaking it", async () => {
  const signing = await signingFixture();
  let grantCalls = 0;
  const fetcher = async (url) => {
    if (url.endsWith("/.well-known/jwks.json")) return jsonResponse({ keys: [signing.publicJwk] });
    grantCalls += 1;
    return jsonResponse({ message: `do not expose ${serviceRoleKey}` }, 500);
  };
  const authenticator = createSupabaseEvidenceReviewAuthenticator({
    projectUrl,
    serviceRoleKey,
    fetcher,
    now: () => nowMs,
  });
  const noMfa = await signing.token({ aal: "aal1" });
  await assert.rejects(() => authenticator.authenticate(new Request("https://quietlens.test", {
    headers: { authorization: `Bearer ${noMfa}` },
  })), /SUPABASE_TOKEN_CLAIMS_INVALID/);
  assert.equal(grantCalls, 0);

  const valid = await signing.token();
  const tampered = tamperJwtSignature(valid);
  await assert.rejects(() => authenticator.authenticate(new Request("https://quietlens.test", {
    headers: { authorization: `Bearer ${tampered}` },
  })), /SUPABASE_TOKEN_SIGNATURE_INVALID/);
  assert.equal(grantCalls, 0);

  const error = await authenticator.authenticate(new Request("https://quietlens.test", {
    headers: { authorization: `Bearer ${valid}` },
  })).then(() => null, (caught) => caught);
  assert.equal(error.message, "SUPABASE_REVIEWER_GRANT_UNAVAILABLE");
  assert.doesNotMatch(error.message, /service-role-fixture/);
});

function productionPrincipal() {
  return {
    schema_version: "1.0.0",
    principal_id: "reviewer-supabase-owner",
    actor_kind: "human",
    review_context: "production",
    identity_provider_id: "idp-supabase",
    identity_subject_hash: "a".repeat(64),
    session_id_hash: "b".repeat(64),
    authentication_method: "external_identity",
    authentication_assurance: "multi_factor",
    roles: ["evidence_reviewer", "evidence_auditor"],
    scope_ids: [scopeId],
    authenticated_at: "2026-08-19T10:00:00Z",
    expires_at: "2026-08-19T18:00:00Z",
    status: "active",
    ai_is_actor: false,
  };
}

test("persists and verifies an append-only audit snapshot through the Supabase RPC contract", async () => {
  let version = 0;
  const entries = [];
  const fetcher = async (url, init) => {
    assert.equal(init.headers.apikey, serviceRoleKey);
    if (url.includes("quietlens_evidence_review_ledger_heads?")) {
      return jsonResponse(version === 0 ? [] : [{ version, head_entry_sha256: entries.at(-1).entry_sha256 }]);
    }
    if (url.includes("quietlens_evidence_review_audit_entries?")) {
      return jsonResponse(entries.map((entry) => ({ entry })));
    }
    if (url.endsWith("/rest/v1/rpc/quietlens_append_evidence_review_audit_entry")) {
      const body = JSON.parse(init.body);
      assert.equal(body.p_scope_id, scopeId);
      if (body.p_expected_version !== version) {
        return jsonResponse({ code: "P0001", message: "EVIDENCE_AUDIT_CONCURRENT_WRITE" }, 400);
      }
      entries.push(body.p_entry);
      version += 1;
      return jsonResponse({ scope_id: scopeId, version });
    }
    throw new Error("unexpected Supabase request");
  };
  const store = createSupabaseEvidenceReviewAuditStore({ projectUrl, serviceRoleKey, scopeId, fetcher });
  assert.equal(store.storage_kind, "durable");
  assert.deepEqual(await store.readSnapshot(), {
    schema_version: "1.1.0",
    review_context: "production",
    version: 0,
    entries: [],
  });
  const source = { source_id: "src-supabase-fixture" };
  const decision = createReviewDecision({
    subjectType: "source",
    subject: source,
    reviewContext: "production",
    outcome: "source_confirmed",
    reasonCode: "source_current",
    reviewerId: "reviewer-supabase-owner",
    reviewedAt: "2026-08-19T12:00:00Z",
    nextReviewDueAt: "2026-09-19",
  });
  await appendEvidenceReviewAuditRecord({
    store,
    principal: productionPrincipal(),
    operation: "review_source",
    scopeId,
    occurredAt: "2026-08-19T12:00:00Z",
    record: decision,
  });
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.version, 1);
  assert.equal((await verifyEvidenceReviewAuditSnapshot(snapshot)).valid, true);
  await assert.rejects(() => store.appendIfVersion(0, entries[0]), /EVIDENCE_AUDIT_CONCURRENT_WRITE/);
});

test("keeps Supabase storage failures privacy-minimized", async () => {
  const store = createSupabaseEvidenceReviewAuditStore({
    projectUrl,
    serviceRoleKey,
    scopeId,
    fetcher: async () => jsonResponse({ message: `database rejected ${serviceRoleKey}` }, 500),
  });
  const error = await store.readSnapshot().then(() => null, (caught) => caught);
  assert.equal(error.message, "SUPABASE_AUDIT_STORE_UNAVAILABLE");
  assert.doesNotMatch(error.message, /database rejected|service-role-fixture/);
});

test("resolves the default-off Worker route from server-only Supabase environment bindings", async () => {
  const signing = await signingFixture();
  const appendedEntries = [];
  const fetcher = async (url, init) => {
    if (url.endsWith("/.well-known/jwks.json")) return jsonResponse({ keys: [signing.publicJwk] });
    if (url.includes("quietlens_reviewer_grants?")) {
      return jsonResponse([{
        reviewer_id: "reviewer-supabase-owner",
        roles: ["evidence_reviewer", "evidence_auditor"],
        scope_ids: [scopeId],
        status: "active",
      }]);
    }
    if (url.includes("quietlens_evidence_review_ledger_heads?")) {
      return jsonResponse(appendedEntries.length === 0 ? [] : [{
        version: appendedEntries.length,
        head_entry_sha256: appendedEntries.at(-1).entry_sha256,
      }]);
    }
    if (url.includes("quietlens_evidence_review_audit_entries?")) {
      return jsonResponse(appendedEntries.map((entry) => ({ entry })));
    }
    if (url.endsWith("/rest/v1/rpc/quietlens_append_evidence_review_audit_entry")) {
      const payload = JSON.parse(init.body);
      assert.equal(payload.p_expected_version, appendedEntries.length);
      appendedEntries.push(payload.p_entry);
      return jsonResponse({ version: appendedEntries.length });
    }
    throw new Error(`unexpected Supabase request: ${url}`);
  };
  const accessToken = await signing.token();
  const evidenceStore = await loadEvidenceStore();
  const env = {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    QL_EVIDENCE_REVIEW_API_ENABLED: "true",
    QL_EVIDENCE_REVIEW_PROVIDER: "supabase",
    QL_EVIDENCE_REVIEW_SCOPE_ID: scopeId,
    QL_SUPABASE_PROJECT_URL: projectUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    QUIETLENS_EVIDENCE_STORE: evidenceStore,
    QUIETLENS_SUPABASE_FETCH: fetcher,
    QUIETLENS_NOW: () => "2026-08-19T12:00:00Z",
  };
  const response = await worker.fetch(new Request("https://quietlens.test/api/evidence-review/workspace", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      origin: "https://quietlens.test",
    },
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.sources.length, 32);
  assert.equal(body.data.candidates.length, 0);
  assert.equal(body.data.review_context, "production");
  assert.doesNotMatch(JSON.stringify(body), /service-role-fixture|auth_user_id|"source_url":|"payload_ref":/);

  const decisionResponse = await worker.fetch(new Request("https://quietlens.test/api/evidence-review/decisions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      origin: "https://quietlens.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schema_version: "1.0.0",
      command_id: "command-bbbbbbbbbbbbbbbb",
      expected_ledger_version: 0,
      subject_type: "source",
      subject_id: evidenceStore.sources[0].source_id,
      outcome: "source_confirmed",
      selected_candidate_id: null,
      reason_code: "source_current",
      next_review_due_at: "2026-09-19",
    }),
  }), env);
  const decisionBody = await decisionResponse.json();
  assert.equal(decisionResponse.status, 200);
  assert.equal(decisionBody.data.decision.reviewer_id, "reviewer-supabase-owner");
  assert.equal(appendedEntries.length, 1);
});

test("migration denies browser roles and exposes only a service-role append RPC", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608190001_evidence_review.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.quietlens_reviewer_grants from anon, authenticated/);
  assert.match(sql, /auth\.role\(\) <> 'service_role'/);
  assert.match(sql, /EVIDENCE_AUDIT_CONCURRENT_WRITE/);
  assert.match(sql, /grant execute on function .* to service_role/);
  assert.doesNotMatch(sql, /insert into public\.quietlens_reviewer_grants/);
});

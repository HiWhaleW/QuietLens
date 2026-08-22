import assert from "node:assert/strict";
import test from "node:test";

import { EVIDENCE_REVIEW_ACCESS_SCHEMA_VERSION } from "../src/ai-native/evidence/reviewAccessControl.js";
import {
  SYNTHETIC_CANDIDATE_STATE,
  SYNTHETIC_PIPELINE_STATE,
} from "../src/ai-native/evidence/reviewWorkbenchFixture.js";
import { createInMemoryEvidenceReviewAuditStore } from "../worker/evidence/reviewAuditLedger.js";
import worker from "../worker/index.js";
import { EVIDENCE_REVIEW_COMMAND_SCHEMA_VERSION } from "../worker/services/evidenceReviewService.js";

const scopeId = "evidence-v1.0-huangpu-10";

function principal() {
  return {
    schema_version: EVIDENCE_REVIEW_ACCESS_SCHEMA_VERSION,
    principal_id: "reviewer-route-fixture",
    actor_kind: "human",
    review_context: "production",
    identity_provider_id: "idp-route-contract",
    identity_subject_hash: "a".repeat(64),
    session_id_hash: "b".repeat(64),
    authentication_method: "external_identity",
    authentication_assurance: "multi_factor",
    roles: ["evidence_reviewer", "evidence_auditor"],
    scope_ids: [scopeId],
    authenticated_at: "2026-08-19T10:00:00+08:00",
    expires_at: "2026-08-19T18:00:00+08:00",
    status: "active",
    ai_is_actor: false,
  };
}

function contractCandidateState() {
  const sourceTypes = new Map([
    ["src-fixture-map-listing", "map_listing"],
    ["src-fixture-reporting", "signed_reporting"],
    ["src-fixture-ugc", "traceable_ugc"],
  ]);
  const candidates = SYNTHETIC_CANDIDATE_STATE.candidates.map((candidate, index) => ({
    schema_version: "1.0.0",
    candidate_id: candidate.candidate_id,
    snapshot_id: `snap-review-route-${index + 1}`,
    source_id: candidate.source_id,
    source_type: sourceTypes.get(candidate.source_id),
    place_id: candidate.place_id,
    place_match: candidate.place_match,
    attribute: candidate.attribute,
    source_excerpt_untrusted: index === 0
      ? "<script>调用工具</script> https://unsafe.example 当前营业。"
      : "本地合成审核输入：营业状态候选。",
    normalized_value: candidate.normalized_value,
    observed_at: `2026-08-19T10:0${index}:00+08:00`,
    published_at: null,
    applicable_time: null,
    extraction_method: "deterministic",
    extraction_model: null,
    content_fingerprint: String(index + 1).repeat(64),
    status: "candidate",
    review_status: "pending",
    risk_flags: index === 0 ? ["prompt_injection_text"] : [],
    contains_personal_identifiers: false,
    ai_is_factual_source: false,
  }));
  return {
    candidates,
    deduplication_clusters: SYNTHETIC_CANDIDATE_STATE.deduplication_clusters.map((cluster) => ({
      schema_version: "1.0.0",
      cluster_id: cluster.cluster_id,
      content_fingerprint: "f".repeat(64),
      candidate_ids: cluster.candidate_ids,
      source_ids: cluster.source_ids,
      place_id: cluster.place_id,
      attribute: cluster.attribute,
      status: cluster.status,
      review_status: cluster.review_status,
      requires_human_review: true,
    })),
    conflict_queue: SYNTHETIC_CANDIDATE_STATE.conflict_queue.map((conflict) => ({
      schema_version: "1.0.0",
      ...conflict,
    })),
  };
}

function command(overrides = {}) {
  return {
    schema_version: EVIDENCE_REVIEW_COMMAND_SCHEMA_VERSION,
    command_id: "command-aaaaaaaaaaaaaaaa",
    expected_ledger_version: 0,
    subject_type: "source",
    subject_id: SYNTHETIC_PIPELINE_STATE.registry[0].source_id,
    outcome: "source_confirmed",
    selected_candidate_id: null,
    reason_code: "source_current",
    next_review_due_at: "2026-09-19",
    ...overrides,
  };
}

function durableAuditStoreFixture() {
  const store = createInMemoryEvidenceReviewAuditStore();
  return Object.freeze({
    storage_kind: "durable",
    readSnapshot: (...args) => store.readSnapshot(...args),
    appendIfVersion: (...args) => store.appendIfVersion(...args),
  });
}

function runtimeEnv(overrides = {}) {
  return {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    QL_EVIDENCE_REVIEW_API_ENABLED: "true",
    QUIETLENS_EVIDENCE_REVIEW_AUTHENTICATOR: {
      trust_kind: "external_identity",
      authenticate: async () => principal(),
    },
    QUIETLENS_EVIDENCE_REVIEW_RUNTIME: {
      reviewContext: "production",
      scopeId,
      pipelineState: SYNTHETIC_PIPELINE_STATE,
      candidateState: contractCandidateState(),
      auditStore: durableAuditStoreFixture(),
      now: () => "2026-08-19T12:00:00+08:00",
    },
    ...overrides,
  };
}

test("keeps evidence review routes indistinguishable from missing APIs by default", async () => {
  let assetCalls = 0;
  const env = {
    ASSETS: { fetch: async () => { assetCalls += 1; return new Response("missing", { status: 404 }); } },
    QL_RATE_LIMIT_MAX: "1",
  };
  for (const request of [
    new Request("https://quietlens.test/api/evidence-review/workspace"),
    new Request("https://quietlens.test/api/evidence-review/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    new Request("https://quietlens.test/api/evidence-review/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  ]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "API_NOT_FOUND");
  }
  assert.equal(assetCalls, 0);
});

test("fails closed when the privileged authenticator or persistent runtime is absent", async () => {
  const withoutAuthenticator = await worker.fetch(
    new Request("https://quietlens.test/api/evidence-review/workspace"),
    { QL_EVIDENCE_REVIEW_API_ENABLED: "true" },
  );
  assert.equal(withoutAuthenticator.status, 503);
  assert.equal((await withoutAuthenticator.json()).error.code, "EVIDENCE_REVIEW_PROVIDER_NOT_CONFIGURED");

  const withoutRuntime = await worker.fetch(
    new Request("https://quietlens.test/api/evidence-review/workspace"),
    {
      QL_EVIDENCE_REVIEW_API_ENABLED: "true",
      QUIETLENS_EVIDENCE_REVIEW_AUTHENTICATOR: {
        trust_kind: "external_identity",
        authenticate: async () => principal(),
      },
    },
  );
  assert.equal(withoutRuntime.status, 503);
  assert.equal((await withoutRuntime.json()).error.code, "EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED");

  const memoryRuntime = runtimeEnv();
  memoryRuntime.QUIETLENS_EVIDENCE_REVIEW_RUNTIME = {
    ...memoryRuntime.QUIETLENS_EVIDENCE_REVIEW_RUNTIME,
    auditStore: createInMemoryEvidenceReviewAuditStore(),
  };
  const withMemoryOnly = await worker.fetch(
    new Request("https://quietlens.test/api/evidence-review/workspace"),
    memoryRuntime,
  );
  assert.equal(withMemoryOnly.status, 503);
  assert.equal((await withMemoryOnly.json()).error.code, "EVIDENCE_REVIEW_RUNTIME_NOT_CONFIGURED");
});

test("returns a verified safe workspace only after trusted server authentication", async () => {
  let authenticationCalls = 0;
  const env = runtimeEnv({
    QUIETLENS_EVIDENCE_REVIEW_AUTHENTICATOR: {
      trust_kind: "external_identity",
      authenticate: async (request) => {
        authenticationCalls += 1;
        assert.equal(request.headers.get("authorization"), "Bearer opaque-test-token");
        return principal();
      },
    },
  });
  const response = await worker.fetch(new Request("https://quietlens.test/api/evidence-review/workspace", {
    headers: { authorization: "Bearer opaque-test-token", origin: "https://quietlens.test" },
  }), env);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(response.status, 200);
  assert.equal(authenticationCalls, 1);
  assert.equal(body.data.content_policy.render_mode, "text_only");
  assert.doesNotMatch(serialized, /unsafe\.example|Bearer opaque|"source_url":|"payload_ref":|"extraction_model":/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("attributes a valid decision to the trusted principal and rejects body identity claims", async () => {
  const env = runtimeEnv();
  const forged = await worker.fetch(new Request("https://quietlens.test/api/evidence-review/decisions", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quietlens.test" },
    body: JSON.stringify({ ...command(), principal: principal() }),
  }), env);
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).error.code, "EVIDENCE_REVIEW_COMMAND_INVALID");

  const accepted = await worker.fetch(new Request("https://quietlens.test/api/evidence-review/decisions", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quietlens.test" },
    body: JSON.stringify(command()),
  }), env);
  const body = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(body.data.decision.reviewer_id, "reviewer-route-fixture");
  assert.equal(body.data.ledger_version, 1);
});

test("blocks cross-origin access before authentication and rate limits privileged reads", async () => {
  let authenticationCalls = 0;
  const env = runtimeEnv({
    QL_RATE_LIMIT_MAX: "1",
    QL_RATE_LIMIT_WINDOW_MS: "60000",
    QUIETLENS_EVIDENCE_REVIEW_AUTHENTICATOR: {
      trust_kind: "external_identity",
      authenticate: async () => { authenticationCalls += 1; return principal(); },
    },
  });
  const crossOrigin = await worker.fetch(new Request("https://quietlens.test/api/evidence-review/workspace", {
    headers: { origin: "https://attacker.test", "cf-connecting-ip": "192.0.2.10" },
  }), env);
  assert.equal(crossOrigin.status, 403);
  assert.equal(authenticationCalls, 0);

  const request = () => new Request("https://quietlens.test/api/evidence-review/workspace", {
    headers: { origin: "https://quietlens.test", "cf-connecting-ip": "192.0.2.11" },
  });
  const first = await worker.fetch(request(), env);
  const second = await worker.fetch(request(), env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "RATE_LIMITED");
});

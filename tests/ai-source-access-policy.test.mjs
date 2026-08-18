import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKED_AUTOMATION_HOST_SUFFIXES,
  SOURCE_FAMILY_POLICIES,
  isAutomationBlockedHost,
  validateSourceAccessPlan,
} from "../src/ai-native/evidence/sourceAccessPolicy.js";
import { loadEvidenceStore } from "./phase3b-fixtures.mjs";

const store = await loadEvidenceStore();

function compliantPlan(overrides = {}) {
  return {
    adapter_id: "adapter-example-reporting",
    source_type: "signed_reporting",
    host: "example.com",
    access_mode: "public_page",
    enabled: true,
    approval_status: "approved",
    review: {
      terms_reviewed_at: "2026-08-18",
      robots_reviewed_at: "2026-08-18",
      owner: "evidence-operator",
    },
    controls: {
      bypass_captcha: false,
      reuse_authenticated_session: false,
      reverse_engineer_signature: false,
      call_private_api: false,
      rotate_identity_or_proxy: false,
      honors_retry_after: true,
      uses_cache: true,
    },
    rate_limit: { requests_per_minute: 6, max_concurrency: 1 },
    storage: { stores_personal_identifiers: false, stores_full_text: false },
    output_status: "candidate",
    ...overrides,
  };
}

test("covers every source type already present in Evidence v0.1", () => {
  const existingTypes = new Set(store.sources.map((source) => source.source_type));
  for (const sourceType of existingTypes) {
    assert.ok(SOURCE_FAMILY_POLICIES[sourceType], `missing policy for ${sourceType}`);
  }
});

test("accepts a reviewed, rate-limited public-page adapter plan", () => {
  assert.deepEqual(validateSourceAccessPlan(compliantPlan()), { valid: true, issues: [] });
});

test("blocks direct automation on high-risk review and social platforms", () => {
  for (const host of BLOCKED_AUTOMATION_HOST_SUFFIXES) {
    assert.equal(isAutomationBlockedHost(`www.${host}`), true);
    const result = validateSourceAccessPlan(compliantPlan({ host }));
    assert.ok(result.issues.some((item) => item.code === "HOST_AUTOMATION_BLOCKED"));
  }
});

test("requires explicit approval, terms review, robots review, caching, and backoff controls", () => {
  const result = validateSourceAccessPlan(compliantPlan({
    approval_status: "pending",
    review: {},
    controls: {
      bypass_captcha: false,
      reuse_authenticated_session: false,
      reverse_engineer_signature: false,
      call_private_api: false,
      rotate_identity_or_proxy: false,
      honors_retry_after: false,
      uses_cache: false,
    },
  }));
  const codes = new Set(result.issues.map((item) => item.code));
  assert.ok(codes.has("APPROVAL_REQUIRED"));
  assert.ok(codes.has("TERMS_REVIEW_REQUIRED"));
  assert.ok(codes.has("ROBOTS_REVIEW_REQUIRED"));
  assert.ok(codes.has("REVIEW_OWNER_REQUIRED"));
  assert.ok(codes.has("RETRY_AFTER_REQUIRED"));
  assert.ok(codes.has("CACHE_REQUIRED"));
});

test("rejects every prohibited collection technique", () => {
  for (const field of [
    "bypass_captcha",
    "reuse_authenticated_session",
    "reverse_engineer_signature",
    "call_private_api",
    "rotate_identity_or_proxy",
  ]) {
    const controls = { ...compliantPlan().controls, [field]: true };
    const result = validateSourceAccessPlan(compliantPlan({ controls }));
    assert.ok(result.issues.some((item) => item.field === `controls.${field}`));
  }
});

test("keeps UGC candidate-only and excludes identity fields and full review text", () => {
  const result = validateSourceAccessPlan(compliantPlan({
    adapter_id: "adapter-example-ugc",
    source_type: "traceable_ugc",
    access_mode: "licensed_api",
    storage: { stores_personal_identifiers: true, stores_full_text: true },
    output_status: "published",
  }));
  const codes = new Set(result.issues.map((item) => item.code));
  assert.ok(codes.has("PERSONAL_IDENTIFIERS_FORBIDDEN"));
  assert.ok(codes.has("UGC_FULL_TEXT_FORBIDDEN"));
  assert.ok(codes.has("CANDIDATE_OUTPUT_REQUIRED"));
});

test("does not allow public-page scraping for traceable UGC", () => {
  const result = validateSourceAccessPlan(compliantPlan({
    adapter_id: "adapter-example-ugc",
    source_type: "traceable_ugc",
  }));
  assert.ok(result.issues.some((item) => item.code === "ACCESS_MODE_NOT_ALLOWED"));
});

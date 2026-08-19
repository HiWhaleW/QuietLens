export const SOURCE_ACCESS_POLICY_VERSION = "1.0.0";

export const AUTOMATED_ACCESS_MODES = new Set([
  "official_api",
  "licensed_api",
  "public_page",
]);

export const PROHIBITED_COLLECTION_TECHNIQUES = Object.freeze([
  "bypass_captcha",
  "reuse_authenticated_session",
  "reverse_engineer_signature",
  "call_private_api",
  "rotate_identity_or_proxy",
]);

export const BLOCKED_AUTOMATION_HOST_SUFFIXES = Object.freeze([
  "dianping.com",
  "douyin.com",
  "meituan.com",
  "xiaohongshu.com",
]);

export const SOURCE_FAMILY_POLICIES = Object.freeze({
  map_listing: Object.freeze({
    allowed_access_modes: ["official_api", "licensed_api", "manual_research"],
    max_requests_per_minute: 30,
    max_concurrency: 5,
  }),
  signed_reporting: Object.freeze({
    allowed_access_modes: ["public_page", "licensed_api", "manual_research"],
    max_requests_per_minute: 6,
    max_concurrency: 1,
  }),
  brand_interview: Object.freeze({
    allowed_access_modes: ["public_page", "licensed_api", "manual_research"],
    max_requests_per_minute: 6,
    max_concurrency: 1,
  }),
  editorial_guide: Object.freeze({
    allowed_access_modes: ["public_page", "licensed_api", "manual_research"],
    max_requests_per_minute: 6,
    max_concurrency: 1,
  }),
  traceable_ugc: Object.freeze({
    allowed_access_modes: ["licensed_api", "manual_research", "user_submitted_link"],
    max_requests_per_minute: 6,
    max_concurrency: 1,
  }),
  official_page: Object.freeze({
    allowed_access_modes: ["public_page", "licensed_api", "manual_research"],
    max_requests_per_minute: 6,
    max_concurrency: 1,
  }),
  address_reference: Object.freeze({
    allowed_access_modes: ["public_page", "licensed_api", "manual_research"],
    max_requests_per_minute: 6,
    max_concurrency: 1,
  }),
  curated_registry: Object.freeze({
    allowed_access_modes: ["internal_registry"],
    max_requests_per_minute: 0,
    max_concurrency: 0,
  }),
});

function issue(code, field, detail) {
  return { code, field, detail };
}

function normalizedHost(host) {
  return String(host ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function hostMatchesSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function isAutomationBlockedHost(host) {
  const normalized = normalizedHost(host);
  return BLOCKED_AUTOMATION_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(normalized, suffix));
}

export function getSourceFamilyPolicy(sourceType) {
  return SOURCE_FAMILY_POLICIES[sourceType] ?? null;
}

export function validateSourceAccessPlan(plan) {
  const issues = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, issues: [issue("PLAN_INVALID", "plan", "Access plan must be an object")] };
  }

  const policy = getSourceFamilyPolicy(plan.source_type);
  if (!/^adapter-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.adapter_id ?? "")) {
    issues.push(issue("ADAPTER_ID_INVALID", "adapter_id", plan.adapter_id));
  }
  if (!policy) {
    issues.push(issue("SOURCE_TYPE_UNKNOWN", "source_type", plan.source_type));
    return { valid: false, issues };
  }
  if (!policy.allowed_access_modes.includes(plan.access_mode)) {
    issues.push(issue("ACCESS_MODE_NOT_ALLOWED", "access_mode", plan.access_mode));
  }

  const automated = AUTOMATED_ACCESS_MODES.has(plan.access_mode);
  const host = normalizedHost(plan.host);
  if (automated && !host) {
    issues.push(issue("HOST_REQUIRED", "host", "Automated access requires an explicit host"));
  }
  if (automated && isAutomationBlockedHost(host)) {
    issues.push(issue("HOST_AUTOMATION_BLOCKED", "host", host));
  }
  if (plan.enabled === true && plan.approval_status !== "approved") {
    issues.push(issue("APPROVAL_REQUIRED", "approval_status", plan.approval_status));
  }

  const review = plan.review ?? {};
  if (automated && !/^\d{4}-\d{2}-\d{2}$/.test(review.terms_reviewed_at ?? "")) {
    issues.push(issue("TERMS_REVIEW_REQUIRED", "review.terms_reviewed_at", review.terms_reviewed_at));
  }
  if (plan.access_mode === "public_page" && !/^\d{4}-\d{2}-\d{2}$/.test(review.robots_reviewed_at ?? "")) {
    issues.push(issue("ROBOTS_REVIEW_REQUIRED", "review.robots_reviewed_at", review.robots_reviewed_at));
  }
  if (automated && !String(review.owner ?? "").trim()) {
    issues.push(issue("REVIEW_OWNER_REQUIRED", "review.owner", review.owner));
  }

  const controls = plan.controls ?? {};
  for (const technique of PROHIBITED_COLLECTION_TECHNIQUES) {
    if (controls[technique] !== false) {
      issues.push(issue("PROHIBITED_TECHNIQUE_NOT_DISABLED", `controls.${technique}`, controls[technique]));
    }
  }
  if (automated && controls.honors_retry_after !== true) {
    issues.push(issue("RETRY_AFTER_REQUIRED", "controls.honors_retry_after", controls.honors_retry_after));
  }
  if (plan.access_mode === "public_page" && controls.uses_cache !== true) {
    issues.push(issue("CACHE_REQUIRED", "controls.uses_cache", controls.uses_cache));
  }

  const requestsPerMinute = Number(plan.rate_limit?.requests_per_minute);
  const concurrency = Number(plan.rate_limit?.max_concurrency);
  if (automated && (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0
    || requestsPerMinute > policy.max_requests_per_minute)) {
    issues.push(issue("RATE_LIMIT_INVALID", "rate_limit.requests_per_minute", requestsPerMinute));
  }
  if (automated && (!Number.isInteger(concurrency) || concurrency <= 0
    || concurrency > policy.max_concurrency)) {
    issues.push(issue("CONCURRENCY_INVALID", "rate_limit.max_concurrency", concurrency));
  }

  const storage = plan.storage ?? {};
  if (storage.stores_personal_identifiers !== false) {
    issues.push(issue("PERSONAL_IDENTIFIERS_FORBIDDEN", "storage.stores_personal_identifiers", storage.stores_personal_identifiers));
  }
  if (plan.source_type === "traceable_ugc" && storage.stores_full_text !== false) {
    issues.push(issue("UGC_FULL_TEXT_FORBIDDEN", "storage.stores_full_text", storage.stores_full_text));
  }
  if (plan.output_status !== "candidate") {
    issues.push(issue("CANDIDATE_OUTPUT_REQUIRED", "output_status", plan.output_status));
  }

  return { valid: issues.length === 0, issues };
}

export function assertSourceAccessPlan(plan) {
  const result = validateSourceAccessPlan(plan);
  if (!result.valid) {
    throw new Error(result.issues.map(({ code, field }) => `${code}:${field}`).join("; "));
  }
  return result;
}

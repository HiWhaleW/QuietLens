import Ajv from "ajv";

import { assertReviewContract } from "./reviewWorkbenchContracts.js";

export const EVIDENCE_REVIEW_ACCESS_SCHEMA_VERSION = "1.0.0";

export const EVIDENCE_REVIEW_ROLES = Object.freeze([
  "evidence_reviewer",
  "evidence_publisher",
  "evidence_rollback_operator",
  "evidence_auditor",
]);

export const EVIDENCE_REVIEW_OPERATIONS = Object.freeze([
  "review_source",
  "review_candidate",
  "review_deduplication_cluster",
  "review_conflict",
  "create_release_draft",
  "publish_release",
  "request_rollback",
  "read_review_workspace",
  "read_audit_log",
  "prepare_audit_restore",
]);

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const reviewerIdPattern = "^reviewer-[a-z0-9]+(?:-[a-z0-9]+)*$";
const hashPattern = "^[a-f0-9]{64}$";

export const evidenceReviewerPrincipalSchema = {
  $id: "https://quietlens.local/schema/evidence-reviewer-principal-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReviewerPrincipal",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "principal_id",
    "actor_kind",
    "review_context",
    "identity_provider_id",
    "identity_subject_hash",
    "session_id_hash",
    "authentication_method",
    "authentication_assurance",
    "roles",
    "scope_ids",
    "authenticated_at",
    "expires_at",
    "status",
    "ai_is_actor",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_ACCESS_SCHEMA_VERSION },
    principal_id: { type: "string", pattern: reviewerIdPattern },
    actor_kind: { const: "human" },
    review_context: { enum: ["synthetic_fixture", "production"] },
    identity_provider_id: { type: "string", pattern: "^idp-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    identity_subject_hash: { type: "string", pattern: hashPattern },
    session_id_hash: { type: "string", pattern: hashPattern },
    authentication_method: { enum: ["synthetic_fixture", "external_identity"] },
    authentication_assurance: { enum: ["synthetic", "single_factor", "multi_factor"] },
    roles: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: EVIDENCE_REVIEW_ROLES },
    },
    scope_ids: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: "^evidence-[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$" },
    },
    authenticated_at: { type: "string", pattern: dateTimePattern },
    expires_at: { type: "string", pattern: dateTimePattern },
    status: { enum: ["active", "revoked"] },
    ai_is_actor: { const: false },
  },
  allOf: [
    {
      if: { properties: { review_context: { const: "production" } } },
      then: {
        properties: {
          authentication_method: { const: "external_identity" },
          authentication_assurance: { const: "multi_factor" },
          identity_provider_id: { not: { const: "idp-synthetic-fixture" } },
        },
      },
      else: {
        properties: {
          authentication_method: { const: "synthetic_fixture" },
          authentication_assurance: { const: "synthetic" },
          identity_provider_id: { const: "idp-synthetic-fixture" },
        },
      },
    },
  ],
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validatePrincipal = ajv.compile(evidenceReviewerPrincipalSchema);

const operationPolicy = Object.freeze({
  review_source: Object.freeze({ role: "evidence_reviewer", contract: "EvidenceReviewDecision", subjectType: "source", actorField: "reviewer_id" }),
  review_candidate: Object.freeze({ role: "evidence_reviewer", contract: "EvidenceReviewDecision", subjectType: "candidate", actorField: "reviewer_id" }),
  review_deduplication_cluster: Object.freeze({ role: "evidence_reviewer", contract: "EvidenceReviewDecision", subjectType: "deduplication_cluster", actorField: "reviewer_id" }),
  review_conflict: Object.freeze({ role: "evidence_reviewer", contract: "EvidenceReviewDecision", subjectType: "conflict", actorField: "reviewer_id" }),
  create_release_draft: Object.freeze({ role: "evidence_publisher", contract: "EvidenceReleaseRecord", status: "draft", actorField: "created_by" }),
  publish_release: Object.freeze({ role: "evidence_publisher", contract: "EvidenceReleaseRecord", status: "published", actorField: "published_by" }),
  request_rollback: Object.freeze({ role: "evidence_rollback_operator", contract: "EvidenceRollbackRecord", status: "pending_confirmation", actorField: "requested_by" }),
  read_review_workspace: Object.freeze({ roles: ["evidence_reviewer", "evidence_auditor"], contract: null, actorField: null }),
  read_audit_log: Object.freeze({ roles: ["evidence_auditor"], contract: null, actorField: null }),
  prepare_audit_restore: Object.freeze({ roles: ["evidence_rollback_operator"], contract: null, actorField: null }),
});

function validationDetail(errors = []) {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

export function validateEvidenceReviewerPrincipal(value) {
  const valid = validatePrincipal(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : (validatePrincipal.errors ?? []).map((error) => ({
      instance_path: error.instancePath || "/",
      keyword: error.keyword,
      message: error.message,
      params: error.params,
    })),
  };
}

export function assertEvidenceReviewerPrincipal(value) {
  const result = validateEvidenceReviewerPrincipal(value);
  if (!result.valid) throw new Error(`EVIDENCE_REVIEW_PRINCIPAL_INVALID: ${validationDetail(result.errors)}`);
  return value;
}

export function authorizeEvidenceReviewOperation({ principal, operation, scopeId, reviewContext, at }) {
  assertEvidenceReviewerPrincipal(principal);
  const policy = operationPolicy[operation];
  if (!policy) throw new Error("EVIDENCE_REVIEW_OPERATION_UNKNOWN");
  if (principal.status !== "active") throw new Error("EVIDENCE_REVIEW_PRINCIPAL_REVOKED");
  if (principal.review_context !== reviewContext) throw new Error("EVIDENCE_REVIEW_CONTEXT_MISMATCH");
  if (!principal.scope_ids.includes(scopeId)) throw new Error("EVIDENCE_REVIEW_SCOPE_FORBIDDEN");
  const atTime = Date.parse(at);
  if (!Number.isFinite(atTime)
    || Date.parse(principal.authenticated_at) > atTime
    || Date.parse(principal.expires_at) <= atTime) {
    throw new Error("EVIDENCE_REVIEW_SESSION_INVALID");
  }
  const allowedRoles = policy.roles ?? [policy.role];
  if (!allowedRoles.some((role) => principal.roles.includes(role))) throw new Error("EVIDENCE_REVIEW_OPERATION_FORBIDDEN");
  return Object.freeze({
    authorized: true,
    principal_id: principal.principal_id,
    operation,
    review_context: reviewContext,
    scope_id: scopeId,
  });
}

export function assertAuthorizedEvidenceRecord({ principal, operation, scopeId, reviewContext, at, record }) {
  const authorization = authorizeEvidenceReviewOperation({ principal, operation, scopeId, reviewContext, at });
  const policy = operationPolicy[operation];
  if (!policy.contract) throw new Error("EVIDENCE_REVIEW_RECORD_UNEXPECTED");
  assertReviewContract(policy.contract, record, record?.decision_id ?? record?.release_id ?? record?.rollback_id);
  if (record[policy.actorField] !== principal.principal_id) throw new Error("EVIDENCE_REVIEW_ACTOR_MISMATCH");
  if (policy.subjectType && record.subject_type !== policy.subjectType) throw new Error("EVIDENCE_REVIEW_SUBJECT_MISMATCH");
  if (policy.status && record.status !== policy.status) throw new Error("EVIDENCE_REVIEW_STATUS_MISMATCH");
  if (policy.contract === "EvidenceReviewDecision" && record.review_context !== reviewContext) {
    throw new Error("EVIDENCE_REVIEW_CONTEXT_MISMATCH");
  }
  if (policy.contract === "EvidenceReleaseRecord" && record.input_mode !== reviewContext) {
    throw new Error("EVIDENCE_REVIEW_CONTEXT_MISMATCH");
  }
  if (["publish_release", "request_rollback"].includes(operation) && reviewContext !== "production") {
    throw new Error("SYNTHETIC_EVIDENCE_MUTATION_FORBIDDEN");
  }
  return authorization;
}

export function reviewOperationContract(operation) {
  const policy = operationPolicy[operation];
  if (!policy) throw new Error("EVIDENCE_REVIEW_OPERATION_UNKNOWN");
  return policy.contract;
}

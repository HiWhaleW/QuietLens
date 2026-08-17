import { assertAnalyticsEvent } from "./eventContract.js";
import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_STORE_VERSION,
  EVENT_SCHEMA_VERSION,
} from "../contracts/schemas.js";

function safeId(prefix) {
  return `${prefix}-${crypto.randomUUID().toLowerCase()}`;
}

export function getSessionId() {
  const existing = sessionStorage.getItem("quietlens_session_id");
  if (existing) return existing;
  const sessionId = safeId("sess");
  sessionStorage.setItem("quietlens_session_id", sessionId);
  return sessionId;
}

export function createRequestId() {
  return safeId("req");
}

export function createAnalyticsEmitter({ sessionId, getVersions }) {
  return async function emit(eventName, stage, properties = {}, errorCode = null) {
    const at = new Date().toISOString();
    const versions = getVersions();
    const event = assertAnalyticsEvent({
      event_name: eventName,
      event_schema_version: EVENT_SCHEMA_VERSION,
      session_id: sessionId,
      request_id: versions.request_id,
      experience_stage: stage,
      model_version: versions.model ?? "not-invoked",
      prompt_version: versions.prompt ?? "not-invoked",
      contract_schema_version: CONTRACT_SCHEMA_VERSION,
      evidence_store_version: EVIDENCE_STORE_VERSION,
      client_at: at,
      server_at: at,
      error_code: errorCode,
      properties,
    });
    try {
      await fetch("/api/analytics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        keepalive: true,
      });
    } catch {
      // Analytics must never block the decision workflow.
    }
  };
}


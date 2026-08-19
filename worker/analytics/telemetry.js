import { assertAnalyticsEvent } from "../../src/ai-native/analytics/eventContract.js";
import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_STORE_VERSION,
  EVENT_SCHEMA_VERSION,
} from "../../src/ai-native/contracts/schemas.js";

export function analyticsEvent({
  eventName,
  sessionId,
  requestId,
  stage = "system",
  modelVersion = "not-invoked",
  promptVersion = "not-invoked",
  clientAt = new Date().toISOString(),
  serverAt = new Date().toISOString(),
  errorCode = null,
  properties = {},
}) {
  return assertAnalyticsEvent({
    event_name: eventName,
    event_schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    request_id: requestId,
    experience_stage: stage,
    model_version: modelVersion,
    prompt_version: promptVersion,
    contract_schema_version: CONTRACT_SCHEMA_VERSION,
    evidence_store_version: EVIDENCE_STORE_VERSION,
    client_at: clientAt,
    server_at: serverAt,
    error_code: errorCode,
    properties,
  });
}

export async function emitAnalyticsEvent(env, event) {
  const validated = assertAnalyticsEvent(event);
  if (env.QUIETLENS_ANALYTICS_SINK?.write) {
    await env.QUIETLENS_ANALYTICS_SINK.write(validated);
    return;
  }
  console.log(JSON.stringify({ type: "quietlens_analytics", event: validated }));
}


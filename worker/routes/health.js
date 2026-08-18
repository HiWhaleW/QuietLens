import { validateEvidenceStore } from "../../src/ai-native/evidence/validateStore.js";
import { isHeaderSafeApiKey } from "../ai/deepseekResponsesClient.js";
import { jsonResponse } from "./http.js";

export function routeHealthRequest(request, env) {
  if (new URL(request.url).pathname !== "/api/health") return null;
  if (!["GET", "HEAD"].includes(request.method)) {
    return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  }
  const evidenceReady = validateEvidenceStore(env.QUIETLENS_EVIDENCE_STORE).valid;
  const modelReady = typeof env.QUIETLENS_MODEL_CLIENT?.callStructured === "function"
    || isHeaderSafeApiKey(env.DEEPSEEK_API_KEY);
  const ready = evidenceReady && modelReady;
  return jsonResponse({
    status: ready ? "ready" : "degraded",
    checks: {
      evidence_store: evidenceReady ? "ready" : "unavailable",
      model: modelReady ? "ready" : "unavailable",
    },
  }, ready ? 200 : 503);
}

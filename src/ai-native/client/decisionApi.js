export class DecisionApiError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "DecisionApiError";
    this.code = code;
    this.status = status;
  }
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({ error: { code: "RESPONSE_INVALID" } }));
  if (!response.ok) throw new DecisionApiError(result.error?.code ?? "REQUEST_FAILED", response.status);
  return result.data;
}

export function interpretDecision(payload) {
  return post("/api/decision/interpret", payload);
}

export function recommendDecision(payload) {
  return post("/api/decision/recommend", payload);
}

export function correctDecision(payload) {
  return post("/api/decision/correct", payload);
}


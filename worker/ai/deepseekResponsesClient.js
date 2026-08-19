const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";
const DEFAULT_TIMEOUT_MS = 7000;

export function isHeaderSafeApiKey(value) {
  return typeof value === "string" && value.length > 0 && /^[\x21-\x7e]+$/.test(value);
}

export class ModelCallError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ModelCallError";
    this.code = code;
    this.details = details;
  }
}

function structuredOutputSchema(schema) {
  if (Array.isArray(schema)) return schema.map(structuredOutputSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result = {};
  const unsupported = new Set([
    "$id",
    "$schema",
    "title",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "uniqueItems",
    "allOf",
    "if",
    "then",
    "else",
  ]);
  for (const [key, value] of Object.entries(schema)) {
    if (!unsupported.has(key)) result[key] = structuredOutputSchema(value);
  }
  if (!("type" in result) && !("anyOf" in result) && !("$ref" in result)) {
    const values = "const" in result ? [result.const] : result.enum;
    if (Array.isArray(values) && values.length > 0) {
      const types = [...new Set(values.map((value) => (
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value
      )))];
      if (types.every((type) => ["null", "array", "object", "string", "number", "boolean"].includes(type))) {
        result.type = types.length === 1 ? types[0] : types;
      }
    }
  }
  return result;
}

function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "refusal") {
        throw new ModelCallError("MODEL_REFUSAL", "The model refused the structured request");
      }
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

export function createDeepSeekResponsesClient(env, fetchImpl = fetch) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      async callStructured() {
        throw new ModelCallError("MODEL_NOT_CONFIGURED", "DEEPSEEK_API_KEY is not configured");
      },
    };
  }
  if (!isHeaderSafeApiKey(apiKey)) {
    return {
      async callStructured() {
        throw new ModelCallError("MODEL_CREDENTIAL_INVALID", "DEEPSEEK_API_KEY is not a valid HTTP header value");
      },
    };
  }

  return {
    async callStructured({
      model,
      instructions,
      input,
      schema,
      schemaName,
      maxOutputTokens = 1800,
      reasoningEffort = "none",
      timeoutMs = DEFAULT_TIMEOUT_MS,
    }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetchImpl(DEEPSEEK_RESPONSES_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              store: false,
              instructions,
              input,
              reasoning: { effort: reasoningEffort },
              max_output_tokens: maxOutputTokens,
              text: {
                format: {
                  type: "json_schema",
                  name: schemaName,
                  strict: true,
                  schema: structuredOutputSchema(schema),
                },
              },
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error.name === "AbortError") throw new ModelCallError("MODEL_TIMEOUT", "Model request timed out");
          throw new ModelCallError("MODEL_NETWORK_ERROR", "Model request failed", error.message);
        }

        if (!response.ok) {
          const requestId = response.headers.get("x-request-id");
          const providerError = await response.json().catch(() => null);
          throw new ModelCallError("MODEL_UPSTREAM_ERROR", `Model request returned ${response.status}`, {
            status: response.status,
            request_id: requestId,
            provider_code: providerError?.error?.code ?? null,
            provider_message: providerError?.error?.message ?? null,
          });
        }
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          if (controller.signal.aborted || error.name === "AbortError") {
            throw new ModelCallError("MODEL_TIMEOUT", "Model request timed out");
          }
          throw new ModelCallError("MODEL_RESPONSE_INVALID", "Model response was not valid JSON");
        }
        if (payload.status === "failed") {
          throw new ModelCallError("MODEL_UPSTREAM_ERROR", "Model response failed", payload.error ?? null);
        }
        if (payload.status === "incomplete") {
          throw new ModelCallError("MODEL_INCOMPLETE", "Model output was incomplete", {
            incomplete_details: payload.incomplete_details ?? null,
            usage: payload.usage ?? null,
            response_id: payload.id ?? null,
          });
        }
        const text = outputText(payload);
        if (!text) throw new ModelCallError("MODEL_OUTPUT_MISSING", "Structured model output was missing");
        try {
          return {
            value: JSON.parse(text),
            usage: payload.usage ?? null,
            response_id: payload.id ?? null,
          };
        } catch {
          throw new ModelCallError("MODEL_OUTPUT_INVALID_JSON", "Structured model output was not valid JSON", {
            usage: payload.usage ?? null,
            response_id: payload.id ?? null,
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

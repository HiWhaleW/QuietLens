const MAX_JSON_BYTES = 16_384;

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function readJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw Object.assign(new Error("CONTENT_TYPE_INVALID"), { status: 415 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("JSON_INVALID"), { status: 400 });
  }
}

export function sameOriginAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}


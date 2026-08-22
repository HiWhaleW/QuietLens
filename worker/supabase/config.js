const PROJECT_HOST_PATTERN = /^[a-z0-9-]+\.supabase\.co$/u;
const SCOPE_ID_PATTERN = /^evidence-[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/u;

export function normalizeSupabaseProjectUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.pathname !== "/"
      || url.search
      || url.hash
      || !PROJECT_HOST_PATTERN.test(url.hostname)) {
      throw new Error("SUPABASE_PROJECT_URL_INVALID");
    }
    return url.origin;
  } catch {
    throw new Error("SUPABASE_PROJECT_URL_INVALID");
  }
}

export function assertSupabaseServiceRoleKey(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY_INVALID");
  }
  return value;
}

export function assertEvidenceScopeId(value) {
  if (typeof value !== "string" || !SCOPE_ID_PATTERN.test(value)) {
    throw new Error("SUPABASE_EVIDENCE_SCOPE_INVALID");
  }
  return value;
}

export function supabaseServiceHeaders(serviceRoleKey, extras = {}) {
  const key = assertSupabaseServiceRoleKey(serviceRoleKey);
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    ...extras,
  };
}

import { normalizeSupabaseProjectUrl } from "./config.js";

const SUPPORTED_ALGORITHMS = new Set(["ES256", "RS256"]);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const DEFAULT_JWKS_TTL_MS = 300_000;

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("SUPABASE_TOKEN_INVALID");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("SUPABASE_TOKEN_INVALID");
  }
}

function decodeJson(value) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  } catch {
    throw new Error("SUPABASE_TOKEN_INVALID");
  }
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(authorization);
  if (!match || match[1].length > 8192) throw new Error("SUPABASE_TOKEN_MISSING");
  return match[1];
}

function importAlgorithm(jwk, algorithm) {
  if (algorithm === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") {
    return { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } };
  }
  if (algorithm === "RS256" && jwk.kty === "RSA") {
    return { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } };
  }
  throw new Error("SUPABASE_TOKEN_ALGORITHM_FORBIDDEN");
}

function assertClaims(claims, projectUrl, nowSeconds) {
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `${projectUrl}/auth/v1`
    || !audience.includes("authenticated")
    || claims.role !== "authenticated"
    || claims.aal !== "aal2"
    || !UUID_PATTERN.test(claims.sub ?? "")
    || !UUID_PATTERN.test(claims.session_id ?? "")
    || !Number.isInteger(claims.iat)
    || !Number.isInteger(claims.exp)
    || claims.iat > nowSeconds + 60
    || claims.exp <= nowSeconds) {
    throw new Error("SUPABASE_TOKEN_CLAIMS_INVALID");
  }
  return claims;
}

export function createSupabaseJwtVerifier({
  projectUrl,
  fetcher = globalThis.fetch,
  now = () => Date.now(),
  jwksTtlMs = DEFAULT_JWKS_TTL_MS,
}) {
  const origin = normalizeSupabaseProjectUrl(projectUrl);
  if (typeof fetcher !== "function") throw new Error("SUPABASE_FETCH_UNAVAILABLE");
  let cached = null;

  async function loadJwks(force = false) {
    const currentTime = now();
    if (!force && cached && currentTime < cached.expiresAt) return cached.keys;
    let response;
    try {
      response = await fetcher(`${origin}/auth/v1/.well-known/jwks.json`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
    } catch {
      throw new Error("SUPABASE_JWKS_UNAVAILABLE");
    }
    if (!response?.ok) throw new Error("SUPABASE_JWKS_UNAVAILABLE");
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("SUPABASE_JWKS_UNAVAILABLE");
    }
    if (!Array.isArray(body?.keys) || body.keys.length < 1 || body.keys.length > 10) {
      throw new Error("SUPABASE_JWKS_INVALID");
    }
    cached = { keys: body.keys, expiresAt: currentTime + jwksTtlMs };
    return cached.keys;
  }

  async function matchingKey(header) {
    if (typeof header.kid !== "string" || !SUPPORTED_ALGORITHMS.has(header.alg)) {
      throw new Error("SUPABASE_TOKEN_ALGORITHM_FORBIDDEN");
    }
    let keys = await loadJwks();
    let jwk = keys.find((item) => item.kid === header.kid && item.alg === header.alg && item.use === "sig");
    if (!jwk) {
      keys = await loadJwks(true);
      jwk = keys.find((item) => item.kid === header.kid && item.alg === header.alg && item.use === "sig");
    }
    if (!jwk) throw new Error("SUPABASE_TOKEN_KEY_NOT_FOUND");
    return jwk;
  }

  return Object.freeze({
    async verifyRequest(request) {
      const token = bearerToken(request);
      const segments = token.split(".");
      const header = decodeJson(segments[0]);
      const claims = decodeJson(segments[1]);
      const jwk = await matchingKey(header);
      const algorithm = importAlgorithm(jwk, header.alg);
      let key;
      try {
        key = await crypto.subtle.importKey("jwk", jwk, algorithm.import, false, ["verify"]);
      } catch {
        throw new Error("SUPABASE_JWKS_INVALID");
      }
      const verified = await crypto.subtle.verify(
        algorithm.verify,
        key,
        decodeBase64Url(segments[2]),
        new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
      );
      if (!verified) throw new Error("SUPABASE_TOKEN_SIGNATURE_INVALID");
      return assertClaims(claims, origin, Math.floor(now() / 1000));
    },
  });
}

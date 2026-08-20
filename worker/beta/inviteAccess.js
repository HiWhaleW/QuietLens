const MANIFEST_VERSION = "1.0.0";
const SESSION_VERSION = "1.0.0";
export const BETA_INVITATION_COUNT = 3;
const COOKIE_NAME = "ql_beta_session";
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const ID_PATTERN = /^beta-(?:invite|participant)-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

class BetaAccessError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new BetaAccessError("BETA_SESSION_INVALID");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeUtf8Base64Url(value) {
  return new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value));
}

async function importHmacKey(secret, usages) {
  return globalThis.crypto.subtle.importKey(
    "raw",
    encodeUtf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function hmacBytes(secret, value) {
  const key = await importHmacKey(secret, ["sign"]);
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, encodeUtf8(value)));
}

async function verifyHmac(secret, value, signature) {
  const key = await importHmacKey(secret, ["verify"]);
  return globalThis.crypto.subtle.verify("HMAC", key, signature, encodeUtf8(value));
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function assertSecret(value) {
  if (typeof value !== "string" || encodeUtf8(value).byteLength < 32 || value.length > 512) {
    throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
  }
  return value;
}

function parseTtl(value) {
  if (value === undefined || value === "") return DEFAULT_TTL_SECONDS;
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
  }
  return ttl;
}

function assertExactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
  }
}

export function isBetaAccessEnabled(env) {
  return env?.QL_BETA_INVITE_ENABLED === "true";
}

export function parseBetaAccessConfig(env) {
  if (!isBetaAccessEnabled(env)) return Object.freeze({ enabled: false });

  let manifest;
  try {
    manifest = JSON.parse(env?.QL_BETA_INVITE_MANIFEST_JSON ?? "");
  } catch {
    throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
  }
  assertExactKeys(manifest, ["schema_version", "invitations"]);
  if (manifest.schema_version !== MANIFEST_VERSION
    || !Array.isArray(manifest.invitations)
    || manifest.invitations.length !== BETA_INVITATION_COUNT) {
    throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
  }

  const inviteIds = new Set();
  const participantIds = new Set();
  const digests = new Set();
  const invitations = manifest.invitations.map((invitation) => {
    assertExactKeys(invitation, ["invite_id", "participant_id", "code_digest", "status"]);
    if (!ID_PATTERN.test(invitation.invite_id ?? "")
      || !ID_PATTERN.test(invitation.participant_id ?? "")
      || !DIGEST_PATTERN.test(invitation.code_digest ?? "")
      || !["active", "revoked"].includes(invitation.status)) {
      throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
    }
    if (inviteIds.has(invitation.invite_id)
      || participantIds.has(invitation.participant_id)
      || digests.has(invitation.code_digest)) {
      throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");
    }
    inviteIds.add(invitation.invite_id);
    participantIds.add(invitation.participant_id);
    digests.add(invitation.code_digest);
    return Object.freeze({ ...invitation });
  });

  const inviteSecret = assertSecret(env.QL_BETA_INVITE_SECRET);
  const sessionSecret = assertSecret(env.QL_BETA_SESSION_SECRET);
  if (inviteSecret === sessionSecret) throw new BetaAccessError("BETA_ACCESS_CONFIG_INVALID");

  return Object.freeze({
    enabled: true,
    inviteSecret,
    sessionSecret,
    ttlSeconds: parseTtl(env.QL_BETA_SESSION_TTL_SECONDS),
    invitations: Object.freeze(invitations),
  });
}

export function betaAccessHealth(env) {
  if (!isBetaAccessEnabled(env)) return Object.freeze({ ready: true, status: "disabled" });
  try {
    parseBetaAccessConfig(env);
    return Object.freeze({ ready: true, status: "ready" });
  } catch {
    return Object.freeze({ ready: false, status: "unavailable" });
  }
}

export async function hashBetaInviteCode(code, secret) {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw new BetaAccessError("BETA_INVITE_INVALID");
  return bytesToHex(await hmacBytes(assertSecret(secret), code));
}

function constantTimeHexEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function redeemBetaInvite(code, config) {
  let digest;
  try {
    digest = await hashBetaInviteCode(code, config.inviteSecret);
  } catch {
    throw new BetaAccessError("BETA_INVITE_INVALID");
  }
  const invitation = config.invitations.find((candidate) => constantTimeHexEqual(candidate.code_digest, digest));
  if (!invitation || invitation.status !== "active") throw new BetaAccessError("BETA_INVITE_INVALID");
  return invitation;
}

export async function createBetaSession(invitation, config, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = {
    version: SESSION_VERSION,
    invite_id: invitation.invite_id,
    participant_id: invitation.participant_id,
    issued_at: issuedAt,
    expires_at: issuedAt + config.ttlSeconds,
  };
  const encodedPayload = bytesToBase64Url(encodeUtf8(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmacBytes(config.sessionSecret, encodedPayload));
  return Object.freeze({ token: `${encodedPayload}.${signature}`, payload });
}

function parseCookies(request) {
  const result = new Map();
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return result;
}

export async function verifyBetaSessionToken(token, config, nowMs = Date.now()) {
  try {
    const [payloadPart, signaturePart, extra] = String(token ?? "").split(".");
    if (!payloadPart || !signaturePart || extra) throw new BetaAccessError("BETA_SESSION_INVALID");
    const signature = base64UrlToBytes(signaturePart);
    if (!await verifyHmac(config.sessionSecret, payloadPart, signature)) throw new BetaAccessError("BETA_SESSION_INVALID");
    const payload = JSON.parse(decodeUtf8Base64Url(payloadPart));
    assertExactKeys(payload, ["version", "invite_id", "participant_id", "issued_at", "expires_at"]);
    const now = Math.floor(nowMs / 1000);
    if (payload.version !== SESSION_VERSION
      || !ID_PATTERN.test(payload.invite_id ?? "")
      || !ID_PATTERN.test(payload.participant_id ?? "")
      || !Number.isSafeInteger(payload.issued_at)
      || !Number.isSafeInteger(payload.expires_at)
      || payload.issued_at > now + 60
      || payload.expires_at <= now
      || payload.expires_at - payload.issued_at > config.ttlSeconds) {
      throw new BetaAccessError("BETA_SESSION_INVALID");
    }
    const invitation = config.invitations.find((candidate) => candidate.invite_id === payload.invite_id);
    if (!invitation || invitation.status !== "active" || invitation.participant_id !== payload.participant_id) {
      throw new BetaAccessError("BETA_SESSION_INVALID");
    }
    return Object.freeze(payload);
  } catch (error) {
    if (error instanceof BetaAccessError) throw error;
    throw new BetaAccessError("BETA_SESSION_INVALID");
  }
}

export async function authenticateBetaRequest(request, config, nowMs = Date.now()) {
  return verifyBetaSessionToken(parseCookies(request).get(COOKIE_NAME), config, nowMs);
}

export function betaSessionCookie(token, ttlSeconds) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSeconds}`;
}

export function clearBetaSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

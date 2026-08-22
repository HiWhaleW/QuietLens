import { createClient } from "@supabase/supabase-js";

const OFFICIAL_PROJECT_HOST = /^[a-z0-9]+\.supabase\.co$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TOTP_PATTERN = /^\d{6}$/u;

function decodeJwtPayload(value) {
  try {
    const [, payload] = value.split(".");
    if (!payload) return null;
    const padding = "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/") + padding));
  } catch {
    return null;
  }
}

export function normalizeReviewerSupabaseConfig({ projectUrl, publishableKey }) {
  let url;
  try {
    url = new URL(projectUrl);
  } catch {
    throw new Error("REVIEWER_AUTH_CONFIG_INVALID");
  }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !OFFICIAL_PROJECT_HOST.test(url.hostname)) {
    throw new Error("REVIEWER_AUTH_CONFIG_INVALID");
  }
  if (typeof publishableKey !== "string"
    || publishableKey.length < 20
    || publishableKey.length > 4096
    || /[\s\u0000-\u001f]/u.test(publishableKey)
    || publishableKey.startsWith("sb_secret_")) {
    throw new Error("REVIEWER_AUTH_CONFIG_INVALID");
  }
  if (!publishableKey.startsWith("sb_publishable_")) {
    const payload = decodeJwtPayload(publishableKey);
    if (payload?.role !== "anon") throw new Error("REVIEWER_AUTH_CONFIG_INVALID");
  }
  return Object.freeze({ project_url: url.origin, publishable_key: publishableKey });
}

export function createReviewerSupabaseClient(config, options = {}) {
  const normalized = normalizeReviewerSupabaseConfig(config);
  return createClient(normalized.project_url, normalized.publishable_key, {
    ...options,
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
      ...options.auth,
    },
  });
}

function failIfProviderError(error, code) {
  if (error) throw new Error(code);
}

function verifiedTotpFactors(data) {
  const factors = Array.isArray(data?.totp) ? data.totp : [];
  return factors.filter((factor) => factor?.factor_type === "totp" && factor?.status === "verified");
}

export async function readReviewerAuthState(client) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  failIfProviderError(sessionError, "REVIEWER_AUTH_SESSION_FAILED");
  if (!sessionData?.session) return Object.freeze({ status: "signed_out" });

  const [{ data: assuranceData, error: assuranceError }, { data: factorData, error: factorError }] = await Promise.all([
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
    client.auth.mfa.listFactors(),
  ]);
  failIfProviderError(assuranceError, "REVIEWER_AUTH_ASSURANCE_FAILED");
  failIfProviderError(factorError, "REVIEWER_AUTH_FACTORS_FAILED");
  if (assuranceData?.currentLevel === "aal2") {
    return Object.freeze({ status: "ready_aal2" });
  }
  const factors = verifiedTotpFactors(factorData);
  if (factors.length > 0) {
    return Object.freeze({ status: "challenge_required", factor_id: factors[0].id });
  }
  return Object.freeze({ status: "enrollment_required" });
}

export async function signInReviewer(client, { email, password }) {
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email) || typeof password !== "string" || password.length < 1) {
    throw new Error("REVIEWER_AUTH_CREDENTIALS_INVALID");
  }
  const { error } = await client.auth.signInWithPassword({ email, password });
  failIfProviderError(error, "REVIEWER_AUTH_SIGN_IN_FAILED");
  return readReviewerAuthState(client);
}

export async function updateReviewerPassword(client, password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("REVIEWER_AUTH_PASSWORD_INVALID");
  }
  const { error } = await client.auth.updateUser({ password });
  failIfProviderError(error, "REVIEWER_AUTH_PASSWORD_UPDATE_FAILED");
  return Object.freeze({ updated: true });
}

export async function enrollReviewerTotp(client) {
  const { data, error } = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "QuietLens Evidence Review",
  });
  failIfProviderError(error, "REVIEWER_AUTH_ENROLL_FAILED");
  if (!data?.id || data?.type !== "totp" || typeof data?.totp?.qr_code !== "string") {
    throw new Error("REVIEWER_AUTH_ENROLL_FAILED");
  }
  return Object.freeze({ factor_id: data.id, qr_code: data.totp.qr_code });
}

export async function verifyReviewerTotp(client, { factorId, code }) {
  if (typeof factorId !== "string" || factorId.length < 1 || !TOTP_PATTERN.test(code ?? "")) {
    throw new Error("REVIEWER_AUTH_TOTP_INVALID");
  }
  const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId });
  failIfProviderError(challengeError, "REVIEWER_AUTH_CHALLENGE_FAILED");
  if (!challengeData?.id) throw new Error("REVIEWER_AUTH_CHALLENGE_FAILED");
  const { error: verifyError } = await client.auth.mfa.verify({
    factorId,
    challengeId: challengeData.id,
    code,
  });
  failIfProviderError(verifyError, "REVIEWER_AUTH_VERIFY_FAILED");
  const state = await readReviewerAuthState(client);
  if (state.status !== "ready_aal2") throw new Error("REVIEWER_AUTH_AAL2_REQUIRED");
  return state;
}

export async function signOutReviewer(client) {
  const { error } = await client.auth.signOut();
  failIfProviderError(error, "REVIEWER_AUTH_SIGN_OUT_FAILED");
  return Object.freeze({ status: "signed_out" });
}

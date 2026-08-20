import assert from "node:assert/strict";
import test from "node:test";

import {
  betaAccessHealth,
  createBetaSession,
  hashBetaInviteCode,
  parseBetaAccessConfig,
  redeemBetaInvite,
  verifyBetaSessionToken,
} from "../worker/beta/inviteAccess.js";
import { authorizeBetaApiRequest, routeBetaAccessRequest } from "../worker/routes/betaAccess.js";
import worker from "../worker/index.js";

const inviteSecret = "synthetic-invite-secret-00000000000000000000";
const sessionSecret = "synthetic-session-secret-0000000000000000000";

async function betaFixture(overrides = {}) {
  const codes = Array.from({ length: 3 }, (_, index) => `QUIETLENS-${String(index + 1).padStart(2, "0")}-SYNTHETIC_token`);
  const invitations = await Promise.all(codes.map(async (code, index) => ({
    invite_id: `beta-invite-${String(index + 1).padStart(2, "0")}`,
    participant_id: `beta-participant-${String(index + 1).padStart(2, "0")}`,
    code_digest: await hashBetaInviteCode(code, inviteSecret),
    status: "active",
  })));
  return {
    codes,
    env: {
      QL_BETA_INVITE_ENABLED: "true",
      QL_BETA_INVITE_SECRET: inviteSecret,
      QL_BETA_SESSION_SECRET: sessionSecret,
      QL_BETA_SESSION_TTL_SECONDS: "3600",
      QL_BETA_INVITE_MANIFEST_JSON: JSON.stringify({ schema_version: "1.0.0", invitations }),
      ...overrides,
    },
  };
}

function cookieValue(setCookie) {
  return setCookie.split(";", 1)[0];
}

test("keeps beta admission disabled by default", () => {
  assert.deepEqual(parseBetaAccessConfig({}), { enabled: false });
  assert.deepEqual(betaAccessHealth({}), { ready: true, status: "disabled" });
});

test("requires exactly three unique opaque invitations and independent secrets", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  assert.equal(config.invitations.length, 3);
  assert.equal(config.invitations.every((item) => !Object.hasOwn(item, "code")), true);

  const two = JSON.parse(fixture.env.QL_BETA_INVITE_MANIFEST_JSON);
  two.invitations.pop();
  assert.throws(() => parseBetaAccessConfig({
    ...fixture.env,
    QL_BETA_INVITE_MANIFEST_JSON: JSON.stringify(two),
  }), /BETA_ACCESS_CONFIG_INVALID/);
  assert.throws(() => parseBetaAccessConfig({
    ...fixture.env,
    QL_BETA_SESSION_SECRET: inviteSecret,
  }), /BETA_ACCESS_CONFIG_INVALID/);
});

test("redeems a synthetic invite without exposing its raw value", async () => {
  const fixture = await betaFixture();
  const request = new Request("https://quietlens.test/api/beta-access/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quietlens.test" },
    body: JSON.stringify({ code: fixture.codes[0] }),
  });
  const response = await routeBetaAccessRequest(request, fixture.env);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie");

  assert.equal(response.status, 200);
  assert.equal(body.data.authenticated, true);
  assert.match(cookie, /^ql_beta_session=[A-Za-z0-9_.-]+;/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Strict/u);
  assert.equal(JSON.stringify(body).includes(fixture.codes[0]), false);
  assert.equal(cookie.includes(fixture.codes[0]), false);
});

test("uses one generic rejection for unknown and revoked invite codes", async () => {
  const fixture = await betaFixture();
  const manifest = JSON.parse(fixture.env.QL_BETA_INVITE_MANIFEST_JSON);
  manifest.invitations[0].status = "revoked";
  const revokedEnv = { ...fixture.env, QL_BETA_INVITE_MANIFEST_JSON: JSON.stringify(manifest) };

  for (const [code, env] of [["QUIETLENS-99-NOT-VALID", fixture.env], [fixture.codes[0], revokedEnv]]) {
    const response = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quietlens.test" },
      body: JSON.stringify({ code }),
    }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: "BETA_INVITE_INVALID" } });
  }
});

test("creates an expiring signed session and invalidates it after revocation", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  const invitation = await redeemBetaInvite(fixture.codes[0], config);
  const issued = await createBetaSession(invitation, config, 1_800_000);
  const verified = await verifyBetaSessionToken(issued.token, config, 1_801_000);
  assert.equal(verified.participant_id, "beta-participant-01");
  await assert.rejects(() => verifyBetaSessionToken(issued.token, config, 5_400_000), /BETA_SESSION_INVALID/);

  const manifest = JSON.parse(fixture.env.QL_BETA_INVITE_MANIFEST_JSON);
  manifest.invitations[0].status = "revoked";
  const revoked = parseBetaAccessConfig({ ...fixture.env, QL_BETA_INVITE_MANIFEST_JSON: JSON.stringify(manifest) });
  await assert.rejects(() => verifyBetaSessionToken(issued.token, revoked, 1_801_000), /BETA_SESSION_INVALID/);
});

test("injects the server-verified participant and overwrites a spoofed header", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  const invitation = await redeemBetaInvite(fixture.codes[0], config);
  const session = await createBetaSession(invitation, config);
  const authorization = await authorizeBetaApiRequest(new Request("https://quietlens.test/api/missing", {
    headers: {
      cookie: `ql_beta_session=${session.token}`,
      "x-quietlens-beta-participant-id": "beta-participant-attacker",
    },
  }), fixture.env);

  assert.equal(authorization.allowed, true);
  assert.equal(authorization.request.headers.get("x-quietlens-beta-participant-id"), "beta-participant-01");
});

test("blocks every non-health API until a beta session is verified", async () => {
  const fixture = await betaFixture();
  const blocked = await worker.fetch(new Request("https://quietlens.test/api/missing"), fixture.env);
  assert.equal(blocked.status, 401);
  assert.deepEqual(await blocked.json(), { error: { code: "BETA_SESSION_REQUIRED" } });

  const config = parseBetaAccessConfig(fixture.env);
  const invitation = await redeemBetaInvite(fixture.codes[0], config);
  const session = await createBetaSession(invitation, config);
  const allowed = await worker.fetch(new Request("https://quietlens.test/api/missing", {
    headers: { cookie: `ql_beta_session=${session.token}` },
  }), fixture.env);
  assert.equal(allowed.status, 404);
});

test("reports a broken enabled beta configuration as unavailable", async () => {
  const fixture = await betaFixture({ QL_BETA_SESSION_SECRET: "too-short" });
  assert.deepEqual(betaAccessHealth(fixture.env), { ready: false, status: "unavailable" });

  const response = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/session"), fixture.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "BETA_ACCESS_NOT_CONFIGURED" } });
});

test("clears the beta cookie without returning invitation or participant data", async () => {
  const fixture = await betaFixture();
  const response = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/session", {
    method: "DELETE",
    headers: { origin: "https://quietlens.test" },
  }), fixture.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/u);
  assert.deepEqual(await response.json(), { data: { authenticated: false } });
});

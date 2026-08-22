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

async function betaFixture(overrides = {}, invitationCount = 3) {
  const codes = Array.from({ length: invitationCount }, (_, index) => `QUIETLENS-${String(index + 1).padStart(2, "0")}-SYNTHETIC_token`);
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
      QL_BETA_INVITATION_COUNT: String(invitationCount),
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

test("keeps the current three-invite baseline and requires the declared count", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  assert.equal(config.invitations.length, 3);
  assert.equal(config.invitationCount, 3);
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

test("accepts exactly twenty independent invitations for Stage 3 and rejects count drift", async () => {
  const fixture = await betaFixture({}, 20);
  const config = parseBetaAccessConfig(fixture.env);
  assert.equal(config.invitationCount, 20);
  assert.equal(config.invitations.length, 20);
  assert.equal(new Set(config.invitations.map(({ invite_id }) => invite_id)).size, 20);
  assert.equal(new Set(config.invitations.map(({ participant_id }) => participant_id)).size, 20);

  for (const declaredCount of ["19", "21", "0", "not-a-number"]) {
    assert.throws(() => parseBetaAccessConfig({
      ...fixture.env,
      QL_BETA_INVITATION_COUNT: declaredCount,
    }), /BETA_ACCESS_CONFIG_INVALID/);
  }
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

test("keeps all three participant sessions isolated and revokes only the selected invitation", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  const sessions = await Promise.all(config.invitations.map(async (invitation) => createBetaSession(invitation, config)));

  for (const [index, session] of sessions.entries()) {
    const nextParticipant = `beta-participant-${String((index + 1) % 3 + 1).padStart(2, "0")}`;
    const authorization = await authorizeBetaApiRequest(new Request("https://quietlens.test/api/missing", {
      headers: {
        cookie: `ql_beta_session=${session.token}`,
        "x-quietlens-beta-participant-id": nextParticipant,
      },
    }), fixture.env);
    assert.equal(authorization.allowed, true);
    assert.equal(
      authorization.request.headers.get("x-quietlens-beta-participant-id"),
      `beta-participant-${String(index + 1).padStart(2, "0")}`,
    );
  }

  const manifest = JSON.parse(fixture.env.QL_BETA_INVITE_MANIFEST_JSON);
  manifest.invitations[0].status = "revoked";
  const revokedEnv = { ...fixture.env, QL_BETA_INVITE_MANIFEST_JSON: JSON.stringify(manifest) };
  const authorizations = await Promise.all(sessions.map((session) => authorizeBetaApiRequest(
    new Request("https://quietlens.test/api/missing", {
      headers: { cookie: `ql_beta_session=${session.token}` },
    }),
    revokedEnv,
  )));
  assert.deepEqual(authorizations.map(({ allowed }) => allowed), [false, true, true]);
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

test("deletes only the authenticated participant's minimum beta data and returns a privacy-minimized receipt", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  const records = new Map(config.invitations.map((invitation, index) => [
    invitation.participant_id,
    [
      { type: "session" },
      { type: "decision_request" },
      { type: "analytics_event" },
      ...(index === 0 ? [{ type: "feedback_record" }, { type: "cost_observation" }] : []),
    ],
  ]));
  const store = {
    async deleteParticipantData(participantId) {
      const participantRecords = records.get(participantId) ?? [];
      const counts = {
        session_record_count: participantRecords.filter(({ type }) => type === "session").length,
        decision_request_count: participantRecords.filter(({ type }) => type === "decision_request").length,
        analytics_event_count: participantRecords.filter(({ type }) => type === "analytics_event").length,
        feedback_record_count: participantRecords.filter(({ type }) => type === "feedback_record").length,
        cost_observation_count: participantRecords.filter(({ type }) => type === "cost_observation").length,
      };
      records.set(participantId, []);
      return counts;
    },
    async countParticipantData(participantId) {
      return (records.get(participantId) ?? []).length;
    },
  };
  const session = await createBetaSession(config.invitations[0], config);
  const response = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/data", {
    method: "DELETE",
    headers: {
      origin: "https://quietlens.test",
      cookie: `ql_beta_session=${session.token}`,
      "x-quietlens-beta-participant-id": "beta-participant-02",
    },
  }), { ...fixture.env, QUIETLENS_BETA_DATA_STORE: store });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/u);
  assert.equal(body.data.deleted, true);
  assert.equal(body.data.deleted_record_count, 5);
  assert.equal(body.data.remaining_record_count, 0);
  assert.equal(JSON.stringify(body).includes("participant"), false);
  assert.equal(records.get("beta-participant-01").length, 0);
  assert.equal(records.get("beta-participant-02").length, 3);
  assert.equal(records.get("beta-participant-03").length, 3);

  const retry = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/data", {
    method: "DELETE",
    headers: { origin: "https://quietlens.test", cookie: `ql_beta_session=${session.token}` },
  }), { ...fixture.env, QUIETLENS_BETA_DATA_STORE: store });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.data.deleted_record_count, 0);
  assert.equal(retryBody.data.remaining_record_count, 0);
});

test("fails minimum-data deletion closed when the durable store is absent or leaves records behind", async () => {
  const fixture = await betaFixture();
  const config = parseBetaAccessConfig(fixture.env);
  const session = await createBetaSession(config.invitations[0], config);
  const request = () => new Request("https://quietlens.test/api/beta-access/data", {
    method: "DELETE",
    headers: { origin: "https://quietlens.test", cookie: `ql_beta_session=${session.token}` },
  });

  const crossOrigin = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/data", {
    method: "DELETE",
    headers: { origin: "https://attacker.test", cookie: `ql_beta_session=${session.token}` },
  }), fixture.env);
  assert.equal(crossOrigin.status, 403);

  const unauthenticated = await routeBetaAccessRequest(new Request("https://quietlens.test/api/beta-access/data", {
    method: "DELETE",
    headers: { origin: "https://quietlens.test" },
  }), fixture.env);
  assert.equal(unauthenticated.status, 401);

  const missing = await routeBetaAccessRequest(request(), fixture.env);
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: { code: "BETA_DATA_STORE_NOT_CONFIGURED" } });
  assert.equal(missing.headers.has("set-cookie"), false);

  const incomplete = await routeBetaAccessRequest(request(), {
    ...fixture.env,
    QUIETLENS_BETA_DATA_STORE: {
      async deleteParticipantData() {
        return {
          session_record_count: 1,
          decision_request_count: 1,
          analytics_event_count: 1,
          feedback_record_count: 0,
          cost_observation_count: 0,
        };
      },
      async countParticipantData() { return 1; },
    },
  });
  assert.equal(incomplete.status, 409);
  assert.deepEqual(await incomplete.json(), { error: { code: "BETA_DATA_DELETION_INCOMPLETE" } });
  assert.equal(incomplete.headers.has("set-cookie"), false);
});

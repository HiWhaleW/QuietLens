#!/usr/bin/env node
import { randomBytes, createHmac } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = process.argv.find((value) => value.startsWith("--output="))?.slice(9);
if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error("ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED");
const existingDirectory = process.argv.find((value) => value.startsWith("--extend-from="))?.slice(14);
if (existingDirectory && !path.isAbsolute(existingDirectory)) throw new Error("ABSOLUTE_EXISTING_DIRECTORY_REQUIRED");
const countValue = process.argv.find((value) => value.startsWith("--count="))?.slice(8) ?? "20";
const invitationCount = Number(countValue);
if (!Number.isSafeInteger(invitationCount) || invitationCount < 1 || invitationCount > 20) {
  throw new Error("INVITATION_COUNT_INVALID");
}

const token = (bytes = 18) => randomBytes(bytes).toString("base64url");
const createInvitation = (index, inviteSecret) => {
  const code = `QL-${token(18)}`;
  return {
    code,
    invite_id: `beta-invite-${String(index + 1).padStart(2, "0")}`,
    participant_id: `beta-participant-${String(index + 1).padStart(2, "0")}`,
    code_digest: createHmac("sha256", inviteSecret).update(code).digest("hex"),
    status: "active",
  };
};

function parseEnvironment(source) {
  const entries = source.split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("EXISTING_ENVIRONMENT_INVALID");
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  return Object.fromEntries(entries);
}

async function loadExistingInvitations(directory) {
  const environment = parseEnvironment(await readFile(path.join(directory, "beta-environment.env"), "utf8"));
  const distribution = JSON.parse(await readFile(path.join(directory, "invite-distribution.json"), "utf8"));
  const manifest = JSON.parse(environment.QL_BETA_INVITE_MANIFEST_JSON ?? "null");
  const declaredCount = environment.QL_BETA_INVITATION_COUNT;
  const existingCount = declaredCount === undefined ? manifest?.invitations?.length : Number(declaredCount);
  if (environment.QL_BETA_INVITE_ENABLED !== "true"
    || !Number.isSafeInteger(existingCount)
    || (declaredCount !== undefined && String(existingCount) !== declaredCount)
    || existingCount < 1
    || existingCount > invitationCount
    || manifest?.schema_version !== "1.0.0"
    || distribution?.schema_version !== "1.0.0"
    || !Array.isArray(manifest.invitations)
    || !Array.isArray(distribution.invitations)
    || manifest.invitations.length !== existingCount
    || distribution.invitations.length !== existingCount
    || !environment.QL_BETA_INVITE_SECRET
    || !environment.QL_BETA_SESSION_SECRET) {
    throw new Error("EXISTING_INVITATIONS_INVALID");
  }

  const invitations = distribution.invitations.map((distributed, index) => {
    const stored = manifest.invitations[index];
    const expectedDigest = createHmac("sha256", environment.QL_BETA_INVITE_SECRET)
      .update(distributed.code)
      .digest("hex");
    if (stored?.invite_id !== distributed.invite_id
      || stored?.participant_id !== distributed.participant_id
      || stored?.code_digest !== expectedDigest
      || stored?.status !== "active") {
      throw new Error("EXISTING_INVITATIONS_INVALID");
    }
    return { ...stored, code: distributed.code };
  });

  return {
    invitations,
    inviteSecret: environment.QL_BETA_INVITE_SECRET,
    sessionSecret: environment.QL_BETA_SESSION_SECRET,
    ttlSeconds: environment.QL_BETA_SESSION_TTL_SECONDS || "28800",
  };
}

const existing = existingDirectory ? await loadExistingInvitations(existingDirectory) : null;
const inviteSecret = existing?.inviteSecret ?? token(32);
const sessionSecret = existing?.sessionSecret ?? token(32);
const preservedCount = existing?.invitations.length ?? 0;
const invitations = [...(existing?.invitations ?? [])];
for (let index = preservedCount; index < invitationCount; index += 1) {
  invitations.push(createInvitation(index, inviteSecret));
}
const manifest = {
  schema_version: "1.0.0",
  invitations: invitations.map(({ code, ...invitation }) => invitation),
};

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);
const distributionPath = path.join(outputDirectory, "invite-distribution.json");
const environmentPath = path.join(outputDirectory, "beta-environment.env");
await writeFile(distributionPath, `${JSON.stringify({ schema_version: "1.0.0", invitations: invitations.map(({ code, invite_id, participant_id }) => ({ invite_id, participant_id, code })) }, null, 2)}\n`, { mode: 0o600 });
await writeFile(environmentPath, [
  "QL_BETA_INVITE_ENABLED=true",
  `QL_BETA_INVITATION_COUNT=${invitationCount}`,
  `QL_BETA_INVITE_MANIFEST_JSON=${JSON.stringify(manifest)}`,
  `QL_BETA_INVITE_SECRET=${inviteSecret}`,
  `QL_BETA_SESSION_SECRET=${sessionSecret}`,
  `QL_BETA_SESSION_TTL_SECONDS=${existing?.ttlSeconds ?? "28800"}`,
  "",
].join("\n"), { mode: 0o600 });
await chmod(distributionPath, 0o600);
await chmod(environmentPath, 0o600);

console.log(JSON.stringify({
  generated: true,
  invitation_count: invitations.length,
  preserved_invitation_count: preservedCount,
  new_invitation_count: invitations.length - preservedCount,
  output_directory: outputDirectory,
}));

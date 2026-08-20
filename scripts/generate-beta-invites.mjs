#!/usr/bin/env node
import { randomBytes, createHmac } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = process.argv.find((value) => value.startsWith("--output="))?.slice(9);
if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error("ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED");

const token = (bytes = 18) => randomBytes(bytes).toString("base64url");
const inviteSecret = token(32);
const sessionSecret = token(32);
const invitations = Array.from({ length: 3 }, (_, index) => {
  const code = `QL-${token(18)}`;
  return {
    code,
    invite_id: `beta-invite-${String(index + 1).padStart(2, "0")}`,
    participant_id: `beta-participant-${String(index + 1).padStart(2, "0")}`,
    code_digest: createHmac("sha256", inviteSecret).update(code).digest("hex"),
    status: "active",
  };
});
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
  `QL_BETA_INVITE_MANIFEST_JSON=${JSON.stringify(manifest)}`,
  `QL_BETA_INVITE_SECRET=${inviteSecret}`,
  `QL_BETA_SESSION_SECRET=${sessionSecret}`,
  "QL_BETA_SESSION_TTL_SECONDS=28800",
  "",
].join("\n"), { mode: 0o600 });
await chmod(distributionPath, 0o600);
await chmod(environmentPath, 0o600);

console.log(JSON.stringify({ generated: true, invitation_count: invitations.length, output_directory: outputDirectory }));

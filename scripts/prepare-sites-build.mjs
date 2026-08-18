#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertEvidenceStore } from "../src/ai-native/evidence/validateStore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");
const evidenceRoot = path.join(root, "docs", "phase-3b", "evidence", "v0.1");

for (const file of [
  index,
  worker,
  hosting,
  path.join(evidenceRoot, "manifest.json"),
  path.join(evidenceRoot, "places.json"),
  path.join(evidenceRoot, "sources.json"),
  path.join(evidenceRoot, "evidence.json"),
]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

const evidenceStore = {
  manifest: JSON.parse(readFileSync(path.join(evidenceRoot, "manifest.json"), "utf8")),
  places: JSON.parse(readFileSync(path.join(evidenceRoot, "places.json"), "utf8")),
  sources: JSON.parse(readFileSync(path.join(evidenceRoot, "sources.json"), "utf8")),
  evidence: JSON.parse(readFileSync(path.join(evidenceRoot, "evidence.json"), "utf8")),
};
assertEvidenceStore(evidenceStore);

rmSync(path.join(dist, "server"), { recursive: true, force: true });
mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
mkdirSync(path.join(dist, "server", "runtime"), { recursive: true });
cpSync(path.join(root, "worker"), path.join(dist, "server", "worker"), { recursive: true });
cpSync(path.join(root, "src", "ai-native"), path.join(dist, "server", "src", "ai-native"), { recursive: true });
cpSync(hosting, path.join(dist, ".openai", "hosting.json"));
writeFileSync(
  path.join(dist, "server", "runtime", "evidenceStore.js"),
  `export default ${JSON.stringify(evidenceStore)};\n`,
);
writeFileSync(
  path.join(dist, "server", "index.js"),
  `import app from "./worker/index.js";\nimport evidenceStore from "./runtime/evidenceStore.js";\n\nexport default {\n  fetch(request, env) {\n    return app.fetch(request, { ...env, QUIETLENS_EVIDENCE_STORE: evidenceStore });\n  },\n};\n`,
);

console.log("Prepared Sites build with a validated server-only QuietLens evidence snapshot");

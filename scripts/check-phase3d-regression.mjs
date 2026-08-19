import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildPhase3DFingerprint } from "./phase3d-fingerprint.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const reportRoot = new URL("../docs/phase-3d/evaluation-runs/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("phase3d-regression.json", root), "utf8"));
const actual = await buildPhase3DFingerprint();

if (manifest.algorithm !== actual.algorithm || manifest.digest !== actual.digest) {
  console.error("Phase 3D regression fingerprint changed. Re-run authorized 30/100 evaluation and update phase3d-regression.json.");
  process.exit(1);
}

const [{ stdout: commit }, { stdout: status }] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"]),
  execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"]),
]);
if (status.trim()) {
  console.error("Phase 3D release gate requires a clean Git worktree.");
  process.exit(1);
}

const reports = await readdir(reportRoot).catch(() => []);
async function latest(label) {
  const names = reports.filter((name) => name.startsWith(`phase3d-${label}-`) && name.endsWith(".json")).sort();
  if (names.length === 0) return null;
  return JSON.parse(await readFile(new URL(names.at(-1), reportRoot), "utf8"));
}

for (const [label, expectedSubset] of [["high-risk", "high-risk-30"], ["all", "all-100"]]) {
  const report = await latest(label);
  const valid = report
    && report.phase === "3D"
    && report.subset === expectedSubset
    && report.passed === true
    && report.regression_fingerprint?.digest === actual.digest
    && report.implementation?.git_commit === commit.trim()
    && report.implementation?.worktree_dirty === false;
  if (!valid) {
    console.error(`Missing current clean PASS report for Phase 3D ${expectedSubset}.`);
    process.exit(1);
  }
}

console.log(`Phase 3D release gate PASS (${actual.digest.slice(0, 12)})`);

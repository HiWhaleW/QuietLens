import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(new URL("../src/ai-native/ui/QuietLensDecisionApp.jsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/ai-native/client/decisionApi.js", import.meta.url), "utf8");
const service = await readFile(new URL("../worker/services/decisionService.js", import.meta.url), "utf8");

test("the AI Native entry does not import the legacy fixed scoring path", () => {
  assert.doesNotMatch(ui, /scoreCafe|\.\.\/\.\.\/scoring|from ["'][^"']*data\.js/);
  assert.doesNotMatch(client, /scoreCafe|scoring\.js/);
});

test("the main decision flow requires both interpreter and reasoner model roles", () => {
  assert.match(service, /interpretIntent\(/);
  assert.match(service, /reasonAboutCandidates\(/);
  assert.match(service, /createDeepSeekResponsesClient\(/);
  assert.match(service, /MODEL_NOT_CONFIGURED/);
});

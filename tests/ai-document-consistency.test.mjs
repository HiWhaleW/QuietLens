import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const documents = [
  "../AGENTS.md",
  "../docs/QUIETLENS_PRODUCT_CONTEXT.md",
  "../docs/PROJECT_STATUS.md",
  "../docs/CAFE_SOURCE_REGISTRY.md",
  "../docs/AI_NATIVE_ACCEPTANCE_CRITERIA.md",
];

test("keeps the B00 database-version boundary consistent across authoritative documents", async () => {
  const contents = await Promise.all(documents.map(async (relativePath) => ({
    relativePath,
    text: await readFile(new URL(relativePath, import.meta.url), "utf8"),
  })));

  for (const { relativePath, text } of contents) {
    for (const version of ["v0.1", "v1.0", "v2.0", "v3.0"]) {
      assert.ok(text.includes(version), `${relativePath} must include ${version}`);
    }
    assert.match(
      text,
      /AI.{0,100}(?:不能|不是|不得|never|不被列为).{0,60}(?:事实来源|factual source|来源)/is,
      `${relativePath} must say AI is not a factual source`,
    );
    assert.match(text, /(?:黄浦.{0,20}10 家|10 controlled Huangpu|same 10 Huangpu)/is);
    assert.match(text, /(?:不能宣传成.*全上海|不宣传为.*全上海|not.*comprehensive Shanghai)/is);
  }
});

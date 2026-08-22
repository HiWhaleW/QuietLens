import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { brotliCompressSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { serveStaticAsset } from "../scripts/vefaas-static-assets.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quietlens-static-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  return root;
}

test("serves precompressed fingerprinted assets with immutable cache metadata", async () => {
  const root = await fixture();
  try {
    const source = Buffer.from("const quietlens = 'performance';".repeat(100));
    const compressed = brotliCompressSync(source);
    await writeFile(path.join(root, "assets", "app-a1b2c3.js"), source);
    await writeFile(path.join(root, "assets", "app-a1b2c3.js.br"), compressed);

    const response = await serveStaticAsset(new Request("https://quietlens.test/assets/app-a1b2c3.js", {
      headers: { "accept-encoding": "br, gzip" },
    }), root);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "br");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(Number(response.headers.get("content-length")), compressed.length);
    assert.equal(response.headers.get("vary"), "accept-encoding");

    const cached = await serveStaticAsset(new Request("https://quietlens.test/assets/app-a1b2c3.js", {
      headers: {
        "accept-encoding": "br, gzip",
        "if-none-match": response.headers.get("etag"),
      },
    }), root);
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revalidates the app shell and supports bodyless HEAD responses", async () => {
  const root = await fixture();
  try {
    const source = Buffer.from("<!doctype html><title>QuietLens</title>");
    await writeFile(path.join(root, "index.html"), source);
    const response = await serveStaticAsset(new Request("https://quietlens.test/", { method: "HEAD" }), root);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(Number(response.headers.get("content-length")), source.length);
    assert.equal(await response.text(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects paths outside the packaged client root", async () => {
  const root = await fixture();
  try {
    const response = await serveStaticAsset(new Request("https://quietlens.test/%2e%2e%2fsecret.txt"), root);
    assert.equal(response.status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serves hashed media immutably but revalidates the mutable media manifest", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "media", "cafes", "hp-naive"), { recursive: true });
    await writeFile(path.join(root, "media", "cafes", "hp-naive", "scene-deadbeefcafe.webp"), "scene");
    await writeFile(path.join(root, "media", "manifest-v4.json"), "{}");
    const scene = await serveStaticAsset(new Request("https://quietlens.test/media/cafes/hp-naive/scene-deadbeefcafe.webp"), root);
    const manifest = await serveStaticAsset(new Request("https://quietlens.test/media/manifest-v4.json"), root);
    assert.equal(scene.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production veFaaS packaging refuses to ship without an external HTTPS media base", () => {
  const result = spawnSync(process.execPath, ["scripts/prepare-vefaas-build.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, QL_REQUIRE_EXTERNAL_MEDIA: "true", VITE_MEDIA_CDN_BASE_URL: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /requires VITE_MEDIA_CDN_BASE_URL/);
});

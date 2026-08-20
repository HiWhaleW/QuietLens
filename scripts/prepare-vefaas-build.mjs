#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

import { build } from "esbuild";
import { loadEnv } from "vite";
import { normalizeMediaBaseUrl } from "../src/ai-native/media/mediaDelivery.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "dist", "vefaas");
const clientRoot = path.join(root, "dist", "client");
const serverEntry = path.join(root, "scripts", "serve-vefaas.mjs");
const buildEnv = loadEnv(process.env.NODE_ENV ?? "production", root, "VITE_");
const mediaCdnBaseUrl = normalizeMediaBaseUrl(process.env.VITE_MEDIA_CDN_BASE_URL ?? buildEnv.VITE_MEDIA_CDN_BASE_URL);
const requireExternalMedia = process.env.QL_REQUIRE_EXTERNAL_MEDIA === "true";

if (requireExternalMedia && !mediaCdnBaseUrl) {
  throw new Error("Production veFaaS packaging requires VITE_MEDIA_CDN_BASE_URL; media must not ship through the function");
}

for (const input of [clientRoot, path.join(root, "dist", "server", "index.js"), serverEntry]) {
  if (!existsSync(input)) throw new Error(`Missing veFaaS build input: ${input}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(clientRoot, path.join(outputRoot, "client"), { recursive: true });

const packagedClient = path.join(outputRoot, "client");
rmSync(path.join(packagedClient, "assets", "brand", "quietlens-mark.png"), { force: true });
rmSync(path.join(packagedClient, "assets", "cafes"), { recursive: true, force: true });
rmSync(path.join(packagedClient, "assets", "map"), { recursive: true, force: true });
if (mediaCdnBaseUrl) rmSync(path.join(packagedClient, "media"), { recursive: true, force: true });

const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".svg"]);
let compressedFileCount = 0;
function precompress(directory) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    const info = statSync(file);
    if (info.isDirectory()) {
      precompress(file);
      continue;
    }
    if (!compressibleExtensions.has(path.extname(file).toLowerCase()) || info.size < 1_024) continue;
    const input = readFileSync(file);
    const brotli = brotliCompressSync(input, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
    });
    const gzip = gzipSync(input, { level: 9 });
    if (brotli.length < input.length) writeFileSync(`${file}.br`, brotli);
    if (gzip.length < input.length) writeFileSync(`${file}.gz`, gzip);
    compressedFileCount += 1;
  }
}
precompress(packagedClient);

await build({
  entryPoints: [serverEntry],
  outfile: path.join(outputRoot, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: "import { createRequire as __qlCreateRequire } from 'node:module'; const require = __qlCreateRequire(import.meta.url);" },
});

console.log(`Prepared self-contained QuietLens veFaaS bundle (${compressedFileCount} assets precompressed; media ${mediaCdnBaseUrl ? "external CDN" : "local fallback"})`);

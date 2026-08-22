import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { CAFE_MEDIA_SOURCES, MAP_MEDIA_SOURCES } from "../scripts/cafe-media-config.mjs";
import { MEDIA_MANIFEST, MEDIA_MANIFEST_HASH } from "../src/ai-native/media/mediaManifest.generated.js";
import {
  getCafeSceneMedia,
  getMapBoardMedia,
  normalizeMediaBaseUrl,
  selectScenePrefetchUrls,
} from "../src/ai-native/media/mediaDelivery.js";
import {
  getDecodedImageStatus,
  preloadDecodedImage,
  resetMediaPrefetchesForTests,
} from "../src/ai-native/media/mediaPrefetch.js";
import { sceneNoticeForPlace } from "../src/ai-native/ui/scenePresentation.js";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("v4 cafe manifest contains hashed thumbnail and decoded-scene WebP variants without previews", async () => {
  assert.equal(CAFE_MEDIA_SOURCES.length, 10);
  assert.equal(Object.keys(MEDIA_MANIFEST.cafes).length, CAFE_MEDIA_SOURCES.length);

  for (const source of CAFE_MEDIA_SOURCES) {
    const media = MEDIA_MANIFEST.cafes[source.cafeId];
    assert.equal(media.cafe_id, source.cafeId);
    assert.equal("preview" in media, false);
    for (const [role, limits] of Object.entries({
      thumbnail: { width: 320, height: 228, bytes: 55_000 },
      scene: { width: 760, height: 540, bytes: 180_000 },
    })) {
      const asset = media[role];
      const file = new URL(`../public/${asset.path}`, import.meta.url);
      await access(file);
      const buffer = await readFile(file);
      const info = await stat(file);
      const metadata = await sharp(fileURLToPath(file)).metadata();
      assert.equal(info.size, asset.bytes);
      assert.ok(info.size <= limits.bytes, `${asset.path} is ${info.size} bytes`);
      assert.ok(metadata.width <= limits.width && metadata.height <= limits.height);
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.hasAlpha, true);
      assert.equal(sha256(buffer), asset.content_hash);
      assert.match(asset.path, new RegExp(`^media/cafes/${source.cafeId}/${role}-[a-f0-9]{12}\\.webp$`));
      assert.equal(asset.mime_type, "image/webp");
      assert.equal(asset.version, "v4");
    }
  }

  const manifestBuffer = await readFile(new URL("../public/media/manifest-v4.json", import.meta.url));
  assert.equal(sha256(manifestBuffer), MEDIA_MANIFEST_HASH);
});

test("map boards are versioned WebP objects and resolve through the same CDN base", async () => {
  assert.equal(Object.keys(MEDIA_MANIFEST.maps).length, MAP_MEDIA_SOURCES.length);
  for (const { regionId } of MAP_MEDIA_SOURCES) {
    const media = getMapBoardMedia(regionId, { baseUrl: "https://media.quietlens.example/cdn" });
    assert.equal(media.region_id, regionId);
    assert.match(media.board.src, new RegExp(`^https://media\\.quietlens\\.example/cdn/media/maps/${regionId}/board-[a-f0-9]{12}\\.webp$`));
    const file = new URL(`../public/${MEDIA_MANIFEST.maps[regionId].board.path}`, import.meta.url);
    const metadata = await sharp(fileURLToPath(file)).metadata();
    assert.equal(metadata.format, "webp");
    assert.ok(metadata.width <= 1536 && metadata.height <= 1024);
  }
});

test("legacy evidence paths resolve to secure CDN URLs and unsafe bases are rejected", () => {
  const source = CAFE_MEDIA_SOURCES[0];
  const local = getCafeSceneMedia(source.legacyPath);
  assert.match(local.scene.src, /^\/media\/cafes\/hp-naive\/scene-[a-f0-9]{12}\.webp$/);
  const cdn = getCafeSceneMedia(`public${source.legacyPath}`, { baseUrl: "https://cdn.example.test/quietlens/" });
  assert.match(cdn.thumbnail.src, /^https:\/\/cdn\.example\.test\/quietlens\/media\/cafes\/hp-naive\/thumbnail-/);
  assert.equal(normalizeMediaBaseUrl(""), "");
  for (const invalid of ["http://cdn.example.test", "//cdn.example.test", "https://user:pass@cdn.example.test", "https://cdn.example.test/?token=x"]) {
    assert.throws(() => normalizeMediaBaseUrl(invalid));
  }
});

test("a 100-cafe catalog prefetch plan selects only the requested recommendation set", () => {
  const places = Array.from({ length: 100 }, (_, index) => ({
    place_id: `place-${index}`,
    asset: CAFE_MEDIA_SOURCES[index % CAFE_MEDIA_SOURCES.length].legacyPath,
  }));
  const urls = selectScenePrefetchUrls(places, ["place-4", "place-12", "place-99", "place-42"]);
  assert.equal(urls.length, 3, "the 100-cafe catalog does not expand the P1 recommendation preload beyond three scenes");
  assert.match(urls[0], /^\/media\/cafes\/hp-metal-hands\/scene-/);
  assert.match(urls[1], /^\/media\/cafes\/hp-cafe-on-air\/scene-/);
  assert.match(urls[2], /^\/media\/cafes\/hp-east-sea\/scene-/);
});

test("scene prefetch waits for load and decode before reporting ready", async () => {
  resetMediaPrefetchesForTests();
  let decodeCalls = 0;
  class FakeImage {
    listeners = new Map();
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    set src(value) {
      this.currentSrc = value;
      queueMicrotask(() => this.listeners.get("load")?.());
    }
    async decode() { decodeCalls += 1; }
  }
  const url = "https://cdn.example.test/media/cafes/hp-naive/scene-deadbeefcafe.webp";
  const first = preloadDecodedImage(url, { fetchPriority: "high", imageFactory: () => new FakeImage() });
  const second = preloadDecodedImage(url, { imageFactory: () => new FakeImage() });
  assert.equal(first, second);
  assert.equal(getDecodedImageStatus(url), "loading");
  await first;
  assert.equal(decodeCalls, 1);
  assert.equal(getDecodedImageStatus(url), "ready");
});

test("the rejected blurred preview path is absent from current UI source", async () => {
  const [mapStage, styles, decisionApp] = await Promise.all([
    readFile(new URL("../src/MapStage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/ai-native/ui/QuietLensDecisionApp.jsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(mapStage, /scenePreview|cafe-scene-preview/);
  assert.doesNotMatch(styles, /cafe-scene-preview|blur\(7px\)/);
  assert.doesNotMatch(decisionApp, /scenePreview/);
});

test("recommended scene notices never fall through to a non-recommendation reason", () => {
  const noWarning = sceneNoticeForPlace({
    candidate: { tradeoffs: [], unknowns: [] },
    nonRecommendationText: "未进入 AI 本轮 3 个推荐",
  });
  assert.equal(noWarning, null);

  const tradeoff = sceneNoticeForPlace({
    candidate: { tradeoffs: [{ text: "下午座位可能紧张" }], unknowns: [] },
    nonRecommendationText: "未进入 AI 本轮 3 个推荐",
  });
  assert.deepEqual(tradeoff, { kind: "conflict", label: "可能冲突", text: "下午座位可能紧张" });

  const unknown = sceneNoticeForPlace({
    candidate: { tradeoffs: [], unknowns: ["outlets"] },
    unknownLabel: () => "插座",
    nonRecommendationText: "未进入 AI 本轮 3 个推荐",
  });
  assert.deepEqual(unknown, { kind: "unknown", label: "待核实", text: "插座仍缺少当前证据" });

  const notRecommended = sceneNoticeForPlace({
    candidate: null,
    nonRecommendationText: "本店证据组合较弱。",
  });
  assert.deepEqual(notRecommended, { kind: "not-recommended", label: "本轮未推荐", text: "本店证据组合较弱。" });
});

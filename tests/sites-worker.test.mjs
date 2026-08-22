import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";
import { MEDIA_MANIFEST } from "../src/ai-native/media/mediaManifest.generated.js";

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, new URL(request.url).pathname.startsWith("/api/") ? 0 : 1);
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
});

test("emits the self-contained veFaaS server bundle", async () => {
  await access(new URL("../dist/vefaas/server.mjs", import.meta.url));
  await access(new URL("../dist/vefaas/client/index.html", import.meta.url));
});

test("local fallback packages only v4 hashed media and excludes legacy masters", async () => {
  for (const cafe of Object.values(MEDIA_MANIFEST.cafes)) {
    await access(new URL(`../dist/vefaas/client/${cafe.thumbnail.path}`, import.meta.url));
    await access(new URL(`../dist/vefaas/client/${cafe.scene.path}`, import.meta.url));
  }
  for (const map of Object.values(MEDIA_MANIFEST.maps)) {
    await access(new URL(`../dist/vefaas/client/${map.board.path}`, import.meta.url));
  }

  await assert.rejects(access(new URL("../dist/vefaas/client/assets/cafes/cafe-on-air-watercolor-v1.png", import.meta.url)));
  await assert.rejects(access(new URL("../dist/vefaas/client/assets/cafes/cafe-on-air-watercolor-v3.webp", import.meta.url)));
  await assert.rejects(access(new URL("../dist/vefaas/client/assets/map/huangpu-watercolor-board-v1.jpg", import.meta.url)));
});

test("veFaaS upload rules preserve nested v4 media in the local fallback bundle", async () => {
  const ignoreRules = await readFile(new URL("../.vefaasignore", import.meta.url), "utf8");
  assert.doesNotMatch(ignoreRules, /^media\/$/m);
  assert.match(ignoreRules, /^\/media\/$/m);
});

test("the packaged Worker exposes the AI decision API with server-only evidence", async () => {
  const builtWorker = (await import(`../dist/server/index.js?test=${Date.now()}`)).default;
  const response = await builtWorker.fetch(new Request("https://example.test/api/decision/interpret", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.test" },
    body: JSON.stringify({
      session_id: "sess-built-worker",
      request_id: "req-built-worker",
      user_text: "明天下午在黄浦工作九十分钟。",
      mode: "initial",
      page_context: { area: "黄浦区" },
    }),
  }), {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    QUIETLENS_ANALYTICS_SINK: { write: async () => {} },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "MODEL_NOT_CONFIGURED" } });
});

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "dist", "client");
const app = (await import(new URL("../dist/server/index.js", import.meta.url))).default;
const requestedPort = Number(process.argv.find((value) => value.startsWith("--port="))?.split("=")[1] ?? 4173);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveAsset(request) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.resolve(clientRoot, relative);
  if (file !== clientRoot && !file.startsWith(`${clientRoot}${path.sep}`)) return new Response("Forbidden", { status: 403 });
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    return new Response(await readFile(file), {
      status: 200,
      headers: { "content-type": contentTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 32_768) {
        outgoing.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const url = `http://${incoming.headers.host ?? `127.0.0.1:${requestedPort}`}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await app.fetch(request, {
      ASSETS: { fetch: serveAsset },
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      QL_INTENT_MODEL: process.env.QL_INTENT_MODEL,
      QL_REASONING_MODEL: process.env.QL_REASONING_MODEL,
      QL_INTENT_TIMEOUT_MS: process.env.QL_INTENT_TIMEOUT_MS,
      QL_REASONING_TIMEOUT_MS: process.env.QL_REASONING_TIMEOUT_MS,
      QL_RATE_LIMIT_MAX: process.env.QL_RATE_LIMIT_MAX,
      QL_RATE_LIMIT_WINDOW_MS: process.env.QL_RATE_LIMIT_WINDOW_MS,
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Local server error");
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  console.log(`QuietLens local server: http://127.0.0.1:${requestedPort}`);
});

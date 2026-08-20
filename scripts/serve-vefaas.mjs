import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import app from "../dist/server/index.js";
import { serveStaticAsset } from "./vefaas-static-assets.mjs";

const bundleRoot = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(bundleRoot, "client");
const port = Number(process.env.PORT ?? 8000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT_INVALID");

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
    const protocol = incoming.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const url = `${protocol}://${incoming.headers.host ?? `127.0.0.1:${port}`}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await app.fetch(request, {
      ...process.env,
      ASSETS: { fetch: (assetRequest) => serveStaticAsset(assetRequest, clientRoot) },
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("QuietLens server error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`QuietLens veFaaS server listening on 0.0.0.0:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

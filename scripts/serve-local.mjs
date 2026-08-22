import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "dist", "client");
const app = (await import(new URL("../dist/server/index.js", import.meta.url))).default;

function argumentValue(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const requestedPort = Number(argumentValue("port") ?? process.env.PORT ?? 4173);
const requestedHost = argumentValue("host") ?? process.env.HOST ?? "127.0.0.1";
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error("PORT_INVALID");
}
if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|localhost)$/u.test(requestedHost)) {
  throw new Error("HOST_INVALID");
}

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
    const forwardedProtocol = incoming.headers["x-forwarded-proto"];
    const protocol = forwardedProtocol === "https" ? "https" : "http";
    const url = `${protocol}://${incoming.headers.host ?? `127.0.0.1:${requestedPort}`}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await app.fetch(request, {
      ...process.env,
      ASSETS: { fetch: serveAsset },
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Local server error");
  }
});

server.listen(requestedPort, requestedHost, () => {
  const visibleHost = requestedHost === "0.0.0.0" ? "127.0.0.1" : requestedHost;
  console.log(`QuietLens server: http://${visibleHost}:${requestedPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

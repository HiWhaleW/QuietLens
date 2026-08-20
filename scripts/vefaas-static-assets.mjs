import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = Object.freeze({
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
});

const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg"]);

function acceptsEncoding(header, encoding) {
  return String(header ?? "").split(",").some((entry) => {
    const [name, ...parameters] = entry.trim().split(";").map((part) => part.trim());
    if (name !== encoding && name !== "*") return false;
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    return !quality || Number(quality.slice(2)) > 0;
  });
}

async function availableSidecar(file, extension) {
  try {
    const info = await stat(`${file}.${extension}`);
    return info.isFile() ? { file: `${file}.${extension}`, info, encoding: extension } : null;
  } catch {
    return null;
  }
}

function cacheControl(relative) {
  if (relative === "index.html") return "no-cache";
  const versionedMedia = /^media\/(?:cafes\/[^/]+\/(?:thumbnail|scene)-[a-f0-9]{12}\.webp|maps\/[^/]+\/board-[a-f0-9]{12}\.webp)$/.test(relative);
  if (relative.startsWith("assets/") || versionedMedia) return "public, max-age=31536000, immutable";
  if (relative.startsWith("media/")) return "no-cache";
  return "public, max-age=3600";
}

function notModified(request, etag, modifiedAt) {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) return ifNoneMatch.split(",").map((value) => value.trim()).includes(etag);
  const ifModifiedSince = Date.parse(request.headers.get("if-modified-since") ?? "");
  return Number.isFinite(ifModifiedSince) && modifiedAt.getTime() < ifModifiedSince + 1_000;
}

export async function serveStaticAsset(request, clientRoot) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.resolve(clientRoot, relative);
  if (file !== clientRoot && !file.startsWith(`${clientRoot}${path.sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const sourceInfo = await stat(file);
    if (!sourceInfo.isFile()) return new Response("Not found", { status: 404 });

    const extension = path.extname(file).toLowerCase();
    const compressible = COMPRESSIBLE_EXTENSIONS.has(extension);
    let selected = { file, info: sourceInfo, encoding: null };
    if (compressible && acceptsEncoding(request.headers.get("accept-encoding"), "br")) {
      selected = await availableSidecar(file, "br") ?? selected;
    }
    if (compressible && !selected.encoding && acceptsEncoding(request.headers.get("accept-encoding"), "gzip")) {
      selected = await availableSidecar(file, "gz") ?? selected;
    }

    const encodingTag = selected.encoding ?? "identity";
    const etag = `"${sourceInfo.size.toString(16)}-${Math.trunc(sourceInfo.mtimeMs).toString(16)}-${encodingTag}"`;
    const headers = new Headers({
      "cache-control": cacheControl(relative),
      "content-length": String(selected.info.size),
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      etag,
      "last-modified": sourceInfo.mtime.toUTCString(),
    });
    if (compressible) headers.set("vary", "accept-encoding");
    if (selected.encoding) headers.set("content-encoding", selected.encoding);

    if (notModified(request, etag, sourceInfo.mtime)) {
      headers.delete("content-length");
      return new Response(null, { status: 304, headers });
    }
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(await readFile(selected.file), { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

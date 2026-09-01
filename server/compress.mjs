import { stat } from "node:fs/promises";
import path from "node:path";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);

/**
 * Gzip JSON responses that are big enough to be worth it.
 *
 * The catalog listing is 438 KiB of JSON and 76 KiB gzipped, and three pages fetch it
 * independently on every visit. Over Tailscale from a phone that difference is the page appearing
 * or not. Packing a small response costs more time than it saves bytes, so small ones are left
 * alone. The built assets do not come through here: they are compressed once at build time and
 * served by `precompressedAssets` below.
 */
export function jsonGzip({ minimumBytes = 1024, compress = gzip } = {}) {
  return function compressJson(request, response, next) {
    if (!/\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) return next();
    const json = response.json.bind(response);
    response.json = (body) => {
      const text = JSON.stringify(body);
      if (Buffer.byteLength(text) < minimumBytes) return json(body);
      return compress(text).then((packed) => {
        // A client that gave up mid-compression leaves nothing to write to.
        if (response.writableEnded) return response;
        response.setHeader("Content-Encoding", "gzip");
        response.setHeader("Vary", "Accept-Encoding");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Content-Length", packed.length);
        return response.end(packed);
      }).catch(() => (response.writableEnded ? response : json(body)));
    };
    return next();
  };
}

/** Content types by extension, because the response must describe the file, not its wrapper. */
const types = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8" };

/**
 * Serve the build's `.gz` twin when the browser will take it.
 *
 * Put this in front of the static handler for the assets directory. The files are content-hashed
 * and sent immutable, so they were compressed once at build time (scripts/precompress-assets.mjs)
 * rather than on every request: 773 KiB of JavaScript and CSS becomes 192 KiB, and the server does
 * no work for it.
 *
 * Vary is set on every asset response, not just the compressed ones. A cache that saw the gzipped
 * reply and did not know the encoding varied would hand it to a client that cannot read it.
 */
export function precompressedAssets(directory, { exists = (file) => stat(file).then((entry) => entry.isFile(), () => false) } = {}) {
  return async function servePrecompressed(request, response, next) {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    response.setHeader("Vary", "Accept-Encoding");
    if (!/\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) return next();
    const name = decodeURIComponent(request.path);
    const extension = path.extname(name);
    if (!Object.hasOwn(types, extension)) return next();
    // Resolve first and confirm the result is still inside the assets directory, so a crafted path
    // cannot reach a .gz file elsewhere on the disk.
    const resolved = path.resolve(directory, `.${path.posix.normalize(name)}.gz`);
    const root = path.resolve(directory);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return next();
    if (!(await exists(resolved))) return next();
    response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Content-Type", types[extension]);
    request.url = `${request.path}.gz${request.url.slice(request.path.length)}`;
    return next();
  };
}

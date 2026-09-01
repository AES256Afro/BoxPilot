import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);

/**
 * Gzip JSON responses that are big enough to be worth it.
 *
 * The catalog listing is 438 KiB of JSON and 76 KiB gzipped, and three pages fetch it
 * independently on every visit. Over Tailscale from a phone that difference is the page appearing
 * or not. Only JSON goes through here: the built assets are already compressed by the static
 * handler, and packing a small response costs more time than it saves bytes.
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

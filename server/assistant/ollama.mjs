/**
 * The assistant's one way out of this process (M34): Ollama's HTTP API, on this server or at an
 * address on the owner's own network. No cloud endpoint and no API key: the address must be a
 * loopback, private, link-local or tailnet (100.64.0.0/10) address, or a name that resolves only to
 * those, checked when it is saved and again before every request, and a redirect is refused rather
 * than followed somewhere else.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export const ollamaApiPort = 11434;

const privateV4 = [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]];
const v4ToInt = (address) => address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
// Names that only ever mean something on a home network or a tailnet. A single label ("gpu-box")
// is resolved by the LAN's own DNS; anything else must resolve to a private address anyway.
const localSuffixes = [".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain", ".ts.net"];

/** Whether an IP address is on this machine, the LAN, a link, or the tailnet. */
export function isLocalAddress(address) {
  const bare = String(address ?? "").replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) {
    const value = v4ToInt(bare);
    return privateV4.some(([base, bits]) => ((value ^ v4ToInt(base)) >>> (32 - bits)) === 0);
  }
  if (net.isIPv6(bare)) {
    const lower = bare.toLowerCase();
    if (lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isLocalAddress(mapped[1]);
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    // fc00::/7 (unique local) and fe80::/10 (link-local).
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function isLocalName(hostname) {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(name)) return true;
  return localSuffixes.some((suffix) => name.endsWith(suffix) && name.length > suffix.length);
}

/**
 * The address as it is stored: `http(s)://host:port`, nothing more. Throws with a sentence the
 * Settings page can show when it is not an address on this server or the owner's network.
 */
export function normalizeEndpoint(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 200) throw new Error("Give the model server's address, like http://127.0.0.1:11434");
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error("That is not an address. Use the form http://192.168.1.20:11434"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The address must not carry a user name or password; Ollama needs none");
  if (url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Give the address only, like http://192.168.1.20:11434, with no path");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(hostname) !== 0;
  if (literal ? !isLocalAddress(hostname) : !isLocalName(hostname)) throw new Error("The assistant only talks to a model on this server or your own network: use a private, tailnet or loopback address");
  return url.origin;
}

/** Read at most `maxBytes` of a response body as text; a larger body is an error, not a truncation. */
async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = ""; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("The model server sent more than expected");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

const embeddingName = /embed|minilm|bge-|e5-|arctic-embed/i;
export const isEmbeddingModel = (name) => embeddingName.test(String(name ?? ""));

export function createOllamaClient({
  fetch: fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  now = () => Date.now(),
  resolveTtlMs = 60_000,
} = {}) {
  const resolved = new Map();

  /** Refuse an address whose name resolves anywhere public, even if it looked local when saved. */
  async function guard(endpoint) {
    const url = new URL(normalizeEndpoint(endpoint));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(hostname)) return url.origin;
    const cached = resolved.get(hostname);
    if (cached && now() - cached.at < resolveTtlMs) {
      if (!cached.ok) throw new Error(`${hostname} does not resolve to an address on this network`);
      return url.origin;
    }
    const addresses = await lookup(hostname, { all: true }).catch(() => []);
    const ok = addresses.length > 0 && addresses.every((entry) => isLocalAddress(entry.address));
    resolved.set(hostname, { at: now(), ok });
    if (resolved.size > 64) resolved.delete(resolved.keys().next().value);
    if (!ok) throw new Error(`${hostname} does not resolve to an address on this network`);
    return url.origin;
  }

  async function send(endpoint, pathname, { method = "GET", body, signal, timeoutMs }) {
    const origin = await guard(endpoint);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    return fetchImpl(`${origin}${pathname}`, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
      redirect: "error",
    });
  }

  async function failure(response, model) {
    const text = await readBounded(response, 16 * 1024).catch(() => "");
    let message = text;
    try { message = JSON.parse(text)?.error ?? text; } catch { /* plain text */ }
    const error = new Error(response.status === 404 && model ? `The model ${model} is not on the model server` : `The model server answered ${response.status}${message ? `: ${String(message).slice(0, 200)}` : ""}`);
    error.code = response.status === 404 ? "model_missing" : "model_error";
    return error;
  }

  /** The models the server has, by name. */
  async function tags(endpoint, { signal, timeoutMs = 3_000 } = {}) {
    const response = await send(endpoint, "/api/tags", { signal, timeoutMs });
    if (!response.ok) throw await failure(response);
    const parsed = JSON.parse(await readBounded(response, 1024 * 1024));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models.slice(0, 200).flatMap((entry) => (typeof entry?.name === "string" && entry.name.length <= 200
      ? [{ name: entry.name, size: Number.isFinite(entry.size) ? entry.size : null, family: typeof entry.details?.family === "string" ? entry.details.family.slice(0, 40) : null }]
      : []));
  }

  /** One vector per input, in order. */
  async function embed(endpoint, model, inputs, { signal, timeoutMs = 15_000 } = {}) {
    const response = await send(endpoint, "/api/embed", { method: "POST", body: { model, input: inputs, truncate: true }, signal, timeoutMs });
    if (!response.ok) throw await failure(response, model);
    const parsed = JSON.parse(await readBounded(response, 16 * 1024 * 1024));
    const vectors = parsed?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== inputs.length) throw new Error("The model server returned the wrong number of embeddings");
    return vectors.map((vector) => {
      if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || !vector.every(Number.isFinite)) throw new Error("The model server returned an embedding that is not a vector");
      return vector;
    });
  }

  /**
   * Stream a chat completion. Each piece of text goes to `onDelta` as it arrives; nothing is kept
   * here, so a caller that is cut off by its own deadline still has what came before. Resolves with
   * whether the model finished; rejects on an HTTP error, a malformed stream, or the signal.
   */
  async function chat(endpoint, { model, messages, options = {} }, { signal, timeoutMs = 120_000, onDelta = () => {} } = {}) {
    const response = await send(endpoint, "/api/chat", { method: "POST", body: { model, messages, stream: true, options }, signal, timeoutMs });
    if (!response.ok) throw await failure(response, model);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The model server sent no answer");
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 256 * 1024 && !pending.includes("\n")) throw new Error("The model server sent a line that is too long");
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { throw new Error("The model server sent something that is not a chat stream"); }
          if (event?.error) throw Object.assign(new Error(`The model stopped with an error: ${String(event.error).slice(0, 200)}`), { code: "model_error" });
          const piece = event?.message?.content;
          if (typeof piece === "string" && piece) {
            // The caller answers false when it has had enough (the size bound): stop reading.
            if (onDelta(piece) === false) return { done: false, stopped: true };
          }
          if (event?.done) return { done: true, stopped: false, reason: typeof event.done_reason === "string" ? event.done_reason : null };
        }
      }
      return { done: false, stopped: false };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return { tags, embed, chat, guard };
}

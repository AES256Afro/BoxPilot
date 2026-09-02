/**
 * The HTTP step's hands (M13.7): perform one outbound request from a task, because the helper's
 * PrivateNetwork=true cannot open a connection at all.
 *
 * A credential is referenced by name and resolved here, inside the root task, from the root-owned
 * store; the value goes into one request header and nowhere else — not into the result, not into
 * the job record, not into a log line. The response comes back bounded: the status, a capped body
 * excerpt, and the parsed JSON when it parses, which is what later flow steps read.
 */
import { createCredentialStore } from "../credentials.mjs";

const bodyLimit = 8192;
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

export async function httpRequest(parameters = {}, { credentials = createCredentialStore(), timeoutMs = 25_000, fetcher = fetch, now = () => Date.now() } = {}) {
  const { url, method = "GET", body = null, contentType = null, credentialName = null, credentialHeader = "Authorization", credentialPrefix = "Bearer " } = parameters;
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2048) throw new Error("url must be http(s) and at most 2048 characters");
  if (!methods.has(method)) throw new Error(`method must be one of ${[...methods].join(", ")}`);
  if (body !== null && (typeof body !== "string" || body.length > 16384)) throw new Error("body must be a string of at most 16384 characters");

  // The cloud metadata endpoint answers no legitimate home-server request and hands out
  // instance credentials; nothing else legitimate lives on link-local. Loopback and LAN are
  // deliberately allowed, because the owner's own ntfy and LAN webhooks are the point.
  const host = new URL(url).hostname;
  if (host === "169.254.169.254" || host === "metadata.google.internal" || /^169\.254\./.test(host) || /^\[?fe80:/i.test(host)) {
    throw new Error("Requests to the link-local metadata range are refused");
  }

  const headers = {};
  if (body !== null) headers["Content-Type"] = contentType ?? "application/json";
  let carriesCredential = false;
  if (credentialName) {
    const value = await credentials.read(credentialName);
    if (value === null) throw new Error(`No credential is named ${credentialName}; save it under Settings first`);
    headers[credentialHeader] = `${credentialPrefix}${value}`;
    carriesCredential = true;
  }

  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    // A redirect can send a custom credential header to another origin (fetch strips only
    // Authorization/Cookie), so a request that carries a credential never follows one: a 3xx
    // is returned as-is for the caller to read rather than chased to an attacker's host.
    response = await fetcher(url, { method, headers, ...(body !== null && method !== "GET" && method !== "HEAD" ? { body } : {}), redirect: carriesCredential ? "manual" : "follow", signal: controller.signal });
  } catch (error) {
    // Clear it here too: the finally that clears it belongs to the body read below, which a
    // connection refused never reaches. An armed timer keeps the task process, and so the
    // oneshot unit and the flow step waiting on it, alive for the full timeout after failing.
    clearTimeout(timer);
    throw new Error(error.name === "AbortError" ? `No answer within ${Math.round(timeoutMs / 1000)}s` : `The request failed: ${error.cause?.code ?? error.message}`);
  }
  // Read the body under the same abort deadline and stop at the excerpt cap, so a server that
  // dribbles or never ends a huge body cannot hang the task or exhaust memory: the request is
  // bounded end to end, not just to first byte.
  let text = "";
  try {
    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length >= bodyLimit + 1) { void reader.cancel().catch(() => {}); break; }
      }
    } else {
      text = await response.text();
    }
  } catch { text = ""; } finally { clearTimeout(timer); }
  const excerpt = text.slice(0, bodyLimit);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON; the excerpt still tells the story */ }
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") ?? null,
    body: excerpt,
    truncated: text.length > bodyLimit,
    json,
    ms: now() - started,
  };
}

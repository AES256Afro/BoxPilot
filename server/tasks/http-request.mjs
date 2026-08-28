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

  const headers = {};
  if (body !== null) headers["Content-Type"] = contentType ?? "application/json";
  if (credentialName) {
    const value = await credentials.read(credentialName);
    if (value === null) throw new Error(`No credential is named ${credentialName}; save it under Settings first`);
    headers[credentialHeader] = `${credentialPrefix}${value}`;
  }

  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetcher(url, { method, headers, ...(body !== null && method !== "GET" && method !== "HEAD" ? { body } : {}), redirect: "follow", signal: controller.signal });
  } catch (error) {
    throw new Error(error.name === "AbortError" ? `No answer within ${Math.round(timeoutMs / 1000)}s` : `The request failed: ${error.cause?.code ?? error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
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

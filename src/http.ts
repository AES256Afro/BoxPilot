/**
 * Reading an API response.
 *
 * BoxPilot answers every API request with JSON, including its errors — but the thing on the wire
 * is not always BoxPilot: during a self-update the service restarts, and Tailscale Serve or a
 * reverse proxy answers with an HTML page. Parsing that as JSON used to surface in the UI as
 * "Unexpected token '<'", which tells the owner nothing. Every reader goes through here instead.
 */

/** Status codes a caller may want to handle itself rather than treat as a failure. */
export interface ReadJsonOptions {
  /** Statuses returned as data instead of throwing (e.g. 503 for "this subsystem is not set up"). */
  allowStatus?: number[];
}

/** An error the server answered with: carries the HTTP status and the server's `code`, when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function readJson<T>(response: Response, { allowStatus = [] }: ReadJsonOptions = {}): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string; errors?: string[] }) | null;
  if (response.ok || allowStatus.includes(response.status)) {
    if (body === null) throw new Error("BoxPilot sent a reply the page could not read. It may be restarting. Try again in a moment.");
    return body;
  }
  // No session at all (not a wrong password or an elevation prompt, which are 401s too): the app
  // checks and, if the session has really gone, shows the sign-in page saying so (M36).
  if (response.status === 401 && (body as { code?: string } | null)?.code === "authentication_required" && typeof window !== "undefined") {
    window.dispatchEvent(new Event("boxpilot:session-ended"));
  }
  const sentCode = (body as { code?: unknown } | null)?.code;
  const code = typeof sentCode === "string" ? sentCode : undefined;
  if (body?.error) throw new ApiError(body.error, response.status, code);
  if (body?.errors?.length) throw new ApiError(body.errors.join(" | "), response.status, code);
  if (response.status === 401) throw new ApiError("Your session has expired. Sign in again.", response.status, code);
  if (response.status === 502 || response.status === 503 || response.status === 504) throw new ApiError("BoxPilot is not answering. It may be restarting. Try again in a moment.", response.status, code);
  throw new ApiError(`Request failed (${response.status})`, response.status, code);
}

/** Error codes the server attaches when its admin service (the root helper) is not answering. */
const HELPER_CODES = new Set(["helper_unavailable", "helper_timeout", "helper_closed"]);

/** The words for a request that never got an answer at all. */
const NO_ANSWER_WORDS = "BoxPilot did not answer. It may be restarting, or this device is off the network.";

/** True for the TypeError a browser throws when a fetch gets no reply (each engine words it differently). */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message;
  return message === "Failed to fetch"
    || message === "Load failed"
    || message === "NetworkError when attempting to fetch resource."
    || message === "fetch failed";
}

/**
 * Plain words for an error caught around an API call: a fetch that got no reply says so; an error
 * the server sent (including the admin service being down, `helper_*`) keeps the server's own
 * message; anything else gives its message, or the fallback when it has none.
 */
export function errorWords(error: unknown, fallback = "Something went wrong."): string {
  if (isNetworkError(error)) return NO_ANSWER_WORDS;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" && HELPER_CODES.has(code) && typeof message === "string" && message) return message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

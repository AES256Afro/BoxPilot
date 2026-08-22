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

export async function readJson<T>(response: Response, { allowStatus = [] }: ReadJsonOptions = {}): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string; errors?: string[] }) | null;
  if (response.ok || allowStatus.includes(response.status)) {
    if (body === null) throw new Error("BoxPilot sent a reply the page could not read. It may be restarting — try again in a moment.");
    return body;
  }
  if (body?.error) throw new Error(body.error);
  if (body?.errors?.length) throw new Error(body.errors.join(" | "));
  if (response.status === 401) throw new Error("Your session has expired. Sign in again.");
  if (response.status === 502 || response.status === 503 || response.status === 504) throw new Error("BoxPilot is not answering. It may be restarting — try again in a moment.");
  throw new Error(`Request failed (${response.status})`);
}

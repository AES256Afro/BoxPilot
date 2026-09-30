/**
 * The heartbeat: telling something outside this server that it is up (M39.3, ADR-008).
 *
 * On 2026-09-29 the server was off for three and a half hours and nothing told the owner, because
 * the thing that tells them, ntfy, runs on the same server. Nothing on a machine that is off can say
 * so; something elsewhere has to notice the silence. So, when the owner turns it on, this server
 * sends a bare request every few minutes to a dead man's switch they chose (healthchecks.io's free
 * plan, or Healthchecks or an Uptime Kuma "push" monitor on another machine), and that service alerts
 * their phone when the requests stop.
 *
 * What is sent: one GET to the address the owner pasted, with no body and no header of BoxPilot's.
 * No hostname, no address, no status: the receiving end learns the time and the address it came
 * from, which it sees for any request. One try per tick, ten seconds at most, never retried in a
 * loop: a ping that fails is recorded and the next tick is the retry.
 *
 * Off until the owner turns it on. The address is a credential (whoever has it can send fake
 * heartbeats), so it lives in the root-only credential store under `heartbeat-url` and is never
 * returned, logged or put in a job record; the interface can only see which host it goes to.
 *
 * The pinging is a systemd timer (deploy/boxpilot-heartbeat.timer) running a tiny script, not a
 * loop in BoxPilot, so it says "the server is up" rather than "BoxPilot is up": a BoxPilot restart
 * or upgrade does not trip the owner's alarm, and a server whose BoxPilot has crashed still reports
 * itself alive. It costs one short node process every few minutes.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCredentialStore } from "./credentials.mjs";

export const heartbeatCredential = "heartbeat-url";
export const heartbeatService = "boxpilot-heartbeat.service";
export const heartbeatTimer = "boxpilot-heartbeat.timer";
export const defaultStatusFile = process.env.BOXPILOT_HEARTBEAT_STATUS ?? "/var/lib/boxpilot-heartbeat/last.json";
export const dropInDirectory = process.env.BOXPILOT_HEARTBEAT_DROPIN ?? "/etc/systemd/system/boxpilot-heartbeat.timer.d";
export const dropInName = "interval.conf";
/** Minutes between pings the owner may choose; a dead man's switch needs its period set to match. */
export const intervalChoices = Object.freeze([1, 2, 5, 10, 15, 30, 60]);
export const defaultIntervalMinutes = 5;
export const pingTimeoutMs = 10_000;

/**
 * Whether an address can be a heartbeat target: http(s), no user name or password in it (the error
 * would quote it), and not the cloud metadata range, which no dead man's switch lives on. Loopback
 * and LAN addresses are allowed: an Uptime Kuma on another box on the LAN is the point.
 */
export function validateHeartbeatUrl(url) {
  if (typeof url !== "string" || !url || url.length > 2048) return "must be an http(s) address of at most 2048 characters";
  if (!URL.canParse(url)) return "is not an address";
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) return "must start with https:// or http://";
  if (parsed.username || parsed.password) return "must not carry a user name or password";
  if (/^169\.254\./.test(parsed.hostname) || parsed.hostname === "metadata.google.internal" || /^\[?fe80:/i.test(parsed.hostname)) return "must not be a link-local address";
  return null;
}

/** The host a saved address goes to, which is all the interface is told about it. */
export function hostOf(url) {
  try { return new URL(url).host || null; } catch { return null; }
}

/** Why a request failed, in words that never quote the address. */
function failureWords(error, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `no answer within ${Math.round(timeoutMs / 1000)} seconds`;
  const code = error?.cause?.code ?? error?.code ?? null;
  const words = { ENOTFOUND: "its name did not resolve", EAI_AGAIN: "its name did not resolve (DNS is not answering)", ECONNREFUSED: "the connection was refused", ECONNRESET: "the connection was reset", EHOSTUNREACH: "the host is unreachable", ENETUNREACH: "the network is unreachable", CERT_HAS_EXPIRED: "its certificate has expired", DEPTH_ZERO_SELF_SIGNED_CERT: "its certificate is self-signed", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its certificate could not be verified" };
  return words[code] ?? (code ? `the request failed (${code})` : "the request failed");
}

/** One bare GET. Resolves to what happened; never throws, never retries. */
export async function sendHeartbeat(url, { fetcher = fetch, timeoutMs = pingTimeoutMs, now = () => new Date() } = {}) {
  const started = now().getTime();
  try {
    const response = await fetcher(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    // The body is never read: only whether the switch took it. Released so the socket closes.
    await response.body?.cancel?.().catch(() => {});
    return { at: new Date(started).toISOString(), ok: response.ok, status: response.status, ms: now().getTime() - started, error: response.ok ? null : `it answered ${response.status}` };
  } catch (error) {
    return { at: new Date(started).toISOString(), ok: false, status: null, ms: now().getTime() - started, error: failureWords(error, timeoutMs) };
  }
}

/** Written whole through a temporary file, world-readable: it holds no secret, only what happened. */
export async function writeStatus(status, { file = defaultStatusFile } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o644 });
  await rename(temporary, file);
}

export async function readStatus({ file = defaultStatusFile, read = readFile } = {}) {
  try {
    const parsed = JSON.parse(await read(file, "utf8"));
    return parsed && typeof parsed.at === "string" ? { at: parsed.at, ok: parsed.ok === true, status: Number.isInteger(parsed.status) ? parsed.status : null, ms: Number.isFinite(parsed.ms) ? parsed.ms : null, error: typeof parsed.error === "string" ? parsed.error : null } : null;
  } catch {
    return null;
  }
}

/** What the timer runs: read the address, send one ping, record it. */
export async function pingOnce({ credentials = createCredentialStore(), fetcher = fetch, statusFile = defaultStatusFile, now = () => new Date(), timeoutMs = pingTimeoutMs } = {}) {
  const url = await credentials.read(heartbeatCredential).catch(() => null);
  const status = url
    ? await sendHeartbeat(url, { fetcher, timeoutMs, now })
    : { at: now().toISOString(), ok: false, status: null, ms: 0, error: "no heartbeat address is saved" };
  await writeStatus(status, { file: statusFile });
  return status;
}

/** The timer drop-in that sets the interval. The empty line first clears the unit's own. */
export function renderDropIn(minutes) {
  if (!intervalChoices.includes(minutes)) throw new Error(`The interval must be one of ${intervalChoices.join(", ")} minutes`);
  return [
    "# Written by BoxPilot (Settings, Notifications, Heartbeat). Rewritten when the interval changes.",
    "[Timer]",
    "OnUnitActiveSec=",
    `OnUnitActiveSec=${minutes}min`,
    "",
  ].join("\n");
}

export function parseDropIn(text) {
  const values = [...String(text ?? "").matchAll(/^OnUnitActiveSec=(\d+)min\s*$/gm)].map((match) => Number(match[1]));
  const minutes = values.at(-1);
  return intervalChoices.includes(minutes) ? minutes : null;
}

/** `systemctl show <timer> --property=UnitFileState,ActiveState`. */
export function parseTimerState(stdout) {
  const fields = Object.fromEntries(String(stdout ?? "").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]));
  return { installed: Boolean(fields.UnitFileState) && fields.LoadState !== "not-found", enabled: fields.UnitFileState === "enabled", active: fields.ActiveState === "active" };
}

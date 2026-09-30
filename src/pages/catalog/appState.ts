import { riskOf } from "../../ui/operationRisk";
import type { RiskTier, Status } from "../../ui/types";
import type { AppStats, LiveState, Manifest, Values } from "./types";

/*
 * What the catalog says about an app's state, in one place, so the tile, the sheet and the page's
 * verdict never disagree about it.
 */

/**
 * Docker calls a paused container "running" (the process exists, it is simply frozen), so every
 * check of `container.running` has to subtract paused explicitly, or a paused app looks healthy
 * and offers Stop but no Resume. Asking here once keeps the places that care in agreement.
 */
export const isPaused = (live: LiveState | null | undefined) => live?.container.status === "paused";

const tierRank: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
/**
 * The tier installing this app is staged and approved at: the higher of app.install's own and the
 * manifest's (server/catalog installRiskLookup, since the security audit). Pi-hole, AdGuard Home,
 * Technitium and wg-easy say high, so their Install says high before the click, as the approval
 * will; the button used to show app.install's medium for every app.
 */
export function installTier(manifest: Pick<Manifest, "risk">): RiskTier {
  const own = riskOf("app.install");
  const app = manifest.risk && manifest.risk in tierRank ? manifest.risk : own;
  return tierRank[app] > tierRank[own] ? app : own;
}
export const isRunning = (live: LiveState | null | undefined) => Boolean(live?.container.running) && !isPaused(live);
/** A weekly kill-switch drill that ended badly. One still starting or running has not failed. */
export const drillFailed = (lastResult?: string | null) => Boolean(lastResult) && !["completed", "started", "starting"].some((state) => lastResult!.startsWith(state));

/** A helper container down or restarting is the app being broken, however alive the main one looks. */
export function troubledSidecar(live: LiveState | null | undefined) {
  return (live?.sidecars ?? []).find((sidecar) => !sidecar.running || sidecar.status === "restarting") ?? null;
}

/**
 * An app's state as a status and its words. A VPN sidecar in a crash loop once showed as a green
 * "Running"; traffic that escaped the tunnel, or a folder the app cannot write to, is worse than
 * stopped, because it looks like working.
 */
export function appStatus(live: LiveState | null | undefined): { status: Status; label: string } {
  if (!live) return { status: "unknown", label: "Unknown" };
  if (!live.installed) return { status: "neutral", label: live.dataPresent ? "Not installed · data kept" : "Not installed" };
  if (live.killSwitchDrill?.leaked) return { status: "danger", label: "Leaked outside its VPN" };
  if ((live.folderProblems ?? []).length > 0) return { status: "danger", label: "Cannot write to its folder" };
  if (isPaused(live)) return { status: "warning", label: "Paused" };
  const troubled = troubledSidecar(live);
  if (live.container.running && troubled) return { status: "warning", label: `Running · ${troubled.id} ${troubled.status === "restarting" ? "is restarting" : "is down"}` };
  if (live.container.running) return live.container.health === "unhealthy" ? { status: "warning", label: "Running · unhealthy" } : { status: "good", label: "Running" };
  // Home calls an installed app with no container "No container" (the nightly clean-up removed it);
  // the catalog said "Stopped" of the same app, which Start does not look like it would fix.
  if (live.container.exists === false) return { status: "warning", label: "No container" };
  return { status: "warning", label: "Stopped" };
}

/**
 * The one short fact under an app's tile: what is wrong (in the fewest words: the tile reads out
 * the whole of it with the name), else an update, else what it costs.
 */
export function tileDetail(manifest: Manifest, live: LiveState | null, stats: AppStats | undefined): string {
  const state = appStatus(live);
  if (state.status !== "good") {
    if (live?.killSwitchDrill?.leaked) return "Leaked";
    if ((live?.folderProblems ?? []).length > 0) return "Cannot write";
    const troubled = live && !isPaused(live) && live.container.running ? troubledSidecar(live) : null;
    if (troubled) return `${troubled.id} ${troubled.status === "restarting" ? "restarting" : "down"}`;
    if (live?.container.running && live.container.health === "unhealthy") return "Unhealthy";
    return state.label;
  }
  if (live?.updateAvailable) return "Update ready";
  if (stats) return `${stats.cpuPercent.toFixed(1)}% · ${Math.round(stats.memBytes / 1024 / 1024)} MiB`;
  return manifest.image.version ?? "Running";
}

/**
 * How long the app was stopped while a backup was taken.
 *
 * Every backup record has carried this and none of them showed it. Backing an app up takes it
 * offline, and whether that matters depends entirely on the app and on how long: a fifth of a
 * second is nothing, ten seconds of a DNS server is every device on the network waiting. Worth
 * knowing before scheduling it to happen every night.
 */
export function offlineFor(downtimeMs: number | null): string {
  if (downtimeMs === null || downtimeMs === undefined) return "—";
  if (downtimeMs < 1000) return "under a second";
  const seconds = downtimeMs / 1000;
  if (seconds < 90) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** The form's starting values: what was chosen before, else the manifest's defaults. */
export function initialValues(manifest: Manifest, live: LiveState | null): Values {
  const stored = live?.state?.values;
  return {
    ports: Object.fromEntries(manifest.ports.map((port) => [port.id, stored?.ports?.[port.id] ?? port.host])),
    env: Object.fromEntries(manifest.env.filter((entry) => !entry.fixed && !entry.generate).map((entry) => [entry.name, stored?.env?.[entry.name] ?? (entry.default === null ? "" : String(entry.default))])),
    volumes: Object.fromEntries(manifest.volumes.filter((volume) => volume.configurable).map((volume) => [volume.id, stored?.volumes?.[volume.id] ?? volume.hostPath ?? ""])),
    // Setup choices (blocklists, plugins): what was chosen before, else the manifest's recommendations.
    ...(manifest.setup ? { setup: stored?.setup ?? manifest.setup.choices.filter((choice) => choice.recommended).map((choice) => choice.id) } : {}),
    ...((manifest.networkModes?.length ?? 0) > 1 ? { networkMode: stored?.networkMode ?? manifest.networkModes?.[0] } : {}),
  };
}

/**
 * Send only what differs from the baseline. On install the baseline is the manifest default; on
 * reconfigure it is the app's STORED value, because the server merges each field over the stored set
 * ({...stored, ...request}). Comparing to the manifest default there would silently drop a change
 * back to the default: turning "Use my VPN profile" from on to off, whose "off" IS the default,
 * left the stored "on" in place and the app stayed on the profile. Baseline-aware, that change is sent.
 */
export function compactValues(manifest: Manifest, values: Values, baseline?: Values): Values {
  const portBase = (id: string) => baseline?.ports?.[id] ?? manifest.ports.find((port) => port.id === id)?.host;
  const envBase = (name: string) => baseline?.env?.[name] ?? String(manifest.env.find((entry) => entry.name === name)?.default ?? "");
  const volumeBase = (id: string) => baseline?.volumes?.[id] ?? manifest.volumes.find((volume) => volume.id === id)?.hostPath;
  const ports = Object.fromEntries(Object.entries(values.ports).filter(([id, host]) => portBase(id) !== host));
  const env = Object.fromEntries(Object.entries(values.env).filter(([name, value]) => value !== "" && envBase(name) !== value));
  const volumes = Object.fromEntries(Object.entries(values.volumes).filter(([id, path]) => path !== "" && volumeBase(id) !== path));
  // Setup choices are always sent explicitly: an empty list means "none", not "the defaults".
  return { ports, env, volumes, ...((manifest.networkModes?.length ?? 0) > 1 && values.networkMode ? { networkMode: values.networkMode } : {}), ...(manifest.setup ? { setup: values.setup ?? [] } : {}) };
}

/** A read operation run with parameters, answering its body or the server's refusal in words. */
export async function runRead<T>(csrfToken: string, operationId: string, parameters: Record<string, unknown>, init: { signal?: AbortSignal } = {}): Promise<{ response: Response; body: { result?: T; error?: string; code?: string } }> {
  const response = await fetch(`/api/v1/operations/${operationId}/run`, { method: "POST", signal: init.signal, headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters }) });
  const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string; code?: string };
  return { response, body };
}

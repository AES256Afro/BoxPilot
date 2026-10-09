/**
 * DNS after a power cut (M39.2).
 *
 * When the server comes back from losing power, the owner's first question is whether the house has
 * its DNS back, and the second is whether the server itself can look names up (updates, image pulls
 * and BoxPilot's own upgrade all need it; on 2026-09-29 it could not). So, a few minutes after a boot
 * that followed an unclean end, this asks both, the way they are really used:
 *
 *   - the DNS app here (Pi-hole) on this server's LAN address, as a device on the LAN asks it;
 *   - the host through NSS (`getent`), which is what curl, apt and Docker use.
 *
 * Both answers go on the outage's own record, as lines of the after-outage list, and are kept here
 * too. Tried again a few times while the app is still starting; the last answer stands.
 *
 * Whether the previous boot ended uncleanly is feat/repair-dns-power's to say (server/power-loss.mjs).
 * `previousBootEndedUncleanly()` asks its function of that name when it is there, and otherwise
 * reads the outage it records (the `powerOutages` setting), so this works with it merged or not.
 */
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { dnsAppIds } from "./dns-resilience.mjs";
import { dnsBlockerVerify } from "./tasks/dns-check.mjs";

const execFile = promisify(execFileCallback);

export const outageChecksSetting = "outageDnsChecks";
/** Where server/power-loss.mjs records each outage it finds (feat/repair-dns-power). */
export const powerOutagesSetting = "powerOutages";
export const keptChecks = 10;
/** A name every server needs to resolve: the one BoxPilot's own upgrade and most images come from. */
export const hostLookupName = "github.com";

/** `getent ahostsv4 <name>`: NSS, the way curl, apt and Docker resolve. Exit 2 is "no such name". */
export async function getentLookup(name, { run = execFile, timeoutMs = 10_000 } = {}) {
  try {
    const { stdout } = await run("getent", ["ahostsv4", name], { timeout: timeoutMs, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" } });
    const addresses = [...new Set(String(stdout).split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry)))];
    return { ok: addresses.length > 0, addresses, error: addresses.length ? null : "no address came back" };
  } catch (error) {
    return { ok: false, addresses: [], error: error.code === 2 ? "no such name, or no DNS server answered" : error.killed ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : String(error.message ?? error).split("\n")[0] };
  }
}

/** The two checks, as lines for the after-outage list. Pure but for the lookups passed in. */
export async function checkDnsAfterOutage({ lanAddress = null, dnsApp = null, now = () => new Date() } = {}, { verify = dnsBlockerVerify, lookupHost = getentLookup } = {}) {
  const [app, host] = await Promise.all([
    dnsApp && lanAddress
      ? verify({ address: lanAddress, timeoutMs: 3000, checkInterception: false }).catch((error) => ({ answering: false, resolving: false, reason: error.message }))
      : null,
    lookupHost(hostLookupName),
  ]);
  const checks = [];
  if (app) {
    const ok = app.answering && app.resolving;
    checks.push({
      id: "dns-app-lan", ok,
      label: ok ? `${dnsApp.name} answers on the LAN` : `${dnsApp.name} is not answering on the LAN`,
      detail: ok ? `A lookup sent to ${lanAddress}, as a device on your network sends it, came back.`
        : app.answering ? `It answered on ${lanAddress} but could not look up a name that exists: its upstream is not reachable yet.`
          : `Nothing answered a lookup on ${lanAddress}. Devices that use it have no DNS until it does.`,
    });
  }
  checks.push({
    id: "host-lookups", ok: host.ok,
    label: host.ok ? "This server looks names up" : "This server cannot look names up",
    detail: host.ok ? `${hostLookupName} resolved through the system's resolver, as updates and image pulls resolve it.` : `${hostLookupName} did not resolve through the system's resolver: ${host.error}.`,
  });
  return { at: now().toISOString(), ok: checks.every((check) => check.ok), checks };
}

/**
 * server/power-loss.mjs, when feat/repair-dns-power has brought it. A module that may not be there
 * yet is imported by address, so nothing resolves it ahead of time; its absence is a rejection.
 */
const powerLossModule = new URL("./power-loss.mjs", import.meta.url).href;
const loadPowerLossModule = () => import(/* @vite-ignore */ powerLossModule);

/**
 * Did the boot before this one end without a shutdown? The outage, or null. `bootedAt` is when this
 * boot began: an outage recorded for an earlier boot is not this one's.
 */
export async function previousBootEndedUncleanly({ store, helper = null, bootedAt, now = () => new Date(), loadPowerLoss = loadPowerLossModule } = {}) {
  const powerLoss = await loadPowerLoss().catch(() => null);
  if (typeof powerLoss?.previousBootEndedUncleanly === "function" && powerLoss.previousBootEndedUncleanly !== previousBootEndedUncleanly) {
    const answer = await Promise.resolve().then(() => powerLoss.previousBootEndedUncleanly({ store, helper, bootedAt, now })).catch(() => null);
    if (answer === false || answer === null || answer === undefined) return null;
    if (typeof answer === "object") return { id: String(answer.id ?? answer.previousBootId ?? `boot-${bootedAt}`), stoppedAt: answer.stoppedAt ?? null, backAt: answer.backAt ?? null };
    return { id: `boot-${bootedAt}`, stoppedAt: null, backAt: new Date(bootedAt).toISOString() };
  }
  const outages = store?.getSetting?.(powerOutagesSetting, []) ?? [];
  const recent = (Array.isArray(outages) ? outages : []).find((entry) => entry?.id && Date.parse(entry.backAt ?? "") >= bootedAt - 10 * 60_000);
  return recent ? { id: String(recent.id), stoppedAt: recent.stoppedAt ?? null, backAt: recent.backAt ?? null } : null;
}

/** Put the answer on the outage's record, and keep it here: the newest few, by outage. */
export function recordOutageCheck(store, outage, result) {
  store.updateSetting(outageChecksSetting, {}, (entries) => {
    const kept = { ...(entries ?? {}), [outage.id]: { ...result, outage: { id: outage.id, stoppedAt: outage.stoppedAt ?? null, backAt: outage.backAt ?? null } } };
    const newest = Object.entries(kept).sort(([, left], [, right]) => String(right.at).localeCompare(String(left.at))).slice(0, keptChecks);
    return { value: Object.fromEntries(newest) };
  }, null);
  store.updateSetting(powerOutagesSetting, [], (entries) => {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.some((entry) => entry?.id === outage.id)) return { value: list };
    return { value: list.map((entry) => (entry?.id === outage.id ? { ...entry, dnsAfter: { at: result.at, ok: result.ok, checks: result.checks } } : entry)) };
  }, null);
}

/** The newest after-outage answer, for the Network page. */
export function latestOutageCheck(store) {
  const entries = Object.values(store?.getSetting?.(outageChecksSetting, {}) ?? {});
  return entries.sort((left, right) => String(right.at).localeCompare(String(left.at)))[0] ?? null;
}

/**
 * Once per start, a few minutes in: if this boot followed an unclean end, check and record. A boot
 * more than an hour old is not "after the outage" any more (BoxPilot restarted since), and is left.
 */
export function createOutageDnsWatch({ store, helper = null, network, dnsApp = async () => null, previous = previousBootEndedUncleanly, check = checkDnsAfterOutage, uptimeSeconds = () => os.uptime(), now = () => new Date(), delay = globalThis.setTimeout, firstDelayMs = 3 * 60_000, retryMs = 3 * 60_000, attempts = 4, freshBootMs = 60 * 60_000 } = {}) {
  async function once() {
    const bootedAt = now().getTime() - uptimeSeconds() * 1000;
    if (now().getTime() - bootedAt > freshBootMs) return { state: "old-boot" };
    const outage = await previous({ store, helper, bootedAt, now });
    if (!outage) return { state: "no-outage" };
    const topology = await network.inspect().catch(() => null);
    const route = topology?.defaultRoutes?.[0] ?? null;
    const lan = (topology?.eligibleLanAddresses ?? []).find((entry) => entry.interface === route?.interface) ?? topology?.eligibleLanAddresses?.[0] ?? null;
    const app = await dnsApp().catch(() => null);
    const result = await check({ lanAddress: lan?.address ?? null, dnsApp: app && dnsAppIds.includes(app.id) ? app : null, now });
    recordOutageCheck(store, outage, result);
    return { state: result.ok ? "ok" : "failing", outage, result };
  }

  function start() {
    let left = attempts;
    const attempt = () => {
      left -= 1;
      once().then((outcome) => {
        // Not yet recorded by the power-loss watch, or still starting: look again, a few times.
        if (left > 0 && (outcome.state === "failing" || outcome.state === "no-outage")) { const again = delay(attempt, retryMs); again?.unref?.(); }
      }).catch((error) => {
        if (left > 0) { const again = delay(attempt, retryMs); again?.unref?.(); } else console.warn(`[boxpilot] could not check DNS after the outage: ${error.message}`);
      });
    };
    const first = delay(attempt, firstDelayMs);
    first?.unref?.();
  }

  return { once, start };
}

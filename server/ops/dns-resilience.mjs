/**
 * DNS that survives this server being off (M39.2, ADR-008): the two pieces of the check that need the
 * helper, and the rehearsal. The check itself is read in the web service (server/dns-resilience.mjs).
 */
import { defineOperation } from "./registry.mjs";
import { askersDatabase, askersSql, canaryPattern, parseAskerRows, summarizeAskers } from "../dns-resilience.mjs";
import { rehearsalApps } from "../tasks/dns-rehearsal.mjs";

const minutes = (count) => count * 60_000;
const ipv4Pattern = /^\d{1,3}(\.\d{1,3}){3}$/;
const ipv4 = { type: "string", maxLength: 15, pattern: ipv4Pattern };
const dockerBinary = () => process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";

/**
 * Who asks Pi-hole, as counts (M39.2): for a server with a hand-set address, which has no DHCP lease
 * to show what the router hands out. Pi-hole's own database, read-only inside its container with the
 * `pihole-FTL sqlite3` the catalog already uses for gravity; no admin password. The addresses are
 * sorted into counts here, in the helper, and only the counts leave it: how many devices on the LAN
 * asked directly, whether the router did, how much was this server's own. "Not known" when Pi-hole
 * is not BoxPilot's, not running, or its database cannot be read, never a guess.
 */
export async function piholeAskers({ router = null, lanCidr = null, selfAddresses = [] } = {}, { localDns, run }) {
  const spec = await localDns?.internals?.platform?.().catch(() => null);
  if (!spec) return { available: false, reason: "No Pi-hole that BoxPilot manages is installed here, so there is no log to ask." };
  if (spec.id !== "pi-hole") return { available: false, reason: `${spec.label}'s log is not one BoxPilot reads.` };
  if (!spec.running || typeof run !== "function") return { available: false, reason: "Pi-hole is not running, so its log cannot be asked." };
  const result = await run(dockerBinary(), ["exec", `bp-${spec.id}`, "pihole-FTL", "sqlite3", "-readonly", "-cmd", ".timeout 5000", askersDatabase, askersSql], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (!result.ok) return { available: false, reason: "Pi-hole's query log could not be read." };
  return { available: true, reason: null, ...summarizeAskers(parseAskerRows(result.stdout), { router, lanCidr, selfAddresses }) };
}

/**
 * Whether BoxPilot's made-up names reached the DNS app's query log. Only names of the canary's own
 * shape can be looked for, so this cannot be used to ask whether anybody looked anything else up.
 */
export async function canarySeen(names, { localDns, run }) {
  const spec = await localDns?.internals?.platform?.().catch(() => null);
  if (!spec?.queryLog || !spec.running || typeof run !== "function") return { available: false, seen: {} };
  const result = await run(dockerBinary(), ["exec", `bp-${spec.id}`, "grep", "-F", "-o", ...names.flatMap((name) => ["-e", name]), spec.queryLog], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  // grep says 1 when nothing matched: that is an answer. Anything else is a log that could not be read.
  if (!result.ok && result.code !== 1) return { available: false, seen: {} };
  const found = new Set(String(result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
  return { available: true, seen: Object.fromEntries(names.map((name) => [name, found.has(name)])) };
}

export function dnsResilienceOperations() {
  return [
    defineOperation({
      id: "dns.blocker.canary", title: "Look for BoxPilot's test names in the DNS app's log", risk: "low", readOnly: true, timeoutMs: 45_000,
      description: "Whether made-up names BoxPilot just asked about reached the DNS app on this server, which is how the DNS check tells whether your router passes lookups here. Only BoxPilot's own made-up names can be looked for, and nothing else in the log is returned.",
      parameters: { fields: { names: { type: "array", validate: (value) => (value.length >= 1 && value.length <= 2 && value.every((name) => typeof name === "string" && canaryPattern.test(name)) ? null : "must be one or two of BoxPilot's test names") } } },
      run: (parameters, { localDns, run }) => canarySeen(parameters.names, { localDns, run }),
    }),
    defineOperation({
      // operator (ADR-003): it reads Pi-hole's query log in the root helper. Only counts come back, but
      // `router` may name any address, and how much one address asked is not a viewer's to probe. The
      // DNS check asks it itself, with the real gateway, for every role.
      id: "dns.blocker.askers", title: "Count who asks Pi-hole", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 45_000,
      description: "Reads Pi-hole's own query log, read-only, and counts who asked it in the last hour (or day): devices on your network, the router, this server. Only the counts are returned, never a device's address or a domain. It tells a router that hands this server out from one that passes lookups on.",
      parameters: { fields: {
        router: { ...ipv4, nullable: true },
        lanCidr: { type: "string", nullable: true, maxLength: 18, pattern: /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/ },
        selfAddresses: { type: "array", validate: (value) => (value.length <= 32 && value.every((entry) => typeof entry === "string" && ipv4Pattern.test(entry)) ? null : "must be at most 32 IPv4 addresses") },
      } },
      run: (parameters, { localDns, run }) => piholeAskers(parameters, { localDns, run }),
    }),
    defineOperation({
      id: "dns.fallback.rehearse", title: "Rehearse this server going down, for DNS", risk: "medium", timeoutMs: minutes(5),
      description: "Stops the DNS app on this server for about half a minute and asks your router for names it cannot have cached, to see whether the router falls back to another resolver. With a fallback, devices notice a slower lookup at most. Without one, nothing on your network can look names up until the app is back, up to a minute. The app is started again and the job waits until it answers; a safety timer starts it within three minutes if the job is cut off.",
      parameters: { fields: {
        router: ipv4,
        lanAddress: ipv4,
        app: { type: "string", enum: Object.keys(rehearsalApps) },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("dns.fallback.rehearse", parameters, { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
  ];
}

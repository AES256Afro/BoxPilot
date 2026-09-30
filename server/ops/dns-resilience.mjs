/**
 * DNS that survives this server being off (M39.2, ADR-008): the two pieces of the check that need the
 * helper, and the rehearsal. The check itself is read in the web service (server/dns-resilience.mjs).
 */
import { defineOperation } from "./registry.mjs";
import { canaryPattern } from "../dns-resilience.mjs";
import { rehearsalApps } from "../tasks/dns-rehearsal.mjs";

const minutes = (count) => count * 60_000;
const ipv4 = { type: "string", maxLength: 15, pattern: /^\d{1,3}(\.\d{1,3}){3}$/ };
const dockerBinary = () => process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";

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

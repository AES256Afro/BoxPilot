/**
 * Host listening-port inventory for prechecks (runs in the web service, which shares the host
 * network namespace). Parses `ss -H -l -n -t -u`.
 */
import { fixedRun } from "./exec.mjs";

export function parseListeners(output) {
  const listeners = [];
  for (const line of String(output ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !["tcp", "udp"].includes(fields[0])) continue;
    const endpoint = fields.at(-2);
    const separator = endpoint?.lastIndexOf(":") ?? -1;
    if (separator < 0) continue;
    const port = Number.parseInt(endpoint.slice(separator + 1), 10);
    if (!Number.isInteger(port)) continue;
    let address = endpoint.slice(0, separator).replace(/^\[|\]$/g, "");
    if (address.startsWith("%")) address = "*";
    const scope = ["*", "0.0.0.0", "::"].includes(address) ? "wildcard" : address === "::1" || address.startsWith("127.") ? "loopback" : "address";
    listeners.push({ protocol: fields[0], address, port, scope });
  }
  return listeners;
}

export async function listListeners({ run = fixedRun } = {}) {
  const result = await run("/usr/bin/ss", ["-H", "-l", "-n", "-t", "-u"], { timeout: 10_000 });
  return result.ok ? parseListeners(result.stdout) : [];
}

/**
 * `requested`: [{ id, host, protocol, exposure }]. A loopback-only bind conflicts with loopback or
 * wildcard listeners; a LAN bind conflicts with anything on that port.
 */
export function findPortConflicts(requested, listeners) {
  const conflicts = [];
  for (const request of requested) {
    const hits = listeners.filter((listener) => listener.protocol === request.protocol && listener.port === request.host && (request.exposure === "loopback" ? listener.scope !== "address" : true));
    if (hits.length) conflicts.push({ id: request.id, port: request.host, protocol: request.protocol, listeners: hits.map((hit) => `${hit.address}:${hit.port}`) });
  }
  return conflicts;
}

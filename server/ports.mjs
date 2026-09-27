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
 * Containers publishing `port`/`protocol`, from the Docker inventory (`docker ps` Ports text such as
 * "127.0.0.1:11434->11434/tcp, [::]:8080->80/tcp"). `ss` only shows docker-proxy for these, which
 * doesn't say whose port it is.
 */
export function containersPublishing(containers, port, protocol) {
  const wanted = protocol === "udp" ? "udp" : "tcp";
  const publishes = (text) => String(text ?? "").split(",").some((mapping) => {
    // "<addr>:<host port or range>-><container port or range>/<proto>"; unpublished ports have no "->".
    const match = /:(\d+)(?:-(\d+))?->[\d-]+\/(tcp|udp)$/.exec(mapping.trim());
    if (!match || match[3] !== wanted) return false;
    const low = Number(match[1]);
    const high = match[2] ? Number(match[2]) : low;
    return port >= low && port <= high;
  });
  return (containers ?? [])
    .filter((container) => publishes(container.ports))
    .map((container) => ({ name: container.name, app: container.app ?? null, composeProject: container.composeProject ?? null }));
}

/**
 * `requested`: [{ id, host, protocol, exposure }]. A loopback-only bind conflicts with loopback or
 * wildcard listeners; a LAN bind conflicts with anything on that port. With `containers` (the
 * Docker inventory), each conflict also names the containers holding the port.
 */
export function findPortConflicts(requested, listeners, containers = null) {
  const conflicts = [];
  for (const request of requested) {
    const hits = listeners.filter((listener) => listener.protocol === request.protocol && listener.port === request.host && (request.exposure === "loopback" ? listener.scope !== "address" : true));
    if (!hits.length) continue;
    const conflict = { id: request.id, port: request.host, protocol: request.protocol, listeners: hits.map((hit) => `${hit.address}:${hit.port}`) };
    if (containers) conflict.containers = containersPublishing(containers, request.host, request.protocol);
    conflicts.push(conflict);
  }
  return conflicts;
}

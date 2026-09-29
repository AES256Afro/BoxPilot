/**
 * Host listening-port inventory for prechecks. Parses `ss -H -l -n -t -u`, with or without `-p`:
 * the web service (which shares the host network namespace) runs it without, and the root task
 * `host.listeners` runs it with, which also names the process holding each socket.
 */
import { fixedRun } from "./exec.mjs";

/** The first process `ss -p` names for a socket: `users:(("tailscaled",pid=812,fd=33),...)`. */
function parseProcess(text) {
  const match = /\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(text ?? "");
  return match ? { name: match[1], pid: Number(match[2]) } : null;
}

export function parseListeners(output) {
  const listeners = [];
  for (const line of String(output ?? "").split("\n")) {
    let text = line.trim();
    // With -p the owning process is the last column. It is taken off first, because everything
    // else is read by position from the end of the line.
    let owner = null;
    const users = /\s(users:\(\(.*\)\))\s*$/.exec(text);
    if (users) { owner = parseProcess(users[1]); text = text.slice(0, users.index); }
    const fields = text.trim().split(/\s+/);
    if (fields.length < 5 || !["tcp", "udp"].includes(fields[0])) continue;
    const endpoint = fields.at(-2);
    const separator = endpoint?.lastIndexOf(":") ?? -1;
    if (separator < 0) continue;
    const port = Number.parseInt(endpoint.slice(separator + 1), 10);
    if (!Number.isInteger(port)) continue;
    let address = endpoint.slice(0, separator).replace(/^\[|\]$/g, "");
    // A socket bound to one interface: "127.0.0.53%lo", "*%tailscale0", "fe80::1%eth0".
    let device = null;
    const percent = address.indexOf("%");
    if (percent >= 0) { device = address.slice(percent + 1) || null; address = address.slice(0, percent) || "*"; }
    const scope = ["*", "0.0.0.0", "::"].includes(address) ? "wildcard" : address === "::1" || address.startsWith("127.") ? "loopback" : "address";
    listeners.push({ protocol: fields[0], address, port, scope, ...(device ? { device } : {}), ...(owner ? { process: owner } : {}) });
  }
  return listeners;
}

export async function listListeners({ run = fixedRun } = {}) {
  const result = await run("/usr/bin/ss", ["-H", "-l", "-n", "-t", "-u"], { timeout: 10_000 });
  return result.ok ? parseListeners(result.stdout) : [];
}

const ipv4 = (address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
/** An IPv6 socket bound to a v4-mapped address holds that IPv4 address. */
const unmapped = (address) => (/^::ffff:/i.test(address) && ipv4(address.slice(7)) ? address.slice(7) : address);

/**
 * The address a publish binds, as Docker reads it: "" (no address given) means every address of
 * both families, the way `ports: ["5001:5001"]` publishes.
 */
export function normalizeBind(bind) {
  const value = unmapped(String(bind ?? "").trim().replace(/^\[|\]$/g, ""));
  return value === "" ? "*" : value;
}

/** Whether a publish on `bind` answers on the tailnet address too: every address does. */
export function coversEveryAddress(bind) {
  return ["*", "0.0.0.0", "::"].includes(normalizeBind(bind));
}

/** Tailscale's own address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address) {
  const value = unmapped(String(address ?? ""));
  if (ipv4(value)) {
    const [first, second] = value.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(value);
}

/**
 * Whether a new socket bound to `bind` collides with an existing listener on the same port and
 * protocol, by Linux's rules for sockets without SO_REUSEPORT:
 *
 *   - a wildcard collides with every address of its family, and a specific address with the same
 *     address or its family's wildcard;
 *   - `*` (a dual-stack socket, or Docker's publish with no address) holds both families;
 *   - an IPv4 address and an IPv6-only socket share nothing.
 *
 * This is the rule the owner's server hit: tailscaled listening on 100.64.0.10:5001 for Serve, and
 * Docker failing to publish 0.0.0.0:5001 with "address already in use". It is also why the other
 * served apps work: 127.0.0.1:P and 100.64.0.10:P are two specific addresses and do not collide.
 */
export function bindCollides(bind, listener) {
  const want = normalizeBind(bind);
  const held = unmapped(String(listener?.address ?? ""));
  if (want === "*" || held === "*") return true;
  const family = (address) => (address === "0.0.0.0" || ipv4(address) ? 4 : 6);
  if (family(want) !== family(held)) return false;
  if (want === "0.0.0.0" || want === "::" || held === "0.0.0.0" || held === "::") return true;
  return want === held;
}

/**
 * Containers publishing `port`/`protocol`, from the Docker inventory (`docker ps` Ports text such as
 * "127.0.0.1:11434->11434/tcp, [::]:8080->80/tcp"). `ss` only shows docker-proxy for these, which
 * doesn't say whose port it is.
 */
export function containersPublishing(containers, port, protocol, address = null) {
  const wanted = protocol === "udp" ? "udp" : "tcp";
  const publishes = (text) => String(text ?? "").split(",").some((mapping) => {
    // "<addr>:<host port or range>-><container port or range>/<proto>"; unpublished ports have no "->".
    const match = /^(.*):(\d+)(?:-(\d+))?->[\d-]+\/(tcp|udp)$/.exec(mapping.trim());
    if (!match || match[4] !== wanted) return false;
    const low = Number(match[2]);
    const high = match[3] ? Number(match[3]) : low;
    if (port < low || port > high) return false;
    // With an address, only a publish on that address (docker-proxy binds exactly what was published).
    return address === null || normalizeBind(match[1]) === normalizeBind(address);
  });
  return (containers ?? [])
    .filter((container) => publishes(container.ports))
    .map((container) => ({ name: container.name, app: container.app ?? null, composeProject: container.composeProject ?? null }));
}

/**
 * `requested`: [{ id, host, protocol, exposure, bind? }]. With `bind` (the address the publish will
 * actually use), a request conflicts with exactly the listeners Linux would refuse it for. Without
 * one, the older advisory rule: a loopback-only bind conflicts with loopback or wildcard
 * listeners, a LAN bind with anything on that port. With `containers` (the Docker inventory), each
 * conflict also names the containers holding the port. `held` keeps the listeners themselves, with
 * the process `ss -p` named when it could.
 */
export function findPortConflicts(requested, listeners, containers = null) {
  const conflicts = [];
  for (const request of requested) {
    const accurate = request.bind !== undefined && request.bind !== null;
    const hits = listeners.filter((listener) => listener.protocol === request.protocol && listener.port === request.host
      && (accurate ? bindCollides(request.bind, listener) : request.exposure === "loopback" ? listener.scope !== "address" : true));
    if (!hits.length) continue;
    const conflict = { id: request.id, port: request.host, protocol: request.protocol, listeners: hits.map((hit) => `${hit.address}:${hit.port}`) };
    if (accurate) { conflict.bind = normalizeBind(request.bind); conflict.held = hits; }
    if (containers) conflict.containers = containersPublishing(containers, request.host, request.protocol);
    conflicts.push(conflict);
  }
  return conflicts;
}

/** Processes that hold a port on Docker's behalf: the userland proxy, or the daemon itself. */
const dockerProcesses = new Set(["docker-proxy", "dockerd", "rootlesskit", "rootlessport"]);

/** The port Serve forwards to, from its target (`http://127.0.0.1:5001`), or null. */
export function serveTargetPort(serve) {
  const match = /:(\d+)\/?\s*$/.exec(String(serve?.target ?? ""));
  return match ? Number(match[1]) : null;
}

/** A served address as a browser opens it. */
export function serveUrl(serve) {
  if (!serve?.dnsName || !Number.isInteger(serve.port)) return null;
  return `https://${serve.dnsName}${serve.port === 443 ? "" : `:${serve.port}`}`;
}

/**
 * Who holds a port a publish wants, one entry per holder:
 *
 *   { kind: "serve", address, serve, url, targetPort, self }  Tailscale Serve; `self` when it forwards to this app's own port
 *   { kind: "tailscale", address }                           tailscaled, for something other than a Serve entry
 *   { kind: "container", address, container }                another container publishing it
 *   { kind: "process", address, process }                    any other program, as `ss -p` named it
 *   { kind: "unknown", address }                             something, when nothing better is known
 *
 * `conflict` comes from findPortConflicts with `bind`. `own` says whether a container is this app's
 * own (its listeners are never a conflict with itself, and are left out). `serves` is `tailscale
 * serve status`; `selfPorts` are the ports this app publishes, to tell Serve fronting this very app
 * from Serve fronting another.
 */
export function portHolders(conflict, { serves = [], containers = null, own = () => false, selfPorts = [] } = {}) {
  const holders = [];
  const serve = conflict.protocol === "tcp" ? serves.find((entry) => entry.port === conflict.port) ?? null : null;
  const serveHolder = (address) => {
    const targetPort = serveTargetPort(serve);
    return { kind: "serve", address, serve, url: serveUrl(serve), targetPort, self: targetPort === null ? selfPorts.includes(conflict.port) : selfPorts.includes(targetPort) };
  };
  for (const listener of conflict.held ?? []) {
    const address = listener.address;
    const name = listener.process?.name ?? null;
    if (name === "tailscaled") { holders.push(serve ? serveHolder(address) : { kind: "tailscale", address }); continue; }
    if (name && !dockerProcesses.has(name)) { holders.push({ kind: "process", address, process: listener.process }); continue; }
    // Docker's own listener with no inventory to say whose: it may well be this app's own container
    // (a restart), so it is not called a conflict. Docker says so itself if it is one.
    if (name && containers === null) continue;
    // Docker's own listener, or one ss could not name: the inventory says whose it is, by the exact
    // address the container published.
    const publishing = containersPublishing(containers ?? [], conflict.port, conflict.protocol, address);
    const foreign = publishing.filter((container) => !own(container));
    if (publishing.length && !foreign.length) continue; // this app's own container
    if (foreign.length) { holders.push({ kind: "container", address, container: foreign[0] }); continue; }
    if (!name && isTailnetAddress(address)) { holders.push(serve ? serveHolder(address) : { kind: "tailscale", address }); continue; }
    holders.push(name ? { kind: "process", address, process: listener.process } : { kind: "unknown", address });
  }
  // One holder per kind and address is enough to say it; ss lists IPv4 and IPv6 sockets apart.
  const seen = new Set();
  return holders.filter((holder) => {
    const key = `${holder.kind}:${holder.container?.name ?? holder.process?.name ?? ""}:${holder.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where on the server a holder sits, in words. */
export function addressWords(address) {
  const value = unmapped(String(address ?? ""));
  if (["*", "0.0.0.0", "::"].includes(value)) return "on every address";
  if (isTailnetAddress(value)) return `on the tailnet address (${value})`;
  if (value === "::1" || value.startsWith("127.")) return `on this server's loopback address (${value})`;
  return `on ${value}`;
}

/**
 * One holder as the end of a sentence that starts "Port 5001 is taken ": "on the tailnet address
 * (100.64.0.10) by Tailscale Serve, which publishes Dockge itself at https://...:5001". `appName`
 * names this app; `nameOf(appId)` names another app, when a container or a Serve target is one.
 */
export function holderWords(holder, { appName = "this app", nameOf = () => null } = {}) {
  // A Serve entry tailscaled is not holding at this moment still claims the port on the tailnet address.
  const where = holder.address ? addressWords(holder.address) : "on the tailnet address";
  if (holder.kind === "serve") {
    const target = holder.self ? `${appName} itself` : holder.targetApp ? nameOf(holder.targetApp) ?? holder.targetApp : holder.targetPort ? `whatever answers on port ${holder.targetPort}` : "another address";
    return `${where} by Tailscale Serve, which publishes ${target}${holder.url ? ` at ${holder.url}` : ""}`;
  }
  if (holder.kind === "tailscale") return `${where} by Tailscale (tailscaled)`;
  if (holder.kind === "container") {
    const app = holder.container.app ? nameOf(holder.container.app) ?? holder.container.app : null;
    return `${where} by container ${holder.container.name}${app ? ` (${app})` : holder.container.composeProject ? ` (compose project ${holder.container.composeProject})` : ""}`;
  }
  if (holder.kind === "process") return `${where} by process ${holder.process.name}${Number.isInteger(holder.process.pid) ? ` (pid ${holder.process.pid})` : ""}`;
  return `${where} by another program on this server`;
}

/**
 * A port nobody holds, near `port`: the first one above it that no listener, no installed app and
 * no Serve entry uses. `taken` is a set of "port/protocol" strings already spoken for. Null when
 * there is none within reach (it will not wander far from the port the owner chose).
 */
export function freePortNear(port, { protocol = "tcp", listeners = [], taken = new Set(), serves = [], span = 200 } = {}) {
  const busy = (candidate) => taken.has(`${candidate}/${protocol}`)
    || listeners.some((listener) => listener.protocol === protocol && listener.port === candidate)
    || (protocol === "tcp" && serves.some((serve) => serve.port === candidate));
  for (let candidate = port + 1; candidate <= Math.min(port + span, 65535); candidate += 1) {
    if (!busy(candidate)) return candidate;
  }
  return null;
}

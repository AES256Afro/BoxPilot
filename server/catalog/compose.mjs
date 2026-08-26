import { randomBytes } from "node:crypto";
import YAML from "yaml";

export const projectPrefix = "bp";

/** Compose project/container name for an app id. Stable so uninstall/update can find it. */
export function projectNameFor(id) {
  return `${projectPrefix}-${id}`;
}

export function generateSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

const globCharacters = /[?*[]/;

/**
 * Compose interpolates `${NAME}` and `$NAME` in compose.yaml against the project's .env, and `$$`
 * is its literal dollar. Manifest authors use interpolation deliberately; an owner typing a setting
 * value does not — and a value of "${ADMIN_PASSWORD}" would otherwise be replaced by the app's real
 * secret. Everything the owner supplies is escaped on its way into compose.yaml.
 */
export function composeLiteral(value) {
  return String(value).replace(/\$/g, () => "$$");
}

/**
 * One line of a .env file. Compose expands `${NAME}` in an unquoted value — so a password holding
 * a dollar sign would silently become some other setting's value — but treats a single-quoted value
 * as literal, with \' the one escape it recognises inside. (Verified against docker compose config.)
 */
export function envFileLine(name, value) {
  return `${name}='${String(value).replace(/'/g, () => "\\'")}'`;
}

/**
 * Expand device globs (`/dev/sd?`, `/dev/nvme?`) against the host's /dev. Literal entries pass
 * through untouched; a glob that matches nothing is simply dropped, so one manifest works on
 * hosts with SATA, NVMe, or both. `listDirectory(dir)` returns entry names for a directory.
 */
/** Glob → anchored regex for one path segment: `?` one character, `*` any run, everything else literal. */
function segmentRegex(namePattern) {
  return new RegExp(`^${namePattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
}

/** True when a concrete /dev path matches one manifest device pattern (only the last segment may glob). */
export function deviceMatchesPattern(devicePath, pattern) {
  if (typeof devicePath !== "string" || typeof pattern !== "string") return false;
  if (!globCharacters.test(pattern)) return devicePath === pattern;
  const slash = pattern.lastIndexOf("/");
  const directory = pattern.slice(0, slash) || "/";
  if (globCharacters.test(directory)) return false;
  const deviceSlash = devicePath.lastIndexOf("/");
  return (devicePath.slice(0, deviceSlash) || "/") === directory && segmentRegex(pattern.slice(slash + 1)).test(devicePath.slice(deviceSlash + 1));
}
export async function resolveDevices(patterns, listDirectory) {
  const resolved = [];
  for (const pattern of patterns ?? []) {
    if (!globCharacters.test(pattern)) { resolved.push(pattern); continue; }
    const slash = pattern.lastIndexOf("/");
    const directory = pattern.slice(0, slash) || "/";
    const namePattern = pattern.slice(slash + 1);
    if (globCharacters.test(directory)) continue; // only the last path segment may be a glob
    const regex = new RegExp(`^${namePattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
    let entries = [];
    try { entries = await listDirectory(directory); } catch { entries = []; }
    for (const name of [...entries].sort()) if (regex.test(name)) resolved.push(`${directory}/${name}`);
  }
  return [...new Set(resolved)];
}

/**
 * Render a compose document and an .env file from a manifest + resolved values.
 * Secrets never go into compose.yaml; they are referenced as ${NAME} and live in .env (0600).
 * Returns `{ compose, composeYaml, envFile, env, hostPorts }`.
 */
/**
 * The address one port binds to, and what that leaves it reachable from.
 *
 * A manifest port marked `loopback` is private however the app is exposed. Otherwise the owner's
 * app-level choice decides, but only as far as the port's own `tailnet` mode allows: an HTTP port
 * steps back to loopback for Tailscale Serve to front, a protocol port moves to the tailnet
 * address so it is still reachable by the things that speak it, and a port that serves the house
 * by design stays where it is. Without a tailnet address to move to there is nothing better than
 * the LAN binding, and taking the port away entirely would be worse than leaving it.
 */
function bindingFor(port, appExposure, { lanAddress, tailnetAddress }) {
  if (port.exposure === "loopback") return { bind: "127.0.0.1", exposure: "loopback" };
  if (appExposure !== "tailnet") return { bind: lanAddress, exposure: port.exposure };
  const mode = port.tailnet ?? "serve";
  if (mode === "serve") return { bind: "127.0.0.1", exposure: "loopback" };
  if (mode === "address" && tailnetAddress) return { bind: tailnetAddress, exposure: "tailnet" };
  return { bind: lanAddress, exposure: port.exposure };
}

/**
 * `no-new-privileges` for everything, except where it makes the app impossible to run.
 *
 * An image that binds a privileged port as a non-root user does it with a file capability, which is
 * precisely what `no-new-privileges` refuses to honour. On Docker's own network namespace this
 * never comes up, because Docker sets `ip_unprivileged_port_start=0` inside it and any user may
 * bind port 53. Sharing the host's namespace is different: there the capability is required, it is
 * blocked, and the app starts and then binds nothing.
 *
 * Pi-hole in host mode is the case this exists for. It came up as a webserver that would not start
 * and a DNS server listening on nothing, with "Permission denied" against ports 53, 80 and 123 in
 * its log and `cap_net_bind_service` sitting unused on the binary.
 *
 * So the exemption is as narrow as the problem: host networking, and a port the app cannot bind
 * without help. Everything else keeps the flag, and an app in bridge mode is unaffected either way.
 */
export function securityOptFor(manifest, hostNetwork) {
  const needsPrivilegedBind = hostNetwork && (manifest.ports ?? []).some((port) => Number(port.host) > 0 && Number(port.host) < 1024);
  return needsPrivilegedBind ? [] : ["no-new-privileges:true"];
}

export function renderCompose(manifest, values, { existingEnv = {}, lanAddress = "0.0.0.0", tailnetAddress = null, devices = manifest.devices } = {}) {
  const env = { ...values.env };
  for (const entry of manifest.env) {
    if (entry.generate && !env[entry.name]) env[entry.name] = existingEnv[entry.name] || generateSecret();
  }
  const service = {
    container_name: projectNameFor(manifest.id),
    image: manifest.image.reference,
    restart: "unless-stopped",
    labels: { "io.boxpilot.app": manifest.id, "io.boxpilot.manifest-sha256": manifest.sha256 ?? "" },
  };
  if (manifest.user) service.user = manifest.user;
  if (manifest.command) service.command = manifest.command;
  // The owner's choice (validated against manifest.networkModes) wins over the manifest default.
  // Host mode shares the host's stack: no ports to publish, and no sidecars — a sidecar lives on
  // the project network the app no longer has.
  const network = (manifest.networkModes ?? [manifest.network]).includes(values.networkMode) ? values.networkMode : manifest.network;
  const hostNetwork = network === "host";
  if (hostNetwork) service.network_mode = "host";
  const hostPorts = [];
  const publishedPorts = !hostNetwork && manifest.network !== "host" && manifest.ports.length
    ? manifest.ports.map((port) => {
      const host = values.ports[port.id];
      const { bind, exposure } = bindingFor(port, values.exposure, { lanAddress, tailnetAddress });
      hostPorts.push({ id: port.id, host, protocol: port.protocol, exposure, tailnet: port.tailnet ?? "serve" });
      return `${bind}:${host}:${port.container}${port.protocol === "udp" ? "/udp" : ""}`;
    })
    : [];
  // With networkVia the app lives inside the sidecar's network namespace (a VPN container), so
  // the ports are published on the sidecar and the app has no network of its own.
  if (manifest.networkVia) service.network_mode = `service:${manifest.networkVia}`;
  else if (publishedPorts.length) service.ports = publishedPorts;
  if (manifest.volumes.length) {
    service.volumes = manifest.volumes.map((volume) => {
      const source = composeLiteral(volume.path ? `./${volume.path}` : values.volumes[volume.id] ?? volume.hostPath);
      return `${source}:${volume.container}${volume.readOnly ? ":ro" : ""}`;
    });
  }
  const environment = {};
  for (const entry of manifest.env) {
    if (!(entry.name in env)) continue;
    environment[entry.name] = entry.secret ? `\${${entry.name}}` : composeLiteral(env[entry.name]);
  }
  if (Object.keys(environment).length) service.environment = environment;
  if (manifest.capabilities.length) { service.cap_drop = ["ALL"]; service.cap_add = [...manifest.capabilities]; }
  if (devices.length) service.devices = devices.map((device) => `${device}:${device}`);
  if (manifest.extraHosts.length) service.extra_hosts = [...manifest.extraHosts];
  if ((manifest.sysctls ?? []).length) service.sysctls = Object.fromEntries(manifest.sysctls.map((entry) => entry.split("=")));
  if (manifest.shmSize) service.shm_size = manifest.shmSize;
  service.security_opt = securityOptFor(manifest, hostNetwork);
  const compose = { name: projectNameFor(manifest.id), services: { [manifest.id]: service } };
  // Sidecars: helper services on the project network, reachable from the app at their id.
  // No published ports; their env may reference ${NAME}, interpolated from the shared .env.
  for (const sidecar of hostNetwork ? [] : (manifest.sidecars ?? [])) {
    const sidecarService = {
      container_name: `${projectNameFor(manifest.id)}-${sidecar.id}`,
      image: sidecar.image,
      restart: "unless-stopped",
      labels: { "io.boxpilot.app": manifest.id, "io.boxpilot.sidecar": sidecar.id },
    };
    if (sidecar.command) sidecarService.command = sidecar.command;
    // Sidecar env may reference the app's settings as ${NAME}: secrets stay references (resolved
    // from .env at compose time); plain settings are substituted here since they never reach .env.
    const secretNames = new Set(manifest.env.filter((entry) => entry.secret).map((entry) => entry.name));
    const substitute = (value) => String(value).replace(/\$\{([A-Z][A-Za-z0-9_]*)\}/g, (match, name) => (secretNames.has(name) ? match : name in env ? composeLiteral(env[name]) : ""));
    if (Object.keys(sidecar.env ?? {}).length) sidecarService.environment = Object.fromEntries(Object.entries(sidecar.env).map(([name, value]) => [name, substitute(value)]));
    if (sidecar.volumes.length) sidecarService.volumes = sidecar.volumes.map((volume) => `./${volume.path}:${volume.container}`);
    if ((sidecar.capabilities ?? []).length) { sidecarService.cap_drop = ["ALL"]; sidecarService.cap_add = [...sidecar.capabilities]; }
    if ((sidecar.devices ?? []).length) sidecarService.devices = sidecar.devices.map((device) => `${device}:${device}`);
    if (manifest.networkVia === sidecar.id && publishedPorts.length) sidecarService.ports = publishedPorts;
    sidecarService.security_opt = ["no-new-privileges:true"];
    compose.services[sidecar.id] = sidecarService;
  }
  if (!hostNetwork && (manifest.sidecars ?? []).length) service.depends_on = manifest.sidecars.map((sidecar) => sidecar.id);
  const secretEntries = manifest.env.filter((entry) => entry.secret && entry.name in env);
  const envFile = secretEntries.map((entry) => envFileLine(entry.name, env[entry.name])).join("\n") + (secretEntries.length ? "\n" : "");
  return { compose, composeYaml: YAML.stringify(compose, { lineWidth: 0 }), envFile, env, hostPorts };
}

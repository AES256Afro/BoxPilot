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
 * Expand device globs (`/dev/sd?`, `/dev/nvme?`) against the host's /dev. Literal entries pass
 * through untouched; a glob that matches nothing is simply dropped, so one manifest works on
 * hosts with SATA, NVMe, or both. `listDirectory(dir)` returns entry names for a directory.
 */
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
export function renderCompose(manifest, values, { existingEnv = {}, lanAddress = "0.0.0.0", devices = manifest.devices } = {}) {
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
  if (manifest.network === "host") service.network_mode = "host";
  const hostPorts = [];
  const publishedPorts = manifest.network !== "host" && manifest.ports.length
    ? manifest.ports.map((port) => {
      const host = values.ports[port.id];
      hostPorts.push({ id: port.id, host, protocol: port.protocol, exposure: port.exposure });
      const bind = port.exposure === "loopback" ? "127.0.0.1" : lanAddress;
      return `${bind}:${host}:${port.container}${port.protocol === "udp" ? "/udp" : ""}`;
    })
    : [];
  // With networkVia the app lives inside the sidecar's network namespace (a VPN container), so
  // the ports are published on the sidecar and the app has no network of its own.
  if (manifest.networkVia) service.network_mode = `service:${manifest.networkVia}`;
  else if (publishedPorts.length) service.ports = publishedPorts;
  if (manifest.volumes.length) {
    service.volumes = manifest.volumes.map((volume) => {
      const source = volume.path ? `./${volume.path}` : values.volumes[volume.id] ?? volume.hostPath;
      return `${source}:${volume.container}${volume.readOnly ? ":ro" : ""}`;
    });
  }
  const environment = {};
  for (const entry of manifest.env) {
    if (!(entry.name in env)) continue;
    environment[entry.name] = entry.secret ? `\${${entry.name}}` : env[entry.name];
  }
  if (Object.keys(environment).length) service.environment = environment;
  if (manifest.capabilities.length) { service.cap_drop = ["ALL"]; service.cap_add = [...manifest.capabilities]; }
  if (devices.length) service.devices = devices.map((device) => `${device}:${device}`);
  if (manifest.extraHosts.length) service.extra_hosts = [...manifest.extraHosts];
  if ((manifest.sysctls ?? []).length) service.sysctls = Object.fromEntries(manifest.sysctls.map((entry) => entry.split("=")));
  service.security_opt = ["no-new-privileges:true"];
  const compose = { name: projectNameFor(manifest.id), services: { [manifest.id]: service } };
  // Sidecars: helper services on the project network, reachable from the app at their id.
  // No published ports; their env may reference ${NAME}, interpolated from the shared .env.
  for (const sidecar of manifest.sidecars ?? []) {
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
    const substitute = (value) => String(value).replace(/\$\{([A-Z][A-Za-z0-9_]*)\}/g, (match, name) => (secretNames.has(name) ? match : name in env ? env[name] : ""));
    if (Object.keys(sidecar.env ?? {}).length) sidecarService.environment = Object.fromEntries(Object.entries(sidecar.env).map(([name, value]) => [name, substitute(value)]));
    if (sidecar.volumes.length) sidecarService.volumes = sidecar.volumes.map((volume) => `./${volume.path}:${volume.container}`);
    if ((sidecar.capabilities ?? []).length) { sidecarService.cap_drop = ["ALL"]; sidecarService.cap_add = [...sidecar.capabilities]; }
    if ((sidecar.devices ?? []).length) sidecarService.devices = sidecar.devices.map((device) => `${device}:${device}`);
    if (manifest.networkVia === sidecar.id && publishedPorts.length) sidecarService.ports = publishedPorts;
    sidecarService.security_opt = ["no-new-privileges:true"];
    compose.services[sidecar.id] = sidecarService;
  }
  if ((manifest.sidecars ?? []).length) service.depends_on = manifest.sidecars.map((sidecar) => sidecar.id);
  const secretEntries = manifest.env.filter((entry) => entry.secret && entry.name in env);
  const envFile = secretEntries.map((entry) => `${entry.name}=${env[entry.name]}`).join("\n") + (secretEntries.length ? "\n" : "");
  return { compose, composeYaml: YAML.stringify(compose, { lineWidth: 0 }), envFile, env, hostPorts };
}

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

/**
 * Render a compose document and an .env file from a manifest + resolved values.
 * Secrets never go into compose.yaml; they are referenced as ${NAME} and live in .env (0600).
 * Returns `{ compose, composeYaml, envFile, env, hostPorts }`.
 */
export function renderCompose(manifest, values, { existingEnv = {}, lanAddress = "0.0.0.0" } = {}) {
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
  if (manifest.network !== "host" && manifest.ports.length) {
    service.ports = manifest.ports.map((port) => {
      const host = values.ports[port.id];
      hostPorts.push({ id: port.id, host, protocol: port.protocol, exposure: port.exposure });
      const bind = port.exposure === "loopback" ? "127.0.0.1" : lanAddress;
      return `${bind}:${host}:${port.container}${port.protocol === "udp" ? "/udp" : ""}`;
    });
  }
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
  if (manifest.devices.length) service.devices = manifest.devices.map((device) => `${device}:${device}`);
  if (manifest.extraHosts.length) service.extra_hosts = [...manifest.extraHosts];
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
    if (Object.keys(sidecar.env ?? {}).length) sidecarService.environment = { ...sidecar.env };
    if (sidecar.volumes.length) sidecarService.volumes = sidecar.volumes.map((volume) => `./${volume.path}:${volume.container}`);
    sidecarService.security_opt = ["no-new-privileges:true"];
    compose.services[sidecar.id] = sidecarService;
  }
  if ((manifest.sidecars ?? []).length) service.depends_on = manifest.sidecars.map((sidecar) => sidecar.id);
  const secretEntries = manifest.env.filter((entry) => entry.secret && entry.name in env);
  const envFile = secretEntries.map((entry) => `${entry.name}=${env[entry.name]}`).join("\n") + (secretEntries.length ? "\n" : "");
  return { compose, composeYaml: YAML.stringify(compose, { lineWidth: 0 }), envFile, env, hostPorts };
}

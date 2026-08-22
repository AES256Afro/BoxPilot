/**
 * Catalog manifest schema (v2). A manifest describes one installable Docker application
 * declaratively; the generic deployer (server/app-helper.mjs) turns it into a compose project.
 * Validation is strict: unknown keys are errors so typos never silently deploy something else.
 */

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const imagePattern = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/;
const envNamePattern = /^[A-Z][A-Za-z0-9_]{0,63}$/;
const keyPattern = /^[a-z][a-z0-9-]{0,31}$/;
const containerPathPattern = /^\/[^\0]*$/;
const relativePathPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const exposures = Object.freeze(["loopback", "lan"]);
export const healthKinds = Object.freeze(["running", "healthcheck"]);
export const envTypes = Object.freeze(["string", "password", "number", "boolean", "timezone", "path"]);
export const riskTiers = Object.freeze(["low", "medium", "high"]);

function fail(errors, path, message) { errors.push(`${path}: ${message}`); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function checkKeys(errors, path, value, allowed, required = []) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(errors, `${path}.${key}`, "is not a recognised field");
  for (const key of required) if (!(key in value)) fail(errors, `${path}.${key}`, "is required");
}

export function validateManifest(raw) {
  const errors = [];
  if (!isObject(raw)) return { manifest: null, errors: ["manifest: must be a mapping"] };
  checkKeys(errors, "manifest", raw, ["schemaVersion", "id", "name", "category", "description", "website", "icon", "risk", "image", "ports", "volumes", "env", "health", "capabilities", "devices", "extraHosts", "command", "user", "network", "notes", "uninstall", "sidecars", "setup", "networkVia", "sysctls"], ["schemaVersion", "id", "name", "category", "description", "image"]);
  if (raw.schemaVersion !== 2) fail(errors, "manifest.schemaVersion", "must be 2");
  if (typeof raw.id !== "string" || !idPattern.test(raw.id)) fail(errors, "manifest.id", "must be a short lower-case slug");
  for (const field of ["name", "category", "description"]) if (typeof raw[field] !== "string" || !raw[field].trim() || raw[field].length > 400) fail(errors, `manifest.${field}`, "must be a non-empty string");
  if (raw.website !== undefined && !(typeof raw.website === "string" && /^https:\/\/[^\s]+$/.test(raw.website))) fail(errors, "manifest.website", "must be an https URL");
  if (raw.icon !== undefined && !(typeof raw.icon === "string" && raw.icon.length <= 8)) fail(errors, "manifest.icon", "must be a short emoji/text");
  if (raw.risk !== undefined && !riskTiers.includes(raw.risk)) fail(errors, "manifest.risk", `must be one of ${riskTiers.join(", ")}`);
  if (raw.notes !== undefined && typeof raw.notes !== "string") fail(errors, "manifest.notes", "must be a string");
  if (raw.command !== undefined && !(Array.isArray(raw.command) && raw.command.every((part) => typeof part === "string"))) fail(errors, "manifest.command", "must be an array of strings");
  if (raw.user !== undefined && !(typeof raw.user === "string" && /^[0-9]{1,6}(:[0-9]{1,6})?$/.test(raw.user))) fail(errors, "manifest.user", "must be uid or uid:gid");
  if (raw.network !== undefined && !["bridge", "host"].includes(raw.network)) fail(errors, "manifest.network", "must be bridge or host");
  if (raw.uninstall !== undefined) {
    if (!isObject(raw.uninstall)) fail(errors, "manifest.uninstall", "must be a mapping");
    else checkKeys(errors, "manifest.uninstall", raw.uninstall, ["note"]);
  }

  // image
  if (!isObject(raw.image)) fail(errors, "manifest.image", "must be a mapping");
  else {
    checkKeys(errors, "manifest.image", raw.image, ["reference", "version"], ["reference"]);
    if (typeof raw.image.reference !== "string" || !imagePattern.test(raw.image.reference)) fail(errors, "manifest.image.reference", "must be a valid image reference (repo[:tag][@sha256:digest])");
    if (raw.image.version !== undefined && typeof raw.image.version !== "string") fail(errors, "manifest.image.version", "must be a string");
  }

  // ports
  const ports = Array.isArray(raw.ports) ? raw.ports : raw.ports === undefined ? [] : (fail(errors, "manifest.ports", "must be a list"), []);
  const portIds = new Set();
  ports.forEach((port, index) => {
    const path = `manifest.ports[${index}]`;
    if (!isObject(port)) return fail(errors, path, "must be a mapping");
    checkKeys(errors, path, port, ["id", "label", "container", "host", "protocol", "exposure", "fixed"], ["id", "container"]);
    if (typeof port.id !== "string" || !keyPattern.test(port.id) || portIds.has(port.id)) fail(errors, `${path}.id`, "must be a unique short slug"); else portIds.add(port.id);
    if (!Number.isInteger(port.container) || port.container < 1 || port.container > 65535) fail(errors, `${path}.container`, "must be a port number");
    if (port.host !== undefined && (!Number.isInteger(port.host) || port.host < 1 || port.host > 65535)) fail(errors, `${path}.host`, "must be a port number");
    if (port.protocol !== undefined && !["tcp", "udp"].includes(port.protocol)) fail(errors, `${path}.protocol`, "must be tcp or udp");
    if (port.exposure !== undefined && !exposures.includes(port.exposure)) fail(errors, `${path}.exposure`, `must be one of ${exposures.join(", ")}`);
    if (port.fixed !== undefined && typeof port.fixed !== "boolean") fail(errors, `${path}.fixed`, "must be boolean");
    if (port.label !== undefined && typeof port.label !== "string") fail(errors, `${path}.label`, "must be a string");
  });

  // volumes
  const volumes = Array.isArray(raw.volumes) ? raw.volumes : raw.volumes === undefined ? [] : (fail(errors, "manifest.volumes", "must be a list"), []);
  const volumeIds = new Set();
  volumes.forEach((volume, index) => {
    const path = `manifest.volumes[${index}]`;
    if (!isObject(volume)) return fail(errors, path, "must be a mapping");
    checkKeys(errors, path, volume, ["id", "label", "container", "path", "hostPath", "readOnly", "backup", "configurable", "description"], ["id", "container"]);
    if (typeof volume.id !== "string" || !keyPattern.test(volume.id) || volumeIds.has(volume.id)) fail(errors, `${path}.id`, "must be a unique short slug"); else volumeIds.add(volume.id);
    if (typeof volume.container !== "string" || !containerPathPattern.test(volume.container)) fail(errors, `${path}.container`, "must be an absolute container path");
    const managed = volume.path !== undefined; const external = volume.hostPath !== undefined;
    if (managed === external) fail(errors, path, "must set exactly one of path (managed, under the app directory) or hostPath (external)");
    if (managed && (typeof volume.path !== "string" || !relativePathPattern.test(volume.path))) fail(errors, `${path}.path`, "must be a simple relative directory name");
    if (external && (typeof volume.hostPath !== "string" || !containerPathPattern.test(volume.hostPath))) fail(errors, `${path}.hostPath`, "must be an absolute host path");
    for (const flag of ["readOnly", "backup", "configurable"]) if (volume[flag] !== undefined && typeof volume[flag] !== "boolean") fail(errors, `${path}.${flag}`, "must be boolean");
    if (volume.configurable && !external) fail(errors, `${path}.configurable`, "only external hostPath volumes can be configurable");
  });

  // env
  const env = Array.isArray(raw.env) ? raw.env : raw.env === undefined ? [] : (fail(errors, "manifest.env", "must be a list"), []);
  const envNames = new Set();
  env.forEach((entry, index) => {
    const path = `manifest.env[${index}]`;
    if (!isObject(entry)) return fail(errors, path, "must be a mapping");
    checkKeys(errors, path, entry, ["name", "label", "description", "type", "default", "required", "secret", "generate", "options", "fixed"], ["name"]);
    if (typeof entry.name !== "string" || !envNamePattern.test(entry.name) || envNames.has(entry.name)) fail(errors, `${path}.name`, "must be a unique environment variable name starting with a capital letter"); else envNames.add(entry.name);
    if (entry.type !== undefined && !envTypes.includes(entry.type)) fail(errors, `${path}.type`, `must be one of ${envTypes.join(", ")}`);
    for (const flag of ["required", "secret", "generate", "fixed"]) if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") fail(errors, `${path}.${flag}`, "must be boolean");
    if (entry.default !== undefined && !["string", "number", "boolean"].includes(typeof entry.default)) fail(errors, `${path}.default`, "must be a scalar");
    if (entry.options !== undefined && !(Array.isArray(entry.options) && entry.options.every((option) => typeof option === "string"))) fail(errors, `${path}.options`, "must be a list of strings");
    if (entry.generate && entry.type !== "password") fail(errors, `${path}.generate`, "only password entries can be generated");
    if (entry.fixed && entry.default === undefined) fail(errors, `${path}.fixed`, "fixed entries need a default");
  });

  // health
  if (raw.health !== undefined) {
    if (!isObject(raw.health)) fail(errors, "manifest.health", "must be a mapping");
    else {
      checkKeys(errors, "manifest.health", raw.health, ["kind", "stableSeconds", "timeoutSeconds"]);
      if (raw.health.kind !== undefined && !healthKinds.includes(raw.health.kind)) fail(errors, "manifest.health.kind", `must be one of ${healthKinds.join(", ")}`);
      for (const field of ["stableSeconds", "timeoutSeconds"]) if (raw.health[field] !== undefined && (!Number.isInteger(raw.health[field]) || raw.health[field] < 1 || raw.health[field] > 900)) fail(errors, `manifest.health.${field}`, "must be 1-900");
    }
  }

  // sidecars: unconfigurable helper services (a database, a broker) in the same compose project.
  // The main app reaches one at its sidecar id as hostname; sidecar env may reference ${VAR}
  // from the app's env (compose interpolates from the shared .env file).
  const sidecars = Array.isArray(raw.sidecars) ? raw.sidecars : raw.sidecars === undefined ? [] : (fail(errors, "manifest.sidecars", "must be a list"), []);
  const sidecarIds = new Set();
  const managedPaths = new Set(volumes.filter((volume) => isObject(volume) && typeof volume.path === "string").map((volume) => volume.path));
  sidecars.forEach((sidecar, index) => {
    const path = `manifest.sidecars[${index}]`;
    if (!isObject(sidecar)) return fail(errors, path, "must be a mapping");
    checkKeys(errors, path, sidecar, ["id", "image", "command", "env", "volumes", "capabilities", "devices"], ["id", "image"]);
    if (sidecar.capabilities !== undefined && !(Array.isArray(sidecar.capabilities) && sidecar.capabilities.every((cap) => typeof cap === "string" && /^CAP_[A-Z_]+$/.test(cap)))) fail(errors, `${path}.capabilities`, "entries must look like CAP_NET_ADMIN");
    if (sidecar.devices !== undefined && !(Array.isArray(sidecar.devices) && sidecar.devices.every((device) => typeof device === "string" && /^\/dev\/[A-Za-z0-9._/-]+$/.test(device)))) fail(errors, `${path}.devices`, "entries must be /dev paths");
    if (typeof sidecar.id !== "string" || !keyPattern.test(sidecar.id) || sidecarIds.has(sidecar.id) || sidecar.id === raw.id) fail(errors, `${path}.id`, "must be a unique short slug distinct from the app id"); else sidecarIds.add(sidecar.id);
    if (typeof sidecar.image !== "string" || !imagePattern.test(sidecar.image)) fail(errors, `${path}.image`, "must be a valid image reference");
    if (sidecar.command !== undefined && !(Array.isArray(sidecar.command) && sidecar.command.every((part) => typeof part === "string"))) fail(errors, `${path}.command`, "must be an array of strings");
    if (sidecar.env !== undefined && !(isObject(sidecar.env) && Object.entries(sidecar.env).every(([name, value]) => envNamePattern.test(name) && typeof value === "string" && value.length <= 512))) fail(errors, `${path}.env`, "must map variable names to strings");
    const sidecarVolumes = Array.isArray(sidecar.volumes) ? sidecar.volumes : sidecar.volumes === undefined ? [] : (fail(errors, `${path}.volumes`, "must be a list"), []);
    sidecarVolumes.forEach((volume, volumeIndex) => {
      const volumePath = `${path}.volumes[${volumeIndex}]`;
      if (!isObject(volume)) return fail(errors, volumePath, "must be a mapping");
      checkKeys(errors, volumePath, volume, ["id", "container", "path", "backup"], ["id", "container", "path"]);
      if (typeof volume.id !== "string" || !keyPattern.test(volume.id)) fail(errors, `${volumePath}.id`, "must be a short slug");
      if (typeof volume.container !== "string" || !containerPathPattern.test(volume.container)) fail(errors, `${volumePath}.container`, "must be an absolute container path");
      if (typeof volume.path !== "string" || !relativePathPattern.test(volume.path) || managedPaths.has(volume.path)) fail(errors, `${volumePath}.path`, "must be a unique relative directory name (sidecar data is always managed)"); else managedPaths.add(volume.path);
      if (volume.backup !== undefined && typeof volume.backup !== "boolean") fail(errors, `${volumePath}.backup`, "must be boolean");
    });
  });
  if (sidecars.length && raw.network === "host") fail(errors, "manifest.sidecars", "host-network apps cannot have sidecars (no compose network to reach them on)");
  // networkVia: the app shares a sidecar's network namespace (a VPN container) and its ports are published there.
  if (raw.networkVia !== undefined) {
    if (typeof raw.networkVia !== "string" || !sidecarIds.has(raw.networkVia)) fail(errors, "manifest.networkVia", "must name one of the sidecars");
    if (raw.network === "host") fail(errors, "manifest.networkVia", "cannot be combined with host networking");
  }

  // setup: optional post-install choices (blocklists, plugins) run inside the running container
  // with `docker compose exec`. Commands must be idempotent: they run again on every settings change.
  const argv = (value) => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((part) => typeof part === "string" && part.length <= 2048 && !/[\0]/.test(part));
  if (raw.setup !== undefined) {
    if (!isObject(raw.setup)) fail(errors, "manifest.setup", "must be a mapping");
    else {
      checkKeys(errors, "manifest.setup", raw.setup, ["title", "note", "finalize", "finalizeLabel", "choices"], ["title", "choices"]);
      if (typeof raw.setup.title !== "string" || !raw.setup.title.trim() || raw.setup.title.length > 80) fail(errors, "manifest.setup.title", "must be a short string");
      if (raw.setup.note !== undefined && typeof raw.setup.note !== "string") fail(errors, "manifest.setup.note", "must be a string");
      if (raw.setup.finalize !== undefined && !argv(raw.setup.finalize)) fail(errors, "manifest.setup.finalize", "must be a non-empty argv list");
      if (raw.setup.finalizeLabel !== undefined && typeof raw.setup.finalizeLabel !== "string") fail(errors, "manifest.setup.finalizeLabel", "must be a string");
      const choices = Array.isArray(raw.setup.choices) ? raw.setup.choices : (fail(errors, "manifest.setup.choices", "must be a list"), []);
      if (choices.length > 24) fail(errors, "manifest.setup.choices", "may list at most 24 choices");
      const choiceIds = new Set();
      choices.forEach((choice, index) => {
        const path = `manifest.setup.choices[${index}]`;
        if (!isObject(choice)) return fail(errors, path, "must be a mapping");
        checkKeys(errors, path, choice, ["id", "label", "description", "website", "recommended", "exec", "service"], ["id", "label", "exec"]);
        if (choice.service !== undefined && !(typeof choice.service === "string" && sidecarIds.has(choice.service))) fail(errors, `${path}.service`, "must name one of the sidecars");
        if (typeof choice.id !== "string" || !keyPattern.test(choice.id) || choiceIds.has(choice.id)) fail(errors, `${path}.id`, "must be a unique short slug"); else choiceIds.add(choice.id);
        if (typeof choice.label !== "string" || !choice.label.trim() || choice.label.length > 80) fail(errors, `${path}.label`, "must be a short string");
        if (choice.description !== undefined && typeof choice.description !== "string") fail(errors, `${path}.description`, "must be a string");
        if (choice.website !== undefined && !(typeof choice.website === "string" && /^https:\/\/[^\s]+$/.test(choice.website))) fail(errors, `${path}.website`, "must be an https URL");
        if (choice.recommended !== undefined && typeof choice.recommended !== "boolean") fail(errors, `${path}.recommended`, "must be boolean");
        if (!argv(choice.exec)) fail(errors, `${path}.exec`, "must be a non-empty argv list");
      });
    }
  }

  for (const listField of ["capabilities", "devices", "extraHosts"]) {
    if (raw[listField] !== undefined && !(Array.isArray(raw[listField]) && raw[listField].every((item) => typeof item === "string" && item.length <= 128 && !/\s/.test(item)))) fail(errors, `manifest.${listField}`, "must be a list of tokens");
  }
  if (Array.isArray(raw.capabilities) && raw.capabilities.some((cap) => !/^CAP_[A-Z_]+$/.test(cap))) fail(errors, "manifest.capabilities", "entries must look like CAP_NET_ADMIN");
  // Anything with host-level reach (Docker socket, host network, kernel-level capabilities) at least asks for a confirmation.
  const strongCapabilities = ["CAP_SYS_ADMIN", "CAP_SYS_MODULE", "CAP_SYS_RAWIO", "CAP_SYS_PTRACE", "CAP_NET_ADMIN", "CAP_DAC_READ_SEARCH"];
  const hostReach = (Array.isArray(raw.volumes) && raw.volumes.some((volume) => typeof volume?.hostPath === "string" && /docker\.sock$/.test(volume.hostPath)))
    || raw.network === "host"
    || (Array.isArray(raw.capabilities) && raw.capabilities.some((cap) => strongCapabilities.includes(cap)));
  if (hostReach && raw.risk === "low") fail(errors, "manifest.risk", "must be medium or high: this app reaches the Docker socket, the host network, or kernel capabilities");
  if (raw.sysctls !== undefined && !(Array.isArray(raw.sysctls) && raw.sysctls.length <= 16 && raw.sysctls.every((entry) => typeof entry === "string" && /^net\.[a-z0-9_.]+=[A-Za-z0-9_.-]+$/.test(entry)))) fail(errors, "manifest.sysctls", "entries must be net.* kernel settings like net.ipv4.ip_forward=1");
  if (Array.isArray(raw.devices) && raw.devices.some((device) => !/^\/dev\/[A-Za-z0-9._/?*[\]-]+$/.test(device))) fail(errors, "manifest.devices", "entries must be /dev paths (globs like /dev/sd? are resolved at install time)");

  if (errors.length) return { manifest: null, errors };

  const manifest = Object.freeze({
    schemaVersion: 2,
    id: raw.id,
    name: raw.name.trim(),
    category: raw.category.trim(),
    description: raw.description.trim(),
    website: raw.website ?? null,
    icon: raw.icon ?? null,
    risk: raw.risk ?? "medium",
    notes: raw.notes ?? null,
    image: { reference: raw.image.reference, version: raw.image.version ?? null, digestPinned: raw.image.reference.includes("@sha256:") },
    ports: ports.map((port) => ({ id: port.id, label: port.label ?? port.id, container: port.container, host: port.host ?? port.container, protocol: port.protocol ?? "tcp", exposure: port.exposure ?? "lan", fixed: port.fixed ?? false })),
    volumes: volumes.map((volume) => ({ id: volume.id, label: volume.label ?? volume.id, container: volume.container, path: volume.path ?? null, hostPath: volume.hostPath ?? null, readOnly: volume.readOnly ?? false, backup: volume.backup ?? (volume.path !== undefined), configurable: volume.configurable ?? false, description: volume.description ?? null })),
    env: env.map((entry) => ({ name: entry.name, label: entry.label ?? entry.name, description: entry.description ?? null, type: entry.type ?? "string", default: entry.default ?? null, required: entry.required ?? false, secret: entry.secret ?? entry.type === "password", generate: entry.generate ?? false, options: entry.options ?? null, fixed: entry.fixed ?? false })),
    health: { kind: raw.health?.kind ?? "running", stableSeconds: raw.health?.stableSeconds ?? 10, timeoutSeconds: raw.health?.timeoutSeconds ?? 180 },
    capabilities: raw.capabilities ?? [],
    devices: raw.devices ?? [],
    extraHosts: raw.extraHosts ?? [],
    command: raw.command ?? null,
    user: raw.user ?? null,
    network: raw.network ?? "bridge",
    uninstall: { note: raw.uninstall?.note ?? null },
    setup: raw.setup ? {
      title: raw.setup.title.trim(),
      note: raw.setup.note ?? null,
      finalize: raw.setup.finalize ?? null,
      finalizeLabel: raw.setup.finalizeLabel ?? null,
      choices: raw.setup.choices.map((choice) => ({ id: choice.id, label: choice.label.trim(), description: choice.description ?? null, website: choice.website ?? null, recommended: choice.recommended ?? false, exec: [...choice.exec], service: choice.service ?? null })),
    } : null,
    networkVia: raw.networkVia ?? null,
    sysctls: raw.sysctls ?? [],
    sidecars: sidecars.map((sidecar) => ({
      id: sidecar.id,
      image: sidecar.image,
      command: sidecar.command ?? null,
      env: sidecar.env ?? {},
      capabilities: sidecar.capabilities ?? [],
      devices: sidecar.devices ?? [],
      volumes: (sidecar.volumes ?? []).map((volume) => ({ id: volume.id, container: volume.container, path: volume.path, backup: volume.backup ?? true })),
    })),
  });
  return { manifest, errors: [] };
}

const hostPathDenyPrefixes = ["/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/run", "/var/run", "/var/lib/boxpilot", "/var/lib/boxpilot-managed", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/docker", "/var/lib/libvirt", "/opt/boxpilot", "/snap", "/var/lib/snapd"];

/** True when a (resolved) host path is one the deployer must never bind-mount. */
export function isDeniedHostPath(candidate) {
  const normalized = String(candidate ?? "").replace(/\/+$/, "") || "/";
  return normalized === "/" || hostPathDenyPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

/**
 * Validate user-supplied install values against a manifest. Returns `{ values, errors }` with
 * every port/env/volume filled in from defaults. `values` shape: `{ ports: {id: n}, env: {NAME: v}, volumes: {id: path} }`.
 */
export function resolveValues(manifest, raw = {}) {
  const errors = [];
  if (!isObject(raw)) return { values: null, errors: ["values must be an object"] };
  checkKeys(errors, "values", raw, ["ports", "env", "volumes", "setup"]);
  const ports = {}; const env = {}; const volumes = {};
  const rawPorts = isObject(raw.ports) ? raw.ports : raw.ports === undefined ? {} : (fail(errors, "values.ports", "must be an object"), {});
  for (const key of Object.keys(rawPorts)) if (!manifest.ports.some((port) => port.id === key)) fail(errors, `values.ports.${key}`, "is not a port of this application");
  for (const port of manifest.ports) {
    const provided = rawPorts[port.id];
    if (provided === undefined) { ports[port.id] = port.host; continue; }
    if (port.fixed && provided !== port.host) { fail(errors, `values.ports.${port.id}`, "is fixed for this application"); continue; }
    if (!Number.isInteger(provided) || provided < 1 || provided > 65535) { fail(errors, `values.ports.${port.id}`, "must be a port number"); continue; }
    ports[port.id] = provided;
  }
  const seen = new Map();
  for (const port of manifest.ports) { const key = `${ports[port.id]}/${port.protocol}`; if (seen.has(key) && seen.get(key) !== port.id) fail(errors, `values.ports.${port.id}`, `collides with ${seen.get(key)}`); seen.set(key, port.id); }

  const rawEnv = isObject(raw.env) ? raw.env : raw.env === undefined ? {} : (fail(errors, "values.env", "must be an object"), {});
  for (const key of Object.keys(rawEnv)) if (!manifest.env.some((entry) => entry.name === key)) fail(errors, `values.env.${key}`, "is not a setting of this application");
  for (const entry of manifest.env) {
    let value = rawEnv[entry.name];
    if (entry.fixed) { env[entry.name] = String(entry.default); continue; }
    if (value === undefined || value === "" || value === null) {
      if (entry.generate) { env[entry.name] = ""; continue; } // filled by the deployer with a random secret
      if (entry.default !== null && entry.default !== undefined) { env[entry.name] = String(entry.default); continue; }
      if (entry.required) fail(errors, `values.env.${entry.name}`, "is required");
      continue;
    }
    if (typeof value === "boolean") value = value ? "true" : "false";
    if (typeof value === "number") value = String(value);
    if (typeof value !== "string") { fail(errors, `values.env.${entry.name}`, "must be a string"); continue; }
    if (value.length > 512 || /[\0\r\n]/.test(value)) { fail(errors, `values.env.${entry.name}`, "is too long or contains line breaks"); continue; }
    if (entry.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) { fail(errors, `values.env.${entry.name}`, "must be a number"); continue; }
    if (entry.type === "boolean" && !["true", "false"].includes(value)) { fail(errors, `values.env.${entry.name}`, "must be true or false"); continue; }
    if (entry.type === "timezone" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) { fail(errors, `values.env.${entry.name}`, "must look like Region/City"); continue; }
    if (entry.type === "path" && !/^\/[^\0]*$/.test(value)) { fail(errors, `values.env.${entry.name}`, "must be an absolute path"); continue; }
    if (entry.options && !entry.options.includes(value)) { fail(errors, `values.env.${entry.name}`, `must be one of ${entry.options.join(", ")}`); continue; }
    env[entry.name] = value;
  }

  const rawVolumes = isObject(raw.volumes) ? raw.volumes : raw.volumes === undefined ? {} : (fail(errors, "values.volumes", "must be an object"), {});
  for (const key of Object.keys(rawVolumes)) if (!manifest.volumes.some((volume) => volume.id === key && volume.configurable)) fail(errors, `values.volumes.${key}`, "is not a configurable volume of this application");
  for (const volume of manifest.volumes) {
    if (!volume.hostPath) continue;
    const provided = rawVolumes[volume.id];
    if (provided === undefined) { volumes[volume.id] = volume.hostPath; continue; }
    if (typeof provided !== "string" || !/^\/[^\0]*$/.test(provided) || provided.includes("/../") || provided.endsWith("/..") || provided.length > 512) { fail(errors, `values.volumes.${volume.id}`, "must be a clean absolute path"); continue; }
    const normalized = provided.replace(/\/+$/, "") || "/";
    // "/./etc", "//etc", "/etc/." would pass a prefix test and still reach the real directory.
    if (normalized.split("/").some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))) { fail(errors, `values.volumes.${volume.id}`, "must be a clean absolute path (no empty, . or .. segments)"); continue; }
    if (isDeniedHostPath(normalized)) { fail(errors, `values.volumes.${volume.id}`, "points at a protected system location"); continue; }
    volumes[volume.id] = normalized;
  }
  // setup choices: unknown ids are errors; omitted on install means "the recommended ones".
  let setup;
  if (manifest.setup) {
    if (raw.setup === undefined) setup = manifest.setup.choices.filter((choice) => choice.recommended).map((choice) => choice.id);
    else if (!Array.isArray(raw.setup) || raw.setup.some((id) => typeof id !== "string")) fail(errors, "values.setup", "must be a list of choice ids");
    else {
      setup = [...new Set(raw.setup)];
      for (const id of setup) if (!manifest.setup.choices.some((choice) => choice.id === id)) fail(errors, `values.setup.${id}`, "is not a setup choice of this application");
    }
  } else if (raw.setup !== undefined && !(Array.isArray(raw.setup) && raw.setup.length === 0)) {
    fail(errors, "values.setup", "this application has no setup choices");
  }
  if (errors.length) return { values: null, errors };
  return { values: { ports, env, volumes, ...(manifest.setup ? { setup } : {}) }, errors: [] };
}

/**
 * Drop stored value keys the current manifest no longer accepts, so update/redeploy of an
 * installed app never fails on settings the operator could not change anyway (for example a
 * non-configurable volume echoed into old state, or a setting a manifest revision removed).
 */
export function sanitizeStoredValues(manifest, stored = {}) {
  const raw = isObject(stored) ? stored : {};
  const ports = isObject(raw.ports) ? raw.ports : {};
  const env = isObject(raw.env) ? raw.env : {};
  const volumes = isObject(raw.volumes) ? raw.volumes : {};
  return {
    ports: Object.fromEntries(Object.entries(ports).filter(([id]) => manifest.ports.some((port) => port.id === id))),
    env: Object.fromEntries(Object.entries(env).filter(([name]) => manifest.env.some((entry) => entry.name === name))),
    volumes: Object.fromEntries(Object.entries(volumes).filter(([id]) => manifest.volumes.some((volume) => volume.id === id && volume.configurable))),
    ...(manifest.setup && Array.isArray(raw.setup) ? { setup: raw.setup.filter((id) => manifest.setup.choices.some((choice) => choice.id === id)) } : {}),
  };
}

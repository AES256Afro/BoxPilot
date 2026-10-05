/**
 * What a compose file would hand its containers beyond what the catalog gives the app (sweep 4).
 *
 * A restore normally writes an app's compose file again from the catalog and the backup's saved
 * settings, and then the catalog decides what the containers get. Two kinds of backup are started
 * exactly as they were archived instead: one whose compose file the owner edited by hand
 * (`rawEdited`), and one whose saved settings are missing or no longer fit the catalog. A backup is
 * only as trustworthy as whoever last held the file, and a compose file can ask Docker for anything
 * root can have: a privileged container, the host's root folder or Docker's own socket mounted
 * inside, the host's network or process table, kernel capabilities, seccomp and AppArmor turned off,
 * the server's devices. Restored from a crafted archive on a plugged-in drive, that is root on the
 * server.
 *
 * `powerfulComposeSettings` reads such a file and lists every setting of that kind, per service,
 * measured against what the catalog grants the app: the manifest's capabilities, devices, host
 * network, read-only host folders, sysctls, GPU and images. It never touches the filesystem and
 * never interpolates: a value Docker would fill in from a variable (`${X}`) is listed as such,
 * because what it becomes depends on a file BoxPilot did not check. So the list is a function of the
 * compose text and the manifest alone, and the file's sha256 pins exactly what was reviewed.
 *
 * Findings marked `refuse` cannot be allowed at all: a file that does not parse, or one that pulls
 * in other files (`include`, `extends`), whose contents this cannot see.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import { deviceMatchesPattern } from "./compose.mjs";

/** The sha256 a restore's `allowCompose` names: of the compose file's text, exactly as archived. */
export function composeSha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** The same compose file, whatever line endings a copy of it picked up on the way. */
export function sameCompose(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const normal = (text) => text.replace(/\r\n?/g, "\n");
  return normal(a) === normal(b);
}

/**
 * Places that hand a container the server itself, or BoxPilot: mounted, any one of them is root on
 * the host or near enough. A folder holding one counts too (/var holds /var/lib/docker).
 */
const systemLocations = ["/etc", "/root", "/home", "/run", "/var/run", "/proc", "/sys", "/dev", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/docker", "/var/lib/containerd", "/var/lib/libvirt", "/var/lib/boxpilot", "/var/lib/boxpilot-managed", "/opt/boxpilot", "/etc/boxpilot", "/snap", "/var/lib/snapd"];
const named = new Map([["/", "the whole server"], ["/var/run/docker.sock", "Docker itself, which is root on this server"], ["/run/docker.sock", "Docker itself, which is root on this server"], ["/etc", "the server's configuration"], ["/root", "root's home folder"], ["/home", "everyone's home folders"], ["/proc", "the server's processes"], ["/sys", "the kernel's settings"], ["/dev", "the server's devices"], ["/boot", "the kernel and boot loader"], ["/var/lib/docker", "every container's files"], ["/run", "the server's running services"], ["/var/run", "the server's running services"]]);
export function isSystemLocation(candidate) {
  const normalized = String(candidate ?? "").replace(/\/+$/, "") || "/";
  return normalized === "/" || systemLocations.some((location) => normalized === location || normalized.startsWith(`${location}/`) || location.startsWith(`${normalized}/`));
}

const inside = (candidate, root) => {
  const base = root.replace(/\/+$/, "") || "/";
  return candidate === base || candidate.startsWith(base === "/" ? "/" : `${base}/`);
};

/** A value Docker fills in from a variable: anything with a `$` left once `$$` (a literal `$`) is taken out. */
const variableIn = (value) => typeof value === "string" && value.replace(/\$\$/g, "").includes("$");
/** A value as Docker reads it, `$$` being one `$`. */
const literal = (value) => String(value).replace(/\$\$/g, "$");
/** Whether a boolean-ish compose value is on. Anything but an explicit off is on: the safe reading. */
const isOn = (value) => !(value === false || value === null || value === undefined || value === 0 || (typeof value === "string" && /^(false|no|off|n|0)$/i.test(value.trim())));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const show = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * An image reference's repository, as Docker resolves it: `nginx:1.27` is
 * docker.io/library/nginx, a tag or digest does not count, case does not count.
 */
export function imageRepository(reference) {
  let ref = String(reference ?? "").trim();
  const at = ref.indexOf("@");
  if (at >= 0) ref = ref.slice(0, at);
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) ref = ref.slice(0, colon);
  const parts = ref.split("/").filter(Boolean);
  let registry = "docker.io";
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost")) registry = parts.shift();
  if (registry === "index.docker.io" || registry === "registry-1.docker.io") registry = "docker.io";
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return `${registry}/${parts.join("/")}`.toLowerCase();
}

const capability = (value) => String(value ?? "").trim().toUpperCase().replace(/^CAP_/, "");

/** What the catalog grants one service of the app: the app itself, or one of its sidecars. Null for a service it does not have. */
function grantsFor(manifest, service) {
  if (service === manifest.id) {
    return {
      image: manifest.image?.reference ?? null,
      capabilities: (manifest.capabilities ?? []).map(capability),
      devices: [...(manifest.devices ?? []), ...(manifest.optionalDevices ?? [])],
      gpu: Boolean(manifest.gpu),
      hostNetwork: manifest.network === "host" || (manifest.networkModes ?? []).includes("host"),
      networkVia: manifest.networkVia ?? null,
      hostPaths: (manifest.volumes ?? []).filter((volume) => volume.hostPath).map((volume) => ({ path: volume.hostPath, readOnly: Boolean(volume.readOnly) })),
      sysctls: new Set(manifest.sysctls ?? []),
    };
  }
  const sidecar = (manifest.sidecars ?? []).find((entry) => entry.id === service);
  if (!sidecar) return null;
  return {
    image: sidecar.image ?? null,
    capabilities: (sidecar.capabilities ?? []).map(capability),
    devices: sidecar.devices ?? [],
    gpu: Boolean(sidecar.gpu),
    hostNetwork: false,
    networkVia: null,
    // A sidecar's host folder is always read-only (catalog/schema.mjs).
    hostPaths: (sidecar.volumes ?? []).filter((volume) => volume.hostPath).map((volume) => ({ path: volume.hostPath, readOnly: true })),
    sysctls: new Set(),
  };
}

const none = { image: null, capabilities: [], devices: [], gpu: false, hostNetwork: false, networkVia: null, hostPaths: [], sysctls: new Set() };

/**
 * Every setting in `composeYaml` that reaches past what the catalog grants the app, per service:
 * `[{ service, setting, value, detail, system?, refuse? }]`, in the order the file has them.
 *
 * `manifest` is the app's catalog entry; `appId` its id, the service the app itself runs as.
 * `managedRoots` are the folders the app may mount as it likes: its own folder first (where a
 * relative path such as `./data` starts), then the data folders its saved settings name, which the
 * restore has already checked as an install would. A host path outside all of them, and not one the
 * manifest itself mounts, is listed; `system` marks one that hands over the server or BoxPilot.
 */
export function powerfulComposeSettings(composeYaml, options = {}) {
  return analyse(composeYaml, options).findings;
}

/**
 * The host paths inside the app's own folder (`managedRoots[0]`) that the file mounts or reads,
 * resolved: `[{ service, setting, path, shown }]`. None of them is listed as powerful, but that
 * folder is what the backup unpacked, so a restore looks at each for a link the archive put there
 * (`./data` -> `/`), which Docker would follow.
 */
export function appFolderMounts(composeYaml, options = {}) {
  return analyse(composeYaml, options).ownMounts;
}

function analyse(composeYaml, { manifest, appId = manifest?.id, managedRoots = [] } = {}) {
  const findings = [];
  const ownMounts = [];
  // A value Docker fills in from a variable is marked: what it becomes is up to the .env beside it.
  const add = (service, setting, value, detail, extra = {}) => {
    const shown = value === undefined ? null : show(value);
    findings.push({ service, setting, value: shown, detail, ...(shown !== null && variableIn(shown) ? { variable: true } : {}), ...extra });
  };
  const refuse = (service, setting, detail) => add(service, setting, undefined, detail, { refuse: true });
  let document;
  try {
    // Merge keys (`<<: *x`) are resolved as Compose resolves them, so a setting cannot hide in one.
    document = YAML.parse(String(composeYaml ?? ""), { merge: true, maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    refuse(null, "file", `is not a compose file BoxPilot can read (${String(error.message).split("\n")[0].slice(0, 160)})`);
    return { findings, ownMounts };
  }
  if (!isObject(document) || !isObject(document.services)) {
    refuse(null, "services", "names no services");
    return { findings, ownMounts };
  }
  if (document.include !== undefined) refuse(null, "include", "pulls in other compose files, whose settings BoxPilot cannot see from here");
  const roots = managedRoots.filter((root) => typeof root === "string" && root.startsWith("/")).map((root) => path.posix.normalize(root).replace(/\/+$/, "") || "/");
  const projectDirectory = roots[0] ?? "/";
  const services = Object.keys(document.services);

  /** A folder or file from the server mounted into a container: fine inside the app's own folders or where the manifest mounts it. */
  const hostPath = (service, setting, source, target, readOnly, grants) => {
    const raw = String(source ?? "");
    if (!raw) return;
    const shown = `${raw}${target ? `:${target}` : ""}${readOnly ? ":ro" : ""}`;
    if (variableIn(raw)) return add(service, setting, shown, `mounts a server folder named by a variable (${raw}), which Docker fills in from a file BoxPilot did not check`);
    let resolved = literal(raw);
    // `~` is the home of whoever runs compose: root, for the helper.
    if (resolved === "~" || resolved.startsWith("~/")) resolved = `/root${resolved.slice(1)}`;
    resolved = path.posix.resolve(projectDirectory, resolved).replace(/\/+$/, "") || "/";
    if (roots.length && inside(resolved, roots[0])) ownMounts.push({ service, setting, path: resolved, shown });
    if (roots.some((root) => inside(resolved, root))) return;
    const granted = grants.hostPaths.find((entry) => (entry.path.replace(/\/+$/, "") || "/") === resolved);
    if (granted) {
      if (granted.readOnly && !readOnly) add(service, setting, shown, `mounts ${resolved} read-write, where the catalog mounts it read-only`, { system: isSystemLocation(resolved) });
      return;
    }
    const what = named.get(resolved);
    const system = isSystemLocation(resolved);
    add(service, setting, shown, `mounts ${resolved}${what ? ` (${what})` : system ? ", a system location" : ""} from the server${target ? ` at ${target}` : ""}${readOnly ? ", read-only" : ""}`, { system });
  };

  for (const service of services) {
    const definition = document.services[service];
    if (!isObject(definition)) continue;
    const granted = grantsFor(manifest ?? {}, service);
    const grants = granted ?? none;
    if (!granted) add(service, "service", service, `is not part of ${manifest?.name ?? appId} in the catalog`);
    if (definition.extends !== undefined) refuse(service, "extends", "takes its settings from another service or file, which BoxPilot cannot see from here");

    // The image: the catalog's repository, at whatever version the backup ran.
    if (definition.image !== undefined && granted) {
      if (variableIn(definition.image)) add(service, "image", definition.image, "runs an image named by a variable, which Docker fills in from a file BoxPilot did not check");
      else if (grants.image && imageRepository(literal(definition.image)) !== imageRepository(grants.image)) add(service, "image", definition.image, `runs ${literal(definition.image)}, where the catalog runs ${grants.image.split("@")[0].replace(/:[^:/]*$/, "")}`);
    }
    if (definition.build !== undefined) add(service, "build", isObject(definition.build) ? definition.build.context ?? "." : definition.build, "is built on this server from a Dockerfile rather than pulled as the catalog's image");

    if (definition.privileged !== undefined && isOn(definition.privileged)) add(service, "privileged", definition.privileged, variableIn(definition.privileged) ? "may run privileged, set by a variable" : "runs privileged: every device and capability, no confinement - root on this server", { system: true });
    for (const hook of [...listOf(definition.post_start), ...listOf(definition.pre_stop)]) {
      if (isObject(hook) && hook.privileged !== undefined && isOn(hook.privileged)) add(service, "hooks", hook.command ?? "", "runs a lifecycle command privileged");
    }

    const extraCapabilities = listOf(definition.cap_add).filter((entry) => variableIn(entry) || capability(literal(entry)) === "ALL" || !grants.capabilities.includes(capability(literal(entry))));
    if (extraCapabilities.length) add(service, "cap_add", extraCapabilities.map(show).join(", "), `adds kernel capabilities the catalog does not give it: ${extraCapabilities.map((entry) => (variableIn(entry) ? `${entry} (a variable)` : capability(literal(entry)))).join(", ")}`);

    for (const entry of listOf(definition.devices)) {
      const host = isObject(entry) ? entry.source : String(entry).split(":")[0];
      if (variableIn(String(host ?? "")) || !grants.devices.some((pattern) => deviceMatchesPattern(literal(host ?? ""), pattern))) add(service, "devices", entry, `is given the server's device ${host ?? show(entry)}, which the catalog does not give it`, { system: true });
    }
    if (listOf(definition.device_cgroup_rules).length) add(service, "device_cgroup_rules", listOf(definition.device_cgroup_rules).map(show).join(", "), "may use server devices by number");
    if (definition.gpus !== undefined && !grants.gpu) add(service, "gpus", definition.gpus, "is given the server's GPUs, which the catalog does not give it");
    const reserved = definition.deploy?.resources?.reservations?.devices;
    if (Array.isArray(reserved) && reserved.length && !grants.gpu) add(service, "deploy.resources.reservations.devices", reserved, "reserves server devices, which the catalog does not give it");

    // Namespaces the container would share with the server, or with a container outside the app.
    const sibling = (value) => typeof value === "string" && value.startsWith("service:") && services.includes(value.slice(8));
    const shared = { network_mode: "network", pid: "process table", ipc: "shared memory", uts: "host name", userns_mode: "user namespace", cgroup: "control groups" };
    for (const [setting, what] of Object.entries(shared)) {
      const value = definition[setting];
      if (value === undefined || value === null) continue;
      if (variableIn(value)) { add(service, setting, value, `takes its ${what} from a variable, which Docker fills in from a file BoxPilot did not check`); continue; }
      const mode = literal(value).trim();
      if (mode === "host") {
        if (setting === "network_mode" && grants.hostNetwork) continue;
        add(service, setting, mode, `shares the server's own ${what}`, { system: setting !== "uts" });
      } else if (mode.startsWith("container:")) {
        add(service, setting, mode, `shares the ${what} of ${mode.slice(10)}, a container outside ${manifest?.name ?? appId}`);
      } else if (mode.startsWith("service:") && !sibling(mode)) {
        add(service, setting, mode, `shares the ${what} of ${mode.slice(8)}, which this file does not define`);
      }
    }

    // Confinement: every entry but no-new-privileges loosens or replaces it.
    const loosened = listOf(definition.security_opt).filter((entry) => !/^no-new-privileges(?:[:=](?:true|false))?$/i.test(String(entry).trim()));
    for (const entry of loosened) {
      const text = String(entry);
      add(service, "security_opt", text, /unconfined|disable/i.test(text) ? `turns confinement off (${text})` : `replaces the default confinement (${text})`, { system: /unconfined|disable/i.test(text) });
    }

    const sysctls = isObject(definition.sysctls)
      ? Object.entries(definition.sysctls).map(([key, value]) => `${key}=${value}`)
      : listOf(definition.sysctls).map(String);
    const extraSysctls = sysctls.filter((entry) => variableIn(entry) || !grants.sysctls.has(literal(entry)));
    if (extraSysctls.length) add(service, "sysctls", extraSysctls.join(", "), `changes kernel settings the catalog does not: ${extraSysctls.join(", ")}`);

    if (definition.cgroup_parent !== undefined) add(service, "cgroup_parent", definition.cgroup_parent, "runs under a control group of its own choosing, outside Docker's");
    if (listOf(definition.volumes_from).length) add(service, "volumes_from", listOf(definition.volumes_from).map(show).join(", "), "mounts every volume of another container");
    if (definition.runtime !== undefined) add(service, "runtime", definition.runtime, "runs on a container runtime other than Docker's own");
    if (definition.use_api_socket !== undefined && isOn(definition.use_api_socket)) add(service, "use_api_socket", definition.use_api_socket, "is handed Docker's API socket, which is root on this server", { system: true });
    if (definition.provider !== undefined) add(service, "provider", isObject(definition.provider) ? definition.provider.type ?? "" : definition.provider, "is run by a plugin on the server rather than as a container");

    for (const volume of listOf(definition.volumes)) {
      if (typeof volume === "string") {
        if (variableIn(volume)) { add(service, "volumes", volume, `mounts something named by a variable (${volume}), which Docker fills in from a file BoxPilot did not check`); continue; }
        const parts = volume.split(":");
        if (parts.length < 2) continue;                       // an anonymous volume: Docker's, inside the container only
        const [source, target, ...mode] = parts;
        const options = mode.join(",").split(",").map((option) => option.trim());
        if (/^[/.~]/.test(source)) {
          hostPath(service, "volumes", source, target, options.includes("ro") || options.includes("readonly"), grants);
          if (options.some((option) => /^r?shared$/.test(option))) add(service, "volumes", volume, `shares mounts made inside it with the server (${source})`);
        }
      } else if (isObject(volume)) {
        const type = volume.type ?? "volume";
        if (variableIn(String(volume.source ?? ""))) { add(service, "volumes", volume.source, `mounts something named by a variable (${volume.source}), which Docker fills in from a file BoxPilot did not check`); continue; }
        if (type === "bind") {
          hostPath(service, "volumes", volume.source, volume.target, isOn(volume.read_only ?? false), grants);
          if (/^r?shared$/.test(String(volume.bind?.propagation ?? ""))) add(service, "volumes", volume.source, `shares mounts made inside it with the server (${volume.source})`);
        } else if (!["volume", "tmpfs", "image"].includes(type)) add(service, "volumes", volume.source ?? type, `mounts a ${type}, which BoxPilot does not check`);
      }
    }
    for (const setting of ["env_file", "label_file"]) {
      for (const entry of listOf(definition[setting])) {
        const file = isObject(entry) ? entry.path : entry;
        if (typeof file === "string") hostPath(service, setting, file, null, true, grants);
      }
    }
  }

  // Docker volumes the file defines: one can be a bind of any folder, or a device, in disguise.
  for (const [name, definition] of Object.entries(isObject(document.volumes) ? document.volumes : {})) {
    if (!isObject(definition)) continue;
    if (definition.external !== undefined && isOn(definition.external)) add(null, "volumes", name, `uses the Docker volume ${definition.name ?? name}, made outside ${manifest?.name ?? appId}`);
    if (definition.driver !== undefined && definition.driver !== "local") add(null, "volumes", name, `uses the volume driver ${show(definition.driver)}`);
    const options = isObject(definition.driver_opts) ? definition.driver_opts : {};
    const device = options.device;
    if (typeof device === "string" && (device.startsWith("/") || variableIn(device))) {
      if (/(^|,)r?bind(,|$)/.test(String(options.o ?? "")) || variableIn(device)) hostPath(null, `volumes.${name}`, device, null, false, none);
      else add(null, "volumes", name, `mounts the server's device ${device}`, { system: true });
    }
  }
  // Secrets and configs read from a file on the server are mounted into the container as that file.
  for (const setting of ["secrets", "configs"]) {
    for (const [name, definition] of Object.entries(isObject(document[setting]) ? document[setting] : {})) {
      if (isObject(definition) && typeof definition.file === "string") hostPath(null, `${setting}.${name}`, definition.file, null, true, none);
    }
  }
  return { findings, ownMounts };
}

/** One line per setting, for a refusal or a job's warning: "demo: runs privileged...; extra: mounts /...". */
export function composeFindingsText(findings, { limit = 12 } = {}) {
  const lines = findings.map((finding) => `${finding.service ? `${finding.service}: ` : "the file "}${finding.detail}`);
  return `${lines.slice(0, limit).join("; ")}${lines.length > limit ? `; and ${lines.length - limit} more` : ""}`;
}

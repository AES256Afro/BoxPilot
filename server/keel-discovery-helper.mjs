import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const fixedPort = 3000;
const maximumHomes = 64;
const maximumDockerCandidates = 8;

async function defaultRunner(binary, args, { timeout = 5000 } = {}) {
  const result = await execFile(binary, args, {
    timeout,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function defaultHealthRequest() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port: fixedPort, path: "/api/health", timeout: 2500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length <= 8192) body += chunk;
        if (body.length > 8192) request.destroy(new Error("Health response exceeded the fixed limit"));
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve(response.statusCode === 200 && value?.app === "keel" && value?.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function regularFile(filePath, maximumBytes = null) {
  try {
    const value = await lstat(filePath);
    return value.isFile() && !value.isSymbolicLink() && (maximumBytes === null || value.size <= maximumBytes);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function safeDirectory(directoryPath) {
  try {
    const value = await lstat(directoryPath);
    return value.isDirectory() && !value.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readSmallFile(filePath, maximumBytes) {
  if (!await regularFile(filePath, maximumBytes)) return null;
  return readFile(filePath, "utf8");
}

async function enabledUnitLink(linkPath, unitPath) {
  try {
    const value = await lstat(linkPath);
    if (!value.isSymbolicLink()) return false;
    const target = await readlink(linkPath);
    return path.normalize(path.resolve(path.dirname(linkPath), target)) === path.normalize(unitPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function parseUnit(value) {
  const fields = {};
  for (const rawLine of String(value ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (!["WorkingDirectory", "ExecStart", "EnvironmentFile"].includes(key) || fields[key] !== undefined) continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

function containedPath(candidate, root) {
  if (!path.isAbsolute(candidate) || candidate.includes("\u0000")) return false;
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  return normalizedCandidate !== normalizedRoot && normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function unitMatchesSupportedTemplate(fields, installRoot) {
  return fields.WorkingDirectory === installRoot
    && fields.EnvironmentFile === path.join(installRoot, ".env")
    && /^\/[A-Za-z0-9._/+:-]+\/npm start$/.test(fields.ExecStart ?? "");
}

function parsePackage(value) {
  try {
    const parsed = JSON.parse(value);
    return {
      recognized: parsed?.name === "keel",
      version: typeof parsed?.version === "string" && /^[0-9A-Za-z.+_-]{1,32}$/.test(parsed.version) ? parsed.version : null,
    };
  } catch {
    return { recognized: false, version: null };
  }
}

function listenerExposure(output) {
  const lines = String(output ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "none";
  if (lines.some((line) => /(?:0\.0\.0\.0|\*|\[::\]):3000\b/.test(line))) return "wildcard";
  if (lines.some((line) => /(?:127\.0\.0\.1|\[::1\]):3000\b/.test(line))) {
    return lines.every((line) => /(?:127\.0\.0\.1|\[::1\]):3000\b/.test(line)) ? "loopback" : "lan";
  }
  return lines.some((line) => /:3000\b/.test(line)) ? "lan" : "unknown";
}

function dockerIdentity(value) {
  const parts = String(value ?? "").split("|");
  if (parts.length !== 4) return null;
  try {
    return { name: JSON.parse(parts[0]), image: JSON.parse(parts[1]), service: JSON.parse(parts[2]), state: JSON.parse(parts[3]) };
  } catch {
    return null;
  }
}

export function createKeelDiscoveryHelper({
  homeRoot = "/home",
  rootHome = "/root",
  optRoot = "/opt/keel",
  managedRoot = "/var/lib/boxpilot-managed/apps/keel/current",
  dockerBinary = "/usr/bin/docker",
  ssBinary = "/usr/bin/ss",
  runCommand = defaultRunner,
  requestHealth = defaultHealthRequest,
} = {}) {
  async function discoverHomeDescriptors(risks) {
    let names = [];
    try {
      names = (await readdir(homeRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-z_][a-z0-9_-]{0,31}$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (names.length > maximumHomes) risks.add("native-home-limit-exceeded");
    const descriptors = names.slice(0, maximumHomes).map((name) => ({ home: path.join(homeRoot, name), scope: "user-home" }));
    if (await safeDirectory(rootHome)) descriptors.push({ home: rootHome, scope: "root-home" });
    return descriptors;
  }

  async function discoverNative(risks) {
    const descriptors = await discoverHomeDescriptors(risks);
    const roots = new Map();
    const staleUnits = [];
    for (const descriptor of descriptors) {
      const unitPath = path.join(descriptor.home, ".config/systemd/user/keel.service");
      const unit = await readSmallFile(unitPath, 32768);
      const fields = unit === null ? null : parseUnit(unit);
      const defaultRoot = path.join(descriptor.home, "keel");
      if (await safeDirectory(defaultRoot)) roots.set(defaultRoot, { ...descriptor, unitPath, fields, unitPresent: unit !== null, source: "installer-default" });
      if (fields?.WorkingDirectory && containedPath(fields.WorkingDirectory, descriptor.home)) {
        const installRoot = path.normalize(fields.WorkingDirectory);
        if (await safeDirectory(installRoot)) roots.set(installRoot, { ...descriptor, unitPath, fields, unitPresent: true, source: installRoot === defaultRoot ? "installer-default" : "installer-custom-home" });
        else {
          risks.add("native-unit-install-root-missing");
          staleUnits.push({ ...descriptor, fields, source: "stale-user-unit" });
        }
      } else if (fields?.WorkingDirectory) {
        risks.add("native-unit-outside-home");
        staleUnits.push({ ...descriptor, fields, source: "changed-user-unit" });
      } else if (unit !== null) {
        risks.add("native-unit-template-changed");
        staleUnits.push({ ...descriptor, fields, source: "changed-user-unit" });
      }
    }
    for (const [installRoot, source] of [[optRoot, "system-opt"], [managedRoot, "boxpilot-managed"]]) {
      if (await safeDirectory(installRoot)) roots.set(path.normalize(installRoot), { home: null, scope: source, unitPath: null, fields: null, unitPresent: false, source });
    }

    const candidates = [];
    for (const [installRoot, descriptor] of roots) {
      const packageValue = await readSmallFile(path.join(installRoot, "package.json"), 65536);
      const packageIdentity = parsePackage(packageValue);
      if (!packageIdentity.recognized && !descriptor.unitPresent) continue;
      if (!packageIdentity.recognized) risks.add("native-package-unrecognized");
      if (!descriptor.unitPresent) risks.add("native-unit-missing");
      const unitTemplateMatched = descriptor.unitPresent ? unitMatchesSupportedTemplate(descriptor.fields, installRoot) : false;
      if (descriptor.unitPresent && !unitTemplateMatched) risks.add("native-unit-template-changed");
      const enabledLink = descriptor.home ? path.join(descriptor.home, ".config/systemd/user/default.target.wants/keel.service") : null;
      const unitEnabled = enabledLink ? await enabledUnitLink(enabledLink, descriptor.unitPath) : false;
      if (descriptor.unitPresent && !unitEnabled) risks.add("native-unit-not-enabled");
      candidates.push({
        kind: "native-user-service",
        source: descriptor.source,
        version: packageIdentity.version,
        packageRecognized: packageIdentity.recognized,
        unitFilePresent: descriptor.unitPresent,
        unitTemplateMatched,
        unitEnabled,
        databasePresent: await regularFile(path.join(installRoot, "data/keel.db")),
        managedSecretKeyPresent: await regularFile(path.join(installRoot, "data/.keel-server-secrets.key")),
        uploadsPresent: await safeDirectory(path.join(installRoot, "uploads")),
        backupsPresent: await safeDirectory(path.join(installRoot, "backups")),
      });
    }
    for (const descriptor of staleUnits) {
      candidates.push({
        kind: "native-user-service", source: descriptor.source, version: null, packageRecognized: false,
        unitFilePresent: true, unitTemplateMatched: false, unitEnabled: false, databasePresent: false,
        managedSecretKeyPresent: false, uploadsPresent: false, backupsPresent: false,
      });
    }
    return candidates;
  }

  async function discoverDocker(risks) {
    const ids = new Set();
    let available = true;
    for (const filter of ["label=com.docker.compose.service=keel", "name=^/keel$"]) {
      try {
        const result = await runCommand(dockerBinary, ["ps", "--all", "--filter", filter, "--format", "{{.ID}}"], { timeout: 5000 });
        for (const id of result.stdout.split("\n").map((item) => item.trim()).filter((item) => /^[a-f0-9]{12,64}$/.test(item))) ids.add(id);
      } catch {
        available = false;
        risks.add("docker-inspection-incomplete");
      }
    }
    if (!available && ids.size === 0) return { available: false, candidates: [] };
    if (ids.size > maximumDockerCandidates) risks.add("docker-candidate-limit-exceeded");
    const candidates = [];
    for (const id of [...ids].slice(0, maximumDockerCandidates)) {
      try {
        const identityResult = await runCommand(dockerBinary, ["inspect", "--format", "{{json .Name}}|{{json .Config.Image}}|{{json (index .Config.Labels \"com.docker.compose.service\")}}|{{json .State}}", id], { timeout: 5000 });
        const identity = dockerIdentity(identityResult.stdout);
        if (!identity || (identity.name !== "/keel" && identity.service !== "keel")) continue;
        const [ports, dataMount] = await Promise.all([
          runCommand(dockerBinary, ["port", id, "3000/tcp"], { timeout: 5000 }).catch(() => ({ stdout: "" })),
          runCommand(dockerBinary, ["inspect", "--format", "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Type}}|{{.RW}}{{end}}{{end}}", id], { timeout: 5000 }).catch(() => ({ stdout: "" })),
        ]);
        const publishedPorts = ports.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
        const loopbackPortPublished = publishedPorts.length > 0 && publishedPorts.every((line) => /^(?:127\.0\.0\.1|\[::1\]):\d+$/.test(line));
        if (publishedPorts.length > 0 && !loopbackPortPublished) risks.add("docker-non-loopback-publish");
        const persistentData = /^(?:volume|bind)\|true$/.test(dataMount.stdout.trim());
        if (!persistentData) risks.add("docker-data-not-persistent");
        candidates.push({
          kind: "docker",
          source: identity.service === "keel" ? "compose-service" : "exact-container-name",
          version: typeof identity.image === "string" && /:([0-9][0-9A-Za-z.+_-]{0,31})$/.test(identity.image) ? identity.image.match(/:([^:]+)$/)?.[1] ?? null : null,
          running: identity.state?.Running === true,
          containerHealthy: identity.state?.Health?.Status === "healthy" || (identity.state?.Running === true && identity.state?.Health === undefined),
          loopbackPortPublished,
          persistentData,
        });
      } catch {
        risks.add("docker-inspection-incomplete");
      }
    }
    return { available, candidates };
  }

  async function inspect() {
    const risks = new Set();
    const [native, docker, listenerResult] = await Promise.all([
      discoverNative(risks),
      discoverDocker(risks),
      runCommand(ssBinary, ["-H", "-ltn", "sport = :3000"], { timeout: 5000 }).catch(() => null),
    ]);
    const listener = listenerResult === null ? "unknown" : listenerExposure(listenerResult.stdout);
    if (["wildcard", "lan"].includes(listener)) risks.add("non-loopback-listener");
    if (listener === "unknown") risks.add("listener-inspection-incomplete");
    const healthIdentityVerified = listener === "none" ? false : await requestHealth();
    const candidates = [...native, ...docker.candidates];
    if (listener !== "none" && !healthIdentityVerified && candidates.length === 0) risks.add("unrecognized-port-3000-listener");
    if (candidates.length > 1) risks.add("multiple-installations");
    if (docker.candidates.some((item) => item.running && !item.containerHealthy)) risks.add("docker-health-failed");

    const runningDocker = docker.candidates.some((item) => item.running);
    const installed = candidates.length > 0 || healthIdentityVerified;
    const ambiguous = candidates.length > 1 || (installed && candidates.length === 0) || risks.size > 0;
    const healthy = installed && !ambiguous && healthIdentityVerified && listener === "loopback" && (docker.candidates.length === 0 || runningDocker);
    const state = !installed
      ? (listener === "none" && risks.size === 0 ? "not-installed" : "ambiguous")
      : ambiguous ? "ambiguous"
        : healthy ? "running"
          : runningDocker || healthIdentityVerified ? "unhealthy" : "stopped";
    const versions = [...new Set(candidates.map((item) => item.version).filter(Boolean))];
    const kind = native.length > 0 && docker.candidates.length > 0 ? "multiple" : native.length > 0 ? "native-user-service" : docker.candidates.length > 0 ? "docker" : healthIdentityVerified ? "unrecognized-keel" : null;
    const detail = state === "not-installed" ? "No supported Keel native-service or Docker installation was found"
      : state === "running" ? `Keel ${kind === "docker" ? "Docker" : "native user service"} answered the fixed loopback health check`
        : state === "stopped" ? "A Keel installation was found but did not answer the fixed loopback health check"
          : state === "unhealthy" ? "Keel evidence exists, but health or loopback exposure did not pass"
            : "Keel discovery found conflicting, incomplete, or unrecognized evidence";
    return {
      installed,
      state,
      healthy,
      kind,
      version: versions.length === 1 ? versions[0] : null,
      port: fixedPort,
      listener,
      healthIdentityVerified,
      native: { candidateCount: native.length, candidates: native },
      docker: { available: docker.available, candidateCount: docker.candidates.length, candidates: docker.candidates },
      risks: [...risks].sort(),
      detail,
      boundary: {
        mutationPerformed: false,
        environmentRead: false,
        databaseOpened: false,
        secretRead: false,
        arbitraryPathAccepted: false,
        arbitraryPortAccepted: false,
        serviceChanged: false,
        containerChanged: false,
      },
    };
  }

  return { inspect };
}

export const keelDiscoveryInternals = { containedPath, dockerIdentity, enabledUnitLink, listenerExposure, parsePackage, parseUnit, unitMatchesSupportedTemplate };

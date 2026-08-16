const fixedMountOptionNames = new Set(["async", "compress", "discard", "errors", "lazytime", "noatime", "nodev", "nodiratime", "noexec", "nosuid", "relatime", "ro", "rw", "sync"]);
const fixedDevicePattern = /^\/dev\/(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

function numberOrNull(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function percentOrNull(value) {
  const parsed = Number.parseInt(String(value ?? "").replace("%", ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function flatten(items, parent = null) {
  return (Array.isArray(items) ? items : []).flatMap((item) => [
    { item, parent },
    ...flatten(item?.children, item),
  ]);
}

function sanitizeMountTarget(value) {
  const target = String(value ?? "");
  if (!target.startsWith("/")) return "[unavailable]";
  if (target === "/root" || target.startsWith("/root/")) return "/root/[redacted]";
  if (target.startsWith("/home/")) return "/home/[redacted]";
  if (target.startsWith("/run/user/")) return "/run/user/[redacted]";
  return target.slice(0, 256);
}

function sanitizeMountSource(value) {
  const source = String(value ?? "");
  if (/^\/dev\/(?:mapper\/[a-zA-Z0-9+_.-]+|[a-zA-Z0-9+_.-]+)$/.test(source)) return source;
  if (["tmpfs", "overlay", "none"].includes(source)) return source;
  return "[remote-or-virtual-source]";
}

function mountOptionNames(value) {
  return [...new Set(String(value ?? "").split(",").map((item) => item.split("=", 1)[0]).filter((item) => fixedMountOptionNames.has(item)))].sort();
}

function capacityState(usedPercent) {
  if (usedPercent === null) return "unavailable";
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 85) return "warning";
  return "healthy";
}

function mountSummary(mounts) {
  return {
    healthy: mounts.filter((item) => item.capacityState === "healthy").length,
    warning: mounts.filter((item) => item.capacityState === "warning").length,
    critical: mounts.filter((item) => item.capacityState === "critical").length,
    unavailable: mounts.filter((item) => item.capacityState === "unavailable").length,
  };
}

export function parseMountInventory(output) {
  const parsed = parseJson(output);
  if (!parsed || !Array.isArray(parsed.filesystems)) return { available: false, namespace: "collector", mounts: [], summary: mountSummary([]) };
  const mounts = flatten(parsed.filesystems).map(({ item }) => {
    const usedPercent = percentOrNull(item?.["use%"]);
    const optionNames = mountOptionNames(item?.options);
    return {
      target: sanitizeMountTarget(item?.target),
      source: sanitizeMountSource(item?.source),
      filesystem: typeof item?.fstype === "string" ? item.fstype.slice(0, 32) : "unknown",
      totalBytes: numberOrNull(item?.size),
      usedBytes: numberOrNull(item?.used),
      availableBytes: numberOrNull(item?.avail),
      usedPercent,
      capacityState: capacityState(usedPercent),
      readOnly: optionNames.includes("ro") && !optionNames.includes("rw"),
      optionNames,
    };
  }).slice(0, 128);
  return {
    available: true,
    namespace: "collector",
    mounts,
    summary: mountSummary(mounts),
  };
}

export function normalizeMountEvidence(value, { schemaVersion = null, generatedAt = null, now = () => new Date() } = {}) {
  const generatedTime = typeof generatedAt === "string" ? Date.parse(generatedAt) : Number.NaN;
  const stale = !Number.isFinite(generatedTime) || now().getTime() - generatedTime > 24 * 60 * 60 * 1000 || generatedTime - now().getTime() > 5 * 60 * 1000;
  if (schemaVersion !== 1 || stale || !value || value.namespace !== "host-pid1" || value.available !== true || !Array.isArray(value.mounts)) {
    return { available: false, namespace: "unavailable", mounts: [], summary: mountSummary([]) };
  }
  const mounts = value.mounts.map((item) => {
    const usedPercent = percentOrNull(item?.usedPercent);
    const optionNames = mountOptionNames(Array.isArray(item?.optionNames) ? item.optionNames.join(",") : "");
    return {
      target: sanitizeMountTarget(item?.target),
      source: sanitizeMountSource(item?.source),
      filesystem: typeof item?.filesystem === "string" ? item.filesystem.slice(0, 32) : "unknown",
      totalBytes: numberOrNull(item?.totalBytes),
      usedBytes: numberOrNull(item?.usedBytes),
      availableBytes: numberOrNull(item?.availableBytes),
      usedPercent,
      capacityState: capacityState(usedPercent),
      readOnly: optionNames.includes("ro") && !optionNames.includes("rw"),
      optionNames,
    };
  }).slice(0, 128);
  return { available: true, namespace: "host-pid1", mounts, summary: mountSummary(mounts) };
}

export function parseBlockInventory(output) {
  const parsed = parseJson(output);
  if (!parsed || !Array.isArray(parsed.blockdevices)) return { available: false, devices: [] };
  const devices = flatten(parsed.blockdevices).map(({ item, parent }) => ({
    name: typeof item?.name === "string" && /^\/dev\/[a-zA-Z0-9+_.\/-]+$/.test(item.name) ? item.name.slice(0, 128) : "[unavailable]",
    parent: typeof parent?.name === "string" && /^\/dev\/[a-zA-Z0-9+_.\/-]+$/.test(parent.name) ? parent.name.slice(0, 128) : null,
    type: typeof item?.type === "string" ? item.type.slice(0, 24) : "unknown",
    filesystem: typeof item?.fstype === "string" ? item.fstype.slice(0, 32) : null,
    sizeBytes: numberOrNull(item?.size),
    mountTargets: (Array.isArray(item?.mountpoints) ? item.mountpoints : []).filter(Boolean).map(sanitizeMountTarget).slice(0, 16),
    rotational: typeof item?.rota === "boolean" ? item.rota : null,
    readOnly: typeof item?.ro === "boolean" ? item.ro : null,
    transport: typeof item?.tran === "string" ? item.tran.slice(0, 24) : null,
    model: typeof item?.model === "string" ? item.model.trim().slice(0, 96) : null,
  })).slice(0, 256);
  return { available: true, devices };
}

function normalizedSmartDisk(item) {
  const device = typeof item?.device === "string" && fixedDevicePattern.test(item.device) ? item.device : null;
  if (!device) return null;
  return {
    device,
    health: ["healthy", "warning", "critical", "unavailable"].includes(item.health) ? item.health : "unavailable",
    passed: typeof item.passed === "boolean" ? item.passed : null,
    temperatureCelsius: numberOrNull(item.temperatureCelsius),
    powerOnHours: numberOrNull(item.powerOnHours),
    percentageUsed: percentOrNull(item.percentageUsed),
    criticalWarning: numberOrNull(item.criticalWarning),
    mediaErrors: numberOrNull(item.mediaErrors),
    unsafeShutdowns: numberOrNull(item.unsafeShutdowns),
    reason: ["ok", "smartctl-read-failed", "unsupported-device"].includes(item.reason) ? item.reason : "smartctl-read-failed",
  };
}

export function normalizeSmartEvidence(value, { now = () => new Date() } = {}) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.disks) || typeof value.generatedAt !== "string") {
    return { available: false, status: "unavailable", reason: "storage-scan-evidence-missing", generatedAt: null, stale: true, disks: [], summary: { healthy: 0, warning: 0, critical: 0, unavailable: 0 } };
  }
  const generatedTime = Date.parse(value.generatedAt);
  const stale = !Number.isFinite(generatedTime) || now().getTime() - generatedTime > 24 * 60 * 60 * 1000 || generatedTime - now().getTime() > 5 * 60 * 1000;
  const disks = value.disks.map(normalizedSmartDisk).filter(Boolean).slice(0, 16);
  const available = value.available === true && disks.some((item) => item.health !== "unavailable");
  const summary = {
    healthy: disks.filter((item) => item.health === "healthy").length,
    warning: disks.filter((item) => item.health === "warning").length,
    critical: disks.filter((item) => item.health === "critical").length,
    unavailable: disks.filter((item) => item.health === "unavailable").length,
  };
  return {
    available,
    status: !available ? "unavailable" : stale ? "stale" : summary.critical > 0 ? "critical" : summary.warning > 0 || summary.unavailable > 0 ? "warning" : "healthy",
    reason: available ? (stale ? "storage-scan-evidence-stale" : "fixed-root-scan") : ["smartctl-not-installed", "no-supported-disks", "storage-scan-failed"].includes(value.reason) ? value.reason : "storage-scan-unavailable",
    generatedAt: Number.isFinite(generatedTime) ? new Date(generatedTime).toISOString() : null,
    stale,
    disks,
    summary,
    boundary: { mutationPerformed: false, serialsIncluded: false, rawOutputIncluded: false, browserTriggered: false },
  };
}

export const storageEvidenceInternals = { capacityState, fixedDevicePattern, fixedMountOptionNames, mountOptionNames, mountSummary, sanitizeMountSource, sanitizeMountTarget };

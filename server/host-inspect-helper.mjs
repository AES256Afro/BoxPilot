import { fixedRun } from "./exec.mjs";

/**
 * Read-only host inspection (helper side): Docker engine/inventory and the fixed, redacted
 * journal sources. Extracted from the retired legacy application helper — these reads power
 * the Overview and Logs pages and are independent of any application adapter.
 */

export const logSources = {
  boxpilot: ["boxpilot.service", "boxpilot-helper.service"],
  docker: ["docker.service"],
  tailscale: ["tailscaled.service"],
  virtualization: ["libvirtd.service", "virtqemud.service"],
};

function parseJsonLines(output) {
  return String(output ?? "").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export function sanitizeLogMessage(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[query-redacted]")
    .slice(0, 500);
}

export function createHostInspectHelper({
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  journalctlBinary = process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl",
  run = fixedRun,
} = {}) {
  const docker = (args, options = {}) => run(dockerBinary, args, { maxBuffer: 4 * 1024 * 1024, ...options });

  async function inspectDocker() {
    const result = await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    return { available: true, version: result.stdout || "available" };
  }

  async function inventoryDocker() {
    const [containerResult, imageResult, networkResult, volumeResult, projectResult] = await Promise.all([
      docker(["ps", "--all", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["image", "ls", "--digests", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["network", "ls", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["volume", "ls", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["compose", "ls", "--all", "--format", "json"], { timeout: 15000 }),
    ]);
    const containers = parseJsonLines(containerResult.stdout).map((item) => ({
      id: String(item.ID ?? "").slice(0, 12), name: item.Names ?? null, image: item.Image ?? null,
      state: item.State ?? "unknown", status: item.Status ?? "unknown", ports: item.Ports ?? "", networks: item.Networks ?? "",
    }));
    const images = parseJsonLines(imageResult.stdout).map((item) => ({ repository: item.Repository ?? null, tag: item.Tag ?? null, digest: item.Digest === "<none>" ? null : item.Digest ?? null, id: String(item.ID ?? "").slice(0, 19), size: item.Size ?? null }));
    const networks = parseJsonLines(networkResult.stdout).map((item) => ({ name: item.Name ?? null, driver: item.Driver ?? null, scope: item.Scope ?? null, internal: item.Internal === "true", ipv6: item.IPv6 === "true" }));
    const volumes = parseJsonLines(volumeResult.stdout).map((item) => ({ name: item.Name ?? null, driver: item.Driver ?? null, scope: item.Scope ?? null }));
    let projects = [];
    try {
      const parsed = JSON.parse(projectResult.stdout || "[]");
      projects = (Array.isArray(parsed) ? parsed : []).map((item) => ({ name: item.Name ?? null, status: item.Status ?? "unknown" }));
    } catch {
      projects = [];
    }
    return { available: true, containers, images, networks, volumes, projects };
  }

  async function inspectLogs({ source, limit }) {
    const units = logSources[source];
    if (!units) throw new Error("Unsupported log source");
    const args = units.flatMap((unit) => ["--unit", unit]);
    args.push("--lines", String(limit), "--no-pager", "--output", "json", "--utc");
    const result = await run(journalctlBinary, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return {
      source,
      entries: parseJsonLines(result.stdout).map((entry) => ({
        timestamp: entry.__REALTIME_TIMESTAMP ? new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString() : null,
        unit: entry._SYSTEMD_UNIT ?? entry.SYSLOG_IDENTIFIER ?? "unknown",
        priority: Number.parseInt(entry.PRIORITY ?? "6", 10),
        message: sanitizeLogMessage(entry.MESSAGE),
      })).filter((entry) => entry.message).slice(-limit).reverse(),
    };
  }

  return { inspectDocker, inventoryDocker, inspectLogs };
}

import { fixedRun } from "./exec.mjs";

/**
 * Read-only host inspection (helper side): Docker engine state and container inventory.
 * Journal reads moved to the logs.* registry operations.
 */

export function createHostInspectHelper({
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
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

  return { inspectDocker, inventoryDocker };
}

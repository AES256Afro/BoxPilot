import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function text(value, maximum = 200) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum) : null;
}

function finite(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : 0;
}

function list(value, maximum, mapper) {
  return (Array.isArray(value) ? value : []).slice(0, maximum).map(mapper);
}

function contentFromInventory(inventory) {
  return {
    schemaVersion: 1,
    source: {
      hostname: text(inventory.host?.hostname, 253), operatingSystem: text(inventory.host?.operatingSystem),
      kernel: text(inventory.host?.kernel), architecture: text(inventory.host?.architecture, 32), uptimeSeconds: finite(inventory.host?.uptimeSeconds),
    },
    capacity: {
      cpuCount: finite(inventory.compute?.cpuCount), totalMemoryBytes: finite(inventory.compute?.totalMemoryBytes),
      rootTotalBytes: finite(inventory.storage?.root?.totalBytes), rootFreeBytes: finite(inventory.storage?.root?.freeBytes),
    },
    network: {
      addresses: list(inventory.network?.addresses, 64, (item) => ({ interface: text(item.interface, 64), address: text(item.address, 64), cidr: text(item.cidr, 80) })),
      tailscale: { connected: Boolean(inventory.network?.tailscale?.connected), dnsName: text(inventory.network?.tailscale?.dnsName, 253) },
    },
    services: list(inventory.services, 100, (item) => ({ unit: text(item.unit, 128), load: text(item.load, 32), active: text(item.active, 32), enabled: text(item.enabled, 32) })),
    docker: {
      available: Boolean(inventory.docker?.available),
      containers: list(inventory.docker?.containers, 500, (item) => ({ id: text(item.id, 20), name: text(item.name, 128), image: text(item.image, 256), state: text(item.state, 32), status: text(item.status), ports: text(item.ports, 500), networks: text(item.networks, 500) })),
      images: list(inventory.docker?.images, 500, (item) => ({ repository: text(item.repository, 256), tag: text(item.tag, 128), digest: text(item.digest, 128), id: text(item.id, 64), size: text(item.size, 64) })),
      networks: list(inventory.docker?.networks, 200, (item) => ({ name: text(item.name, 128), driver: text(item.driver, 32), scope: text(item.scope, 32), internal: Boolean(item.internal), ipv6: Boolean(item.ipv6) })),
      volumes: list(inventory.docker?.volumes, 500, (item) => ({ name: text(item.name, 128), driver: text(item.driver, 32), scope: text(item.scope, 32) })),
      projects: list(inventory.docker?.projects, 200, (item) => ({ name: text(item.name, 128), status: text(item.status, 128) })),
    },
    protections: {
      readOnlyDiscovery: true,
      excluded: ["environment", "labels", "commands", "mount-paths", "compose-file-paths", "tailscale-peers", "credentials"],
    },
  };
}

function fingerprint(content) {
  return `sha256:${createHash("sha256").update(canonical(content)).digest("hex")}`;
}

function normalizeImportedManifest(value) {
  if (!value || value.schemaVersion !== 1 || !value.source || !value.docker) throw new Error("Unsupported or incomplete migration manifest");
  const normalized = contentFromInventory({
    host: value.source,
    compute: { cpuCount: value.capacity?.cpuCount, totalMemoryBytes: value.capacity?.totalMemoryBytes },
    storage: { root: { totalBytes: value.capacity?.rootTotalBytes, freeBytes: value.capacity?.rootFreeBytes } },
    network: value.network,
    services: value.services,
    docker: value.docker,
  });
  if (!normalized.source.hostname || !normalized.source.architecture) throw new Error("Migration manifest is missing source identity");
  const expected = fingerprint(normalized);
  if (value.fingerprint !== expected) throw new Error("Migration manifest fingerprint does not match its sanitized content");
  return { ...normalized, generatedAt: text(value.generatedAt, 40), fingerprint: expected };
}

function publishedPorts(containers) {
  const ports = new Set();
  for (const container of containers) {
    for (const match of String(container.ports ?? "").matchAll(/(?:^|[,\s])(?:[0-9a-fA-F:.\[\]]+:)?(\d+)->\d+\/(?:tcp|udp)/g)) ports.add(Number.parseInt(match[1], 10));
  }
  return ports;
}

export function createMigrationService({ store, inventory }) {
  async function exportManifest() {
    const content = contentFromInventory(await inventory.inspect());
    return { ...content, generatedAt: new Date().toISOString(), fingerprint: fingerprint(content) };
  }

  function importManifest(value, ownerId) {
    const manifest = normalizeImportedManifest(value);
    return store.importMigrationSource({ fingerprint: manifest.fingerprint, manifest, importedBy: ownerId });
  }

  function listSources() {
    return { sources: store.listMigrationSources().map((source) => ({
      id: source.id, fingerprint: source.fingerprint, importedAt: source.importedAt,
      source: source.manifest.source, capacity: source.manifest.capacity,
      counts: {
        containers: source.manifest.docker.containers.length, images: source.manifest.docker.images.length,
        networks: source.manifest.docker.networks.length, volumes: source.manifest.docker.volumes.length,
        projects: source.manifest.docker.projects.length,
      },
    })) };
  }

  async function plan(sourceId, ownerId) {
    const source = store.getMigrationSource(sourceId);
    if (!source) throw new Error("Migration source not found");
    const destination = await inventory.inspect();
    const blockers = [];
    const warnings = [];
    if (source.manifest.source.architecture !== destination.host.architecture) blockers.push({ id: "architecture", summary: `Source architecture ${source.manifest.source.architecture} differs from destination ${destination.host.architecture}` });
    if (source.manifest.docker.containers.length && !destination.docker.available) blockers.push({ id: "docker", summary: "Destination Docker inventory is unavailable" });
    const destinationNames = new Set(destination.docker.containers.map((item) => item.name));
    const nameConflicts = source.manifest.docker.containers.map((item) => item.name).filter((name) => name && destinationNames.has(name));
    if (nameConflicts.length) blockers.push({ id: "container-names", summary: `Container name conflicts: ${nameConflicts.join(", ")}` });
    const sourcePorts = publishedPorts(source.manifest.docker.containers);
    const destinationPorts = publishedPorts(destination.docker.containers);
    const portConflicts = [...sourcePorts].filter((port) => destinationPorts.has(port));
    if (portConflicts.length) blockers.push({ id: "published-ports", summary: `Published host port conflicts: ${portConflicts.join(", ")}` });
    if (source.manifest.capacity.rootTotalBytes > destination.storage.root?.freeBytes) warnings.push("The source root capacity exceeds currently reported destination free space. Transfer sizing requires per-workload data totals.");
    warnings.push("This imported manifest is a read-only snapshot. Refresh it immediately before transfer planning.");
    warnings.push("No source deletion or destination transfer operation exists in this release.");
    const output = {
      sourceId, sourceFingerprint: source.fingerprint, destinationGeneratedAt: destination.generatedAt,
      blockers, warnings, readyForTransferPlanning: blockers.length === 0, executable: false,
      changes: ["Preserve the source unchanged", "Map Docker projects, containers, networks, volumes, and published ports", "Calculate transferable data and downtime after a source-specific adapter is selected", "Require checksummed transfer and isolated destination verification before cutover"],
    };
    return store.createPlan({ type: "migration.compatibility", subjectId: sourceId, input: { sourceFingerprint: source.fingerprint }, output, createdBy: ownerId });
  }

  return { exportManifest, importManifest, listSources, plan };
}

export const migrationInternals = { canonical, contentFromInventory, fingerprint, normalizeImportedManifest, publishedPorts };

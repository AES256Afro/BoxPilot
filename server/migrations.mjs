import { createHash, randomUUID } from "node:crypto";

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

export function createMigrationService({ store, inventory, helper }) {
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
    warnings.push("This compatibility plan performs no transfer or source deletion. A separate exact local bundle is required for guarded staging.");
    const output = {
      sourceId, sourceFingerprint: source.fingerprint, destinationGeneratedAt: destination.generatedAt,
      blockers, warnings, readyForTransferPlanning: blockers.length === 0, executable: false,
      changes: ["Preserve the source unchanged", "Map Docker projects, containers, networks, volumes, and published ports", "Calculate transferable data and downtime after a source-specific adapter is selected", "Require checksummed transfer and isolated destination verification before cutover"],
    };
    return store.createPlan({ type: "migration.compatibility", subjectId: sourceId, input: { sourceFingerprint: source.fingerprint }, output, createdBy: ownerId });
  }

  async function inspectBundles() {
    if (!helper) throw new Error("Restricted migration helper is unavailable");
    const inspection = await helper.request("migration.bundle.inspect", {}, { timeoutMs: 12 * 60 * 60 * 1000 });
    const sourcesByFingerprint = new Map(store.listMigrationSources(200).map((source) => [source.fingerprint, source]));
    const transfersByBundle = new Map(store.listMigrationTransfers(200).map((transfer) => [transfer.bundleId, transfer]));
    return {
      ...inspection,
      bundles: (inspection.bundles ?? []).map((bundle) => {
        const source = sourcesByFingerprint.get(bundle.sourceFingerprint);
        const recorded = transfersByBundle.get(bundle.bundleId);
        const reconciliationRequired = bundle.destinationState === "completed" && !recorded;
        return {
          ...bundle,
          sourceId: source?.id ?? null,
          sourceHostname: source?.manifest?.source?.hostname ?? null,
          recordedTransferId: recorded?.id ?? null,
          reconciliationRequired,
          executable: Boolean(source) && (bundle.executable === true || reconciliationRequired),
          blockers: [
            ...(bundle.blockers ?? []),
            ...(!source ? ["Import the exact sanitized source manifest before planning this transfer"] : []),
            ...(recorded ? ["This exact staged bundle already has a durable verified transfer record"] : []),
          ],
        };
      }),
      transfers: store.listMigrationTransfers(),
    };
  }

  async function buildTransferPreview(bundleId, transferId = randomUUID()) {
    const inspection = await inspectBundles();
    const bundle = inspection.bundles.find((item) => item.bundleId === bundleId);
    if (!bundle) throw new Error("Migration bundle not found or invalid");
    const selectedTransferId = bundle.reconciliationRequired ? bundle.completedTransferId : transferId;
    if (!selectedTransferId) throw new Error("Completed migration staging evidence is missing its transfer id");
    const input = {
      transferId: selectedTransferId,
      bundleId: bundle.bundleId,
      sourceId: bundle.sourceId,
      sourceFingerprint: bundle.sourceFingerprint,
      contentRevision: bundle.contentRevision,
      expectedDestinationState: bundle.destinationState,
      expectedRemainingBytes: bundle.remainingBytes,
    };
    const output = {
      executable: bundle.executable === true,
      workloadName: bundle.workloadName,
      sourceHostname: bundle.sourceHostname,
      composeFile: bundle.composeFile,
      fileCount: bundle.fileCount,
      sensitiveFileCount: bundle.sensitiveFileCount,
      totalBytes: bundle.totalBytes,
      remainingBytes: bundle.remainingBytes,
      destinationState: bundle.destinationState,
      blockers: bundle.blockers,
      changes: bundle.reconciliationRequired ? [
        "Re-read the already complete root-only staging tree without copying or activating files",
        "Verify every source and staged file against the immutable bundle manifest",
        "Recover the missing durable Operations Core transfer record from exact helper evidence",
        "Keep the source bundle, source workload, containers, ports, routes, and DNS unchanged",
      ] : [
        `Copy or resume exactly ${bundle.fileCount} checksummed file(s) into a root-only server-generated staging directory`,
        "Verify every source and staged file against the immutable bundle manifest",
        "Record the verified transfer in Operations Core without exposing file contents or secrets to the browser",
        "Keep the source bundle, source workload, containers, ports, routes, and DNS unchanged",
      ],
      verification: ["Exact imported source fingerprint", "Immutable bundle content revision", "Per-file SHA-256 before and after copy", "Complete destination inventory", "Source bundle revalidation after copy"],
      warnings: [
        bundle.sensitiveFileCount ? `${bundle.sensitiveFileCount} file(s) match secret-sensitive naming rules. Their paths and contents remain helper-only.` : "No file matched the built-in secret-sensitive naming rules. Review application secrets before activation.",
        "This transfer stages files only. It does not parse or start Compose, expose ports, change routes or DNS, stop the source, or delete anything.",
        "An interrupted transfer leaves an isolated partial staging tree. A new plan resumes only files that still match their exact checksums.",
      ],
      recovery: "The immutable source bundle and source workload remain unchanged. If interrupted, create a new plan to resume exact verified files. Staged files are never activated automatically.",
      sourcePreserved: true,
      activationPerformed: false,
      reconciliationOnly: bundle.reconciliationRequired,
    };
    return { input, output };
  }

  async function planTransfer(bundleId, ownerId) {
    const preview = await buildTransferPreview(bundleId);
    return store.createPlan({ type: "migration.bundle.transfer", subjectId: bundleId, input: preview.input, output: preview.output, createdBy: ownerId });
  }

  async function revalidateTransfer(draft) {
    const current = await buildTransferPreview(draft.input.bundleId, draft.input.transferId);
    if (JSON.stringify(current.input) !== JSON.stringify(draft.input) || JSON.stringify(current.output) !== JSON.stringify(draft.output) || !current.output.executable) {
      throw new Error("The migration bundle, source manifest, capacity, or staging evidence changed after planning");
    }
    return current;
  }

  async function stageTransfer(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "migration.bundle.transfer") throw new Error("Migration transfer plan not found");
    if (draft.revision !== revision) throw new Error("Migration transfer plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Migration transfer plan is not executable");
    await revalidateTransfer(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "migration.bundle.transfer",
      title: `Stage migration bundle for ${draft.output.workloadName}`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Imported source fingerprint, immutable bundle revision, destination collision checks, and remaining capacity validated" },
        { name: "checkpoint", state: "completed", detail: "Source preservation confirmed; destination is isolated and supports checksum-based resume; activation and source deletion are disabled" },
      ],
    });
  }

  async function validateTransferJob(job) {
    if (job.type !== "migration.bundle.transfer") throw new Error("Unsupported migration transfer job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged migration transfer plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The migration transfer job inputs do not match the approved plan");
    await revalidateTransfer(staged);
    return staged;
  }

  function helperTransferInput(input) {
    return {
      transferId: input.transferId,
      bundleId: input.bundleId,
      sourceFingerprint: input.sourceFingerprint,
      contentRevision: input.contentRevision,
      expectedDestinationState: input.expectedDestinationState,
      expectedRemainingBytes: input.expectedRemainingBytes,
    };
  }

  function recordTransferResult(job, result) {
    const input = job.parameters.input;
    const staged = store.getPlan(job.parameters.planId);
    if (result?.created !== true || result?.transferId !== input.transferId || result?.bundleId !== input.bundleId
      || result?.sourceFingerprint !== input.sourceFingerprint || result?.contentRevision !== input.contentRevision
      || result?.contentVerified !== true || result?.sourcePreserved !== true || result?.activationPerformed !== false
      || result?.networkCutoverPerformed !== false || result?.sourceDeletionPerformed !== false
      || !staged || staged.type !== "migration.bundle.transfer" || staged.output.workloadName !== result?.workloadName
      || staged.output.fileCount !== result?.fileCount || staged.output.totalBytes !== result?.sizeBytes
      || result?.destination !== `managed-migration-staging/${input.bundleId}`) {
      throw new Error("Migration transfer evidence validation failed");
    }
    return store.recordMigrationTransfer({
      id: result.transferId,
      bundleId: result.bundleId,
      sourceId: input.sourceId,
      sourceFingerprint: result.sourceFingerprint,
      contentRevision: result.contentRevision,
      workloadName: result.workloadName,
      destination: result.destination,
      fileCount: result.fileCount,
      sizeBytes: result.sizeBytes,
      contentVerified: true,
      sourcePreserved: true,
      activationPerformed: false,
      createdBy: job.createdBy,
    });
  }

  function listTransfers() {
    return { transfers: store.listMigrationTransfers() };
  }

  return { exportManifest, importManifest, listSources, plan, inspectBundles, planTransfer, stageTransfer, validateTransferJob, helperTransferInput, recordTransferResult, listTransfers };
}

export const migrationInternals = { canonical, contentFromInventory, fingerprint, normalizeImportedManifest, publishedPorts };

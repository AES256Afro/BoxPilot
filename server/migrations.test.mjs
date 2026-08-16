import { describe, expect, it, vi } from "vitest";
import { createMigrationService, migrationInternals } from "./migrations.mjs";

function inventoryFixture(overrides = {}) {
  return {
    generatedAt: "2026-08-15T20:00:00Z",
    host: { hostname: "oldbox", operatingSystem: "Ubuntu", kernel: "7.0", architecture: "x64", uptimeSeconds: 100 },
    compute: { cpuCount: 8, totalMemoryBytes: 1000 }, storage: { root: { totalBytes: 10000, freeBytes: 8000 } },
    network: { addresses: [], tailscale: { connected: true, dnsName: "oldbox.example.ts.net" } }, services: [],
    docker: { available: true, containers: [{ id: "one", name: "app", image: "app:1", state: "running", status: "Up", ports: "0.0.0.0:8080->80/tcp", networks: "app" }], images: [], networks: [], volumes: [], projects: [], labels: { secret: "no" } },
    ...overrides,
  };
}

describe("read-only migration manifests", () => {
  it("exports a fingerprinted sanitized manifest", async () => {
    const inventory = { inspect: vi.fn(async () => inventoryFixture()) };
    const service = createMigrationService({ store: {}, inventory });
    const manifest = await service.exportManifest();
    expect(manifest.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.protections.readOnlyDiscovery).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("secret");
  });

  it("rejects tampering and ignores unrecognized sensitive fields", async () => {
    const inventory = { inspect: vi.fn(async () => inventoryFixture()) };
    const store = { importMigrationSource: vi.fn((value) => value) };
    const service = createMigrationService({ store, inventory });
    const manifest = await service.exportManifest();
    service.importManifest({ ...manifest, environment: { PASSWORD: "bad" } }, "owner-one");
    expect(JSON.stringify(store.importMigrationSource.mock.calls[0][0].manifest)).not.toContain("PASSWORD");
    expect(() => service.importManifest({ ...manifest, source: { ...manifest.source, hostname: "changed" } }, "owner-one")).toThrow("fingerprint");
  });

  it("plans architecture, name, and published-port conflicts without enabling transfer", async () => {
    const sourceInventory = inventoryFixture();
    const content = migrationInternals.contentFromInventory(sourceInventory);
    const source = { id: "source-one", fingerprint: migrationInternals.fingerprint(content), manifest: { ...content, fingerprint: migrationInternals.fingerprint(content) } };
    const store = {
      getMigrationSource: vi.fn(() => source),
      createPlan: vi.fn((value) => ({ id: "plan-one", revision: "rev", ...value })),
    };
    const destination = inventoryFixture({ host: { ...sourceInventory.host, hostname: "bigbox", architecture: "arm64" }, docker: { ...sourceInventory.docker, containers: [{ ...sourceInventory.docker.containers[0], name: "app", ports: "127.0.0.1:8080->80/tcp" }] } });
    const service = createMigrationService({ store, inventory: { inspect: vi.fn(async () => destination) } });
    const plan = await service.plan("source-one", "owner-one");
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers.map((item) => item.id)).toEqual(expect.arrayContaining(["architecture", "container-names", "published-ports"]));
  });
});

describe("guarded migration bundle transfers", () => {
  const bundle = {
    bundleId: "11111111-1111-4111-8111-111111111111",
    workloadName: "keel-notes",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-15T20:00:00.000Z",
    composeFile: "compose.yaml",
    contentRevision: "b".repeat(64),
    fileCount: 4,
    sensitiveFileCount: 1,
    totalBytes: 8192,
    destinationState: "empty",
    remainingBytes: 8192,
    verifiedBytes: 0,
    executable: true,
    blockers: [],
  };

  function transferFixture({ sources = [{ id: "source-one", fingerprint: bundle.sourceFingerprint, manifest: { source: { hostname: "oldbox" } } }], bundleValue = bundle, transfers = [] } = {}) {
    let plan;
    const store = {
      listMigrationSources: vi.fn(() => sources),
      listMigrationTransfers: vi.fn(() => transfers),
      createPlan: vi.fn((value) => { plan = { id: "plan-one", revision: "revision-one", status: "draft", ...value }; return plan; }),
      getPlan: vi.fn(() => plan),
      stagePlan: vi.fn(() => { plan.status = "staged"; return plan; }),
      createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
      recordMigrationTransfer: vi.fn((value) => value),
    };
    const helper = { request: vi.fn(async () => ({ ready: true, bundles: [bundleValue], invalidBundles: [], activationSupported: false, sourceMutationSupported: false })) };
    return { store, helper, service: createMigrationService({ store, inventory: { inspect: vi.fn() }, helper }), getPlan: () => plan };
  }

  it("joins a helper-only bundle to its exact imported source without exposing secrets", async () => {
    const { service } = transferFixture();
    const inspection = await service.inspectBundles();
    expect(inspection.bundles[0]).toMatchObject({ sourceId: "source-one", sourceHostname: "oldbox", executable: true, sensitiveFileCount: 1 });
    expect(JSON.stringify(inspection)).not.toContain("PASSWORD");
  });

  it("blocks planning when the source manifest has not been imported", async () => {
    const { service } = transferFixture({ sources: [] });
    const plan = await service.planTransfer(bundle.bundleId, "owner-one");
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers).toContain("Import the exact sanitized source manifest before planning this transfer");
  });

  it("stages, revalidates, and records a verified transfer without activation", async () => {
    const { service, store, getPlan } = transferFixture();
    const plan = await service.planTransfer(bundle.bundleId, "owner-one");
    expect(plan.output).toMatchObject({ executable: true, sourcePreserved: true, activationPerformed: false, sensitiveFileCount: 1 });
    const job = await service.stageTransfer(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "migration.bundle.transfer", risk: "medium" });
    const staged = await service.validateTransferJob(job);
    expect(staged.status).toBe("staged");
    expect(service.helperTransferInput(staged.input)).not.toHaveProperty("sourceId");
    const result = {
      created: true,
      transferId: staged.input.transferId,
      bundleId: staged.input.bundleId,
      workloadName: "keel-notes",
      sourceFingerprint: staged.input.sourceFingerprint,
      contentRevision: staged.input.contentRevision,
      destination: `managed-migration-staging/${staged.input.bundleId}`,
      fileCount: 4,
      sizeBytes: 8192,
      contentVerified: true,
      sourcePreserved: true,
      activationPerformed: false,
      networkCutoverPerformed: false,
      sourceDeletionPerformed: false,
    };
    service.recordTransferResult(job, result);
    expect(store.recordMigrationTransfer).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "source-one", contentVerified: true, sourcePreserved: true, activationPerformed: false }));
    expect(() => service.recordTransferResult(job, { ...result, destination: "../../etc" })).toThrow("evidence validation failed");
    expect(getPlan().input).toEqual(staged.input);
  });

  it("creates a no-copy reconciliation plan when helper completion outlived the durable record", async () => {
    const completedTransferId = "99999999-9999-4999-8999-999999999999";
    const { service } = transferFixture({ bundleValue: { ...bundle, destinationState: "completed", remainingBytes: 0, verifiedBytes: 8192, executable: false, reconcilable: true, completedTransferId } });
    const plan = await service.planTransfer(bundle.bundleId, "owner-one");
    expect(plan.input).toMatchObject({ transferId: completedTransferId, expectedDestinationState: "completed", expectedRemainingBytes: 0 });
    expect(plan.output).toMatchObject({ executable: true, reconciliationOnly: true, activationPerformed: false });
    expect(plan.output.changes[0]).toContain("without copying or activating");
  });
});

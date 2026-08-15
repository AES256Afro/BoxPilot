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

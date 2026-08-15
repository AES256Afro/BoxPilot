import { describe, expect, it, vi } from "vitest";
import { createBackupService } from "./backups.mjs";

function fixture({ installed = true, healthy = true } = {}) {
  const store = {
    listBackups: vi.fn(() => []),
    createPlan: vi.fn((value) => ({ id: "plan-one", revision: "rev-one", status: "draft", ...value })),
    getPlan: vi.fn(() => ({ id: "plan-one", type: "application.backup", subjectId: "uptime-kuma", revision: "rev-one", status: "draft", output: { executable: true, blockers: [] }, createdBy: "owner-one" })),
    stagePlan: vi.fn(),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
    recordBackup: vi.fn((value) => value),
  };
  const helper = { request: vi.fn(async () => ({ installed, healthy, state: installed ? "running" : "not-installed" })) };
  const prerequisites = { inspect: vi.fn(async () => ({ checks: [
    { id: "storage.state", status: "ready" }, { id: "helper.boundary", status: "ready" }, { id: "containers.docker", status: "ready" },
  ] })) };
  return { store, helper, prerequisites, service: createBackupService({ store, helper, prerequisites }) };
}

describe("application-aware backup service", () => {
  it("creates an executable plan only for an installed healthy source", async () => {
    const { service } = fixture();
    const plan = await service.plan("uptime-kuma", "owner-one");
    expect(plan.output).toMatchObject({ executable: true, destination: "local-managed", blockers: [] });
    expect(plan.output.changes.join(" ")).toContain("SHA-256");
  });

  it("blocks backup when the application is absent", async () => {
    const { service } = fixture({ installed: false, healthy: false });
    const plan = await service.plan("uptime-kuma", "owner-one");
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "application.uptime-kuma" })]));
  });

  it("stages an exact revision with a server-generated backup id", async () => {
    const { service, store } = fixture();
    const job = await service.stage("plan-one", "rev-one", "owner-one");
    expect(job.type).toBe("application.uptime-kuma.backup");
    expect(job.parameters.backupId).toMatch(/^[a-f0-9-]{36}$/);
    expect(store.stagePlan).toHaveBeenCalledWith("plan-one", "owner-one");
  });

  it("records only restore-verified evidence tied to the job", () => {
    const { service, store } = fixture();
    const job = { parameters: { backupId: "11111111-1111-4111-8111-111111111111" }, createdBy: "owner-one" };
    const result = { backupId: job.parameters.backupId, applicationId: "uptime-kuma", destination: "local-managed", artifactPath: `/managed/backups/uptime-kuma/${job.parameters.backupId}.tar.gz`, checksumSha256: "a".repeat(64), sizeBytes: 12, downtimeMs: 20, restoreDrill: { passed: true, network: "none", publishedPorts: 0 } };
    service.recordResult(job, result);
    expect(store.recordBackup).toHaveBeenCalledWith(expect.objectContaining({ id: result.backupId, createdBy: "owner-one" }));
    expect(() => service.recordResult(job, { ...result, restoreDrill: { passed: false } })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result, artifactPath: "/tmp/other.tar.gz" })).toThrow("evidence validation");
  });
});

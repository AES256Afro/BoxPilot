import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobService } from "./jobs.mjs";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup(helper) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-jobs-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, {
    username: "operator",
    passwordHash: await hashPassword("correct horse battery"),
  });
  return { store, owner, jobs: createJobService(store, helper) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable job executor", () => {
  it("requires password reauthentication before invoking the helper", async () => {
    const helper = { request: vi.fn() };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createOperationJob("apt.refresh", {}, owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "wrong password")).rejects.toThrow("reauthentication failed");
    expect(helper.request).not.toHaveBeenCalled();
    expect(store.getJob(job.id).state).toBe("awaiting_approval");
    store.close();
  });

  it("approves low-risk jobs with one click, records the method, and keeps a wrong password rejected", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const session = store.getSession(store.createSession(owner.id).token);
    expect(jobs.describeApproval(jobs.createOperationJob("apt.refresh", {}, owner.id).id, session)).toMatchObject({ tier: "low", passwordRequired: false, mode: "tiered" });
    const job = jobs.createOperationJob("apt.refresh", {}, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, { password: "wrong password", session })).rejects.toThrow("reauthentication failed");
    const completed = await jobs.approveAndRun(job.id, owner.id, { session });
    expect(completed.state).toBe("completed");
    expect(completed.approvals[0]).toMatchObject({ ownerId: owner.id, method: "confirm", tier: "low" });
    expect(completed.steps.find((step) => step.name === "approval").detail).toContain("low risk, confirm");
    expect(store.getSession(session.tokenHash) ?? session).toBeTruthy();
    store.close();
  });

  it("requires the password for high-risk jobs unless the session was elevated by a recent password", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const token = store.createSession(owner.id).token;
    const session = store.getSession(token);
    const job = store.createJob({ type: "application.pi-hole.deploy", title: "high", parameters: {}, recovery: {}, createdBy: owner.id });
    expect(jobs.describeApproval(job.id, session)).toMatchObject({ tier: "high", passwordRequired: true, elevated: false });
    await expect(jobs.approveAndRun(job.id, owner.id, { session })).rejects.toThrow("reauthentication required: high-risk");
    expect(store.getJob(job.id).state).toBe("awaiting_approval");
    // A password on a low-risk job elevates the session...
    const canary = jobs.createOperationJob("apt.refresh", {}, owner.id);
    await jobs.approveAndRun(canary.id, owner.id, { password: "correct horse battery", session });
    const elevated = store.getSession(token);
    expect(Date.parse(elevated.elevatedUntil)).toBeGreaterThan(Date.now());
    // ...so the high-risk job no longer needs it.
    expect(jobs.describeApproval(job.id, elevated)).toMatchObject({ tier: "high", passwordRequired: false, elevated: true });
    store.close();
  });

  it("honours always-password mode for every tier", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
    const session = store.getSession(store.createSession(owner.id).token);
    const job = jobs.createOperationJob("apt.refresh", {}, owner.id);
    expect(jobs.describeApproval(job.id, session)).toMatchObject({ mode: "always-password", passwordRequired: true });
    await expect(jobs.approveAndRun(job.id, owner.id, { session })).rejects.toThrow("reauthentication required");
    const completed = await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery", session });
    expect(completed.approvals[0]).toMatchObject({ method: "password", tier: "low" });
    expect(store.getSetting("approvalMode")).toBe("always-password");
    store.close();
  });

  it("stages and runs registered operations generically with the tier taken from the registry", async () => {
    const helper = { request: vi.fn(async (operation, parameters) => ({ operation, parameters, upgraded: true })) };
    const { store, owner, jobs } = await setup(helper);
    const session = store.getSession(store.createSession(owner.id).token);
    expect(() => jobs.createOperationJob("apt.upgradable.inspect", {}, owner.id)).toThrow("Read-only");
    expect(() => jobs.createOperationJob("nope.op", {}, owner.id)).toThrow("Operation not found");
    expect(() => jobs.createOperationJob("apt.install", { packages: ["bad name"] }, owner.id)).toThrow("invalid package name");
    const job = jobs.createOperationJob("apt.upgrade", { packages: ["htop"] }, owner.id);
    expect(job).toMatchObject({ type: "op:apt.upgrade", title: "Install package updates", risk: "medium", state: "awaiting_approval" });
    expect(jobs.describeApproval(job.id, session)).toMatchObject({ tier: "medium", passwordRequired: false });
    const completed = await jobs.approveAndRun(job.id, owner.id, { session });
    expect(helper.request).toHaveBeenCalledWith("apt.upgrade", { packages: ["htop"] }, expect.objectContaining({ timeoutMs: 70 * 60 * 1000 }));
    expect(completed.state).toBe("completed");
    expect(completed.result).toMatchObject({ upgraded: true });
    const purge = jobs.createOperationJob("apt.purge", { packages: ["htop"] }, owner.id);
    expect(jobs.describeApproval(purge.id, session)).toMatchObject({ tier: "high", passwordRequired: true });
    await expect(jobs.approveAndRun(purge.id, owner.id, { session })).rejects.toThrow("high-risk");
    store.close();
  });

  it("records the complete approved low-risk operation lifecycle", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createOperationJob("apt.refresh", {}, owner.id);
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(helper.request).toHaveBeenCalledWith("apt.refresh", {}, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed.state).toBe("completed");
    expect(completed.steps.map((step) => step.name)).toEqual(["preflight", "checkpoint", "approval", "apply", "apply", "verify"]);
    expect(store.listAudit().map((event) => event.type)).toContain("job.completed");
    store.close();
  });

  it("fails closed when the helper is unavailable", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("Helper unavailable"); }) };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createOperationJob("apt.refresh", {}, owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("Helper unavailable");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: "Helper unavailable" });
    store.close();
  });

  it("revalidates and executes only the approved fixed libvirt foundation plan", async () => {
    const foundationId = "123e4567-e89b-42d3-a456-426614174000";
    const expectedRevision = "a".repeat(64);
    const result = {
      initialized: true, foundationId, revisionBefore: expectedRevision, revisionAfter: "b".repeat(64), ready: true,
      network: { name: "default", created: true, started: true, autostartEnabled: true },
      pool: { name: "default", targetPath: "/var/lib/libvirt/images", created: true, started: true, autostartEnabled: true },
      rollback: { automatic: true, requestedOnFailure: true, limitedToJobChanges: true },
      boundary: { resourceNamesFixed: true, otherNetworksChanged: false, otherPoolsChanged: false, virtualMachineCreated: false, diskCreated: false, bridgeModeEnabled: false, browserResourceAccepted: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateLibvirtFoundationJob = vi.fn(async () => ({ plan: { input: { foundationId, expectedRevision } }, state: { revision: expectedRevision } }));
    const jobs = createJobService(store, helper, { validateLibvirtFoundationJob });
    const job = store.createJob({ type: "virtualization.foundation.initialize", title: "Initialize libvirt foundation", risk: "virtualization-network-storage", parameters: { foundationId, expectedRevision }, recovery: { automaticRollback: true }, createdBy: owner.id });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validateLibvirtFoundationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.foundation.initialize", { foundationId, expectedRevision }, expect.objectContaining({ timeoutMs: 5 * 60 * 1000 }));
    expect(completed).toMatchObject({ state: "completed", result: { initialized: true, ready: true, network: { name: "default" }, pool: { name: "default" } } });
    store.close();
  });

  it("revalidates and executes a typed Uptime Kuma deployment job", async () => {
    const helper = { request: vi.fn(async () => ({ installed: true, healthy: true, dataPreserved: true, hostPort: 3101 })) };
    const { store, owner } = await setup(helper);
    const validateApplicationJob = vi.fn(async () => {});
    const jobs = createJobService(store, helper, { validateApplicationJob });
    const job = store.createJob({
      type: "application.uptime-kuma.deploy",
      title: "Deploy Uptime Kuma",
      parameters: { hostPort: 3101 },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validateApplicationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.deploy", { hostPort: 3101 }, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed).toMatchObject({ state: "completed", result: { healthy: true, hostPort: 3101 } });
    store.close();
  });

  it("revalidates and executes an exact Uptime Kuma lifecycle plan", async () => {
    const input = { applicationId: "uptime-kuma", action: "restart", expectedRevision: "a".repeat(64) };
    const result = {
      applicationId: "uptime-kuma", action: "restart", expectedRevision: input.expectedRevision,
      performed: true, state: "running", running: true, healthy: true, port: 3101, dataPreserved: true,
      boundary: { exactContainerOnly: true, imageChanged: false, composeChanged: false, dataDeleted: false, networkDeleted: false, arbitraryContainerAccepted: false, arbitraryCommandAccepted: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationLifecycleJob = vi.fn(async () => ({ input, output: { label: "Restart", desired: { state: "running", port: 3101 } } }));
    const jobs = createJobService(store, helper, { validateApplicationLifecycleJob });
    const job = store.createJob({
      type: "application.uptime-kuma.action",
      title: "Restart Uptime Kuma",
      parameters: { planId: "plan-one", revision: "revision-one", input },
      recovery: { automaticRollback: false },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationLifecycleJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.action", input, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed).toMatchObject({ state: "completed", result: { action: "restart", state: "running", dataPreserved: true } });
    store.close();
  });

  it("revalidates and publishes only the exact private Uptime Kuma tailnet route", async () => {
    const input = { applicationId: "uptime-kuma", action: "publish", expectedRevision: "c".repeat(64) };
    const result = {
      applicationId: "uptime-kuma", action: "publish", expectedRevision: input.expectedRevision,
      performed: true, published: true, tailnetOnly: true, url: "https://bigbox.example.ts.net:3101/", dnsName: "bigbox.example.ts.net", port: 3101,
      boundary: { exactApplicationRouteOnly: true, otherServeConfigurationChanged: false, funnelEnabled: false, publicExposure: false, firewallChanged: false, routerChanged: false, dnsChanged: false, containerChanged: false, arbitraryTargetAccepted: false, arbitraryPortAccepted: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationPrivateAccessJob = vi.fn(async () => ({ input, output: { desired: { published: true, tailnetOnly: true, url: result.url, port: 3101 } } }));
    const jobs = createJobService(store, helper, { validateApplicationPrivateAccessJob });
    const job = store.createJob({
      type: "application.uptime-kuma.private-access",
      title: "Publish private Uptime Kuma access",
      parameters: { planId: "plan-private", revision: "revision-private", input },
      recovery: { automaticRollback: false },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationPrivateAccessJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.private-access.configure", input, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed).toMatchObject({ state: "completed", result: { published: true, tailnetOnly: true, url: result.url, boundary: { publicExposure: false, otherServeConfigurationChanged: false } } });
    store.close();
  });

  it("revalidates and executes an exact Pi-hole lifecycle plan without router or client DNS authority", async () => {
    const input = { applicationId: "pi-hole", action: "restart", expectedRevision: "b".repeat(64) };
    const result = {
      applicationId: "pi-hole", action: "restart", expectedRevision: input.expectedRevision,
      performed: true, state: "running", running: true, healthy: true, lanAddress: "192.168.8.10", port: 8080,
      dnsTcpBound: true, dnsUdpBound: true, dataPreserved: true, secretPreserved: true,
      dhcpEnabled: false, routerMutationPerformed: false, dnsCutoverPerformed: false,
      boundary: {
        exactContainerOnly: true, imageChanged: false, composeChanged: false, dataDeleted: false, secretDeleted: false,
        networkDeleted: false, routerChanged: false, clientDnsChanged: false, tailscaleChanged: false,
        arbitraryContainerAccepted: false, arbitraryCommandAccepted: false,
      },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationLifecycleJob = vi.fn(async () => ({ input, output: { label: "Restart", desired: { state: "running", lanAddress: "192.168.8.10", port: 8080 } } }));
    const jobs = createJobService(store, helper, { validateApplicationLifecycleJob });
    const job = store.createJob({
      type: "application.pi-hole.action",
      title: "Restart Pi-hole",
      parameters: { planId: "plan-two", revision: "revision-two", input },
      recovery: { automaticRollback: false },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationLifecycleJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.action", input, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed).toMatchObject({ state: "completed", result: { action: "restart", state: "running", dataPreserved: true, secretPreserved: true, routerMutationPerformed: false, dnsCutoverPerformed: false } });
    store.close();
  });

  it("revalidates and stages Pi-hole without granting router, DHCP, or DNS cutover authority", async () => {
    const input = { target: "docker", hostPort: 8080, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one", fallbackDnsAddress: "94.140.14.59" };
    const result = {
      installed: true, healthy: true, lanAddress: input.lanAddress, port: input.hostPort,
      dnsTcpBound: true, dnsUdpBound: true, dataPreserved: true, secretPreserved: true,
      routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpEnabled: false,
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateApplicationJob });
    const job = store.createJob({
      type: "application.pi-hole.deploy",
      title: "Stage Pi-hole on this server",
      parameters: { hostPort: 8080, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one" },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.deploy", { lanAddress: "192.168.8.10", webPort: 8080 }, expect.objectContaining({ timeoutMs: 10 * 60 * 1000 }));
    expect(completed).toMatchObject({ state: "completed", result: { healthy: true, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpEnabled: false } });
    store.close();
  });

  it("revalidates and acquires only the immutable fixed Keel artifact without installing it", async () => {
    const acquisitionId = "11111111-1111-4111-8111-111111111111";
    const result = {
      acquired: true, acquisitionId, releaseTag: keelArtifactSpec.releaseTag, releaseCommitSha: keelArtifactSpec.releaseCommitSha, name: keelArtifactSpec.name, sizeBytes: keelArtifactSpec.sizeBytes,
      sha256: keelArtifactSpec.digest, locallyVerified: true, evidenceRecorded: true,
      boundary: { networkAccess: true, extractionPerformed: false, archiveExecuted: false, applicationInstalled: false, serviceChanged: false, registrationChanged: false, arbitraryUrlAccepted: false, arbitraryPathAccepted: false, browserDigestAccepted: false, artifactBytesReturned: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateKeelArtifactJob = vi.fn(async () => ({ input: { acquisitionId } }));
    const jobs = createJobService(store, helper, { validateKeelArtifactJob });
    const job = store.createJob({ type: "application.keel.artifact.acquire", title: "Acquire Keel artifact", risk: "networked-artifact", parameters: { acquisitionId }, recovery: { automaticRollback: true }, createdBy: owner.id });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validateKeelArtifactJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.keel.artifact.acquire", { acquisitionId }, expect.objectContaining({ timeoutMs: 15 * 60 * 1000 }));
    expect(completed).toMatchObject({ state: "completed", result: { locallyVerified: true, boundary: { extractionPerformed: false, applicationInstalled: false } } });
    store.close();
  });

  it("revalidates and stages only inert Keel 1.2.6 release bytes", async () => {
    const stageId = "22222222-2222-4222-8222-222222222222";
    const result = {
      staged: true,
      stageId,
      version: "1.2.6",
      releaseTag: keelArtifactSpec.releaseTag,
      releaseCommitSha: keelArtifactSpec.releaseCommitSha,
      artifactDigest: keelArtifactSpec.digest,
      sourceMemberCount: keelArtifactSpec.archiveMembersObservedDuringAdapterReview,
      regularFiles: keelArtifactSpec.archiveRegularFilesObservedDuringAdapterReview,
      directories: keelArtifactSpec.archiveDirectoriesObservedDuringAdapterReview,
      managedMetadataFiles: 1,
      boundary: { networkAccess: false, extractionPerformed: true, archiveExecuted: false, applicationInstalled: false, applicationStateCreated: false, serviceChanged: false, registrationChanged: false, listenerChanged: false, arbitraryPathAccepted: false, browserArchiveAccepted: false, memberNamesReturned: false, memberContentsReturned: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationJob = vi.fn(async () => ({ input: { stageId } }));
    const jobs = createJobService(store, helper, { validateApplicationJob });
    const job = store.createJob({ type: "application.keel.stage", title: "Stage Keel 1.2.6 release tree", risk: "stateful-staging", parameters: { stageId }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.keel.stage", { stageId }, expect.objectContaining({ timeoutMs: 15 * 60 * 1000 }));
    expect(completed).toMatchObject({ state: "completed", result: { staged: true, version: "1.2.6", boundary: { applicationInstalled: false, serviceChanged: false, listenerChanged: false } } });
    store.close();
  });

  it("installs only the approved fixed Keel service and preserves claim separation", async () => {
    const installId = "33333333-3333-4333-8333-333333333333";
    const result = {
      installId,
      installed: true,
      healthy: true,
      releaseVersion: "1.2.6",
      serviceActive: true,
      serviceEnabled: true,
      listener: "127.0.0.1:3000",
      statePreserved: true,
      claimRequired: true,
      privateAccessConfigured: false,
      boundary: {
        releaseExecuted: true, serviceChanged: true, accountChanged: true, applicationStateCreated: true, listenerChanged: true,
        registrationChanged: false, claimChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false,
        databaseOpened: false, secretRead: false, arbitraryPathAccepted: false, arbitraryCommandAccepted: false, browserEnvironmentAccepted: false,
      },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationJob = vi.fn(async () => ({ input: { installId } }));
    const jobs = createJobService(store, helper, { validateApplicationJob });
    const job = store.createJob({ type: "application.keel.install", title: "Install private Keel 1.2.6 service", risk: "stateful-install", parameters: { installId }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.keel.install", { installId }, expect.objectContaining({ timeoutMs: 15 * 60 * 1000 }));
    expect(completed).toMatchObject({ state: "completed", result: { installed: true, healthy: true, listener: "127.0.0.1:3000", claimRequired: true, privateAccessConfigured: false } });
    store.close();
  });

  it("records a backup only after the isolated restore evidence passes", async () => {
    const backupId = "11111111-1111-4111-8111-111111111111";
    const result = { backupId, applicationId: "uptime-kuma", sourceRestartVerified: true, restoreDrill: { passed: true } };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({
      type: "application.uptime-kuma.backup",
      title: "Back up Uptime Kuma",
      parameters: { backupId },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.backup", { backupId }, expect.objectContaining({ jobId: expect.any(String) }));
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(completed.state).toBe("completed");
    store.close();
  });

  it("runs the controller snapshot through the typed helper and records only no-change restore evidence", async () => {
    const backupId = "33333333-3333-4333-8333-333333333333";
    const result = {
      backupId,
      applicationId: "boxpilot-controller",
      consistentSnapshot: true,
      snapshotMethod: "sqlite-vacuum-into",
      sourceServiceStopped: false,
      downtimeMs: 0,
      restoreDrill: { passed: true, mode: "isolated-copy-open", copyChecksumMatched: true, integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, ownerStatePresent: true, workspaceRemoved: true, productionDatabaseReplaced: false, serviceStarted: false },
      boundary: { databaseContentReturned: false, browserPathAccepted: false, browserCommandAccepted: false, productionDatabaseChanged: false, serviceStopped: false, networkAccessRequired: false, independentCopyCreated: false, retentionPerformed: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({ type: "controller.database.backup", title: "Back up BoxPilot controller", parameters: { backupId, applicationId: "boxpilot-controller" }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("controller.database.backup.create", { backupId }, expect.objectContaining({ timeoutMs: 10 * 60 * 1000 }));
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(completed).toMatchObject({ state: "completed", result: { consistentSnapshot: true, sourceServiceStopped: false, downtimeMs: 0 } });
    store.close();
  });

  it("runs independent controller protection in the background and records only exact restored restic evidence", async () => {
    const input = { protectionId: "44444444-4444-4444-8444-444444444444", backupId: "33333333-3333-4333-8333-333333333333", expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "c".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateControllerProtectionJob = vi.fn(async () => ({ input }));
    const recordControllerProtectionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateControllerProtectionJob, recordControllerProtectionResult });
    const job = store.createJob({ type: "controller.database.backup.protect", title: "Protect BoxPilot controller", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(validateControllerProtectionJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("controller.database.protection.create", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = { created: true, protectionId: input.protectionId, backupId: input.backupId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", productionDatabaseReplaced: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordControllerProtectionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs exact controller retention and records forgotten evidence before completion validation", async () => {
    const input = { retentionId: "55555555-5555-4555-8555-555555555555", repositoryId: "a".repeat(64), expectedDestinationRevision: "b".repeat(64), expectedSnapshotSetRevision: "c".repeat(64), forgetSnapshotIds: ["d".repeat(64)] };
    const result = { applied: true, complete: true, retentionId: input.retentionId, repositoryId: input.repositoryId, forgottenSnapshotIds: input.forgetSnapshotIds, keptSnapshotIds: ["e".repeat(64)], beforeCount: 2, afterCount: 1, beforeSnapshotSetRevision: input.expectedSnapshotSetRevision, afterSnapshotSetRevision: "f".repeat(64), repositoryVerified: true, prunePerformed: false, spaceReclaimed: false };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateControllerRetentionJob = vi.fn(async () => ({ input }));
    const recordControllerRetentionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateControllerRetentionJob, recordControllerRetentionResult });
    const job = store.createJob({ type: "controller.database.backup.retention.apply", title: "Retain controller backups", risk: "high", parameters: { input }, recovery: {}, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateControllerRetentionJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("controller.database.protection.retention.apply", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    expect(recordControllerRetentionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(completed).toMatchObject({ state: "completed", result: { prunePerformed: false, spaceReclaimed: false } });
    store.close();
  });

  it("runs independent application protection in the background and records exact restored archive evidence", async () => {
    const input = { protectionId: "44444444-4444-4444-8444-444444444444", backupId: "33333333-3333-4333-8333-333333333333", applicationId: "pi-hole", expectedArtifactChecksumSha256: "a".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "c".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateApplicationProtectionJob = vi.fn(async () => ({ input }));
    const recordApplicationProtectionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateApplicationProtectionJob, recordApplicationProtectionResult });
    const job = store.createJob({ type: "application.backup.protect", title: "Protect Pi-hole", parameters: { input }, recovery: {}, createdBy: owner.id });
    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("application.backup.protection.create", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = { created: true, protectionId: input.protectionId, backupId: input.backupId, applicationId: input.applicationId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-artifact-restore", network: "none", artifactChecksumMatched: true, applicationStarted: false, productionStateReplaced: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordApplicationProtectionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs a Pi-hole backup as a typed long-running job and records only isolated no-cutover evidence", async () => {
    const backupId = "22222222-2222-4222-8222-222222222222";
    const result = {
      backupId,
      applicationId: "pi-hole",
      sourceRestartVerified: true,
      routerMutationPerformed: false,
      dnsCutoverPerformed: false,
      restoreDrill: {
        passed: true,
        network: "none",
        publishedPorts: 0,
        configurationIncluded: true,
        administratorSecretIncluded: true,
        routerMutationPerformed: false,
        dnsCutoverPerformed: false,
      },
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({
      type: "application.pi-hole.backup",
      title: "Back up and restore-test Pi-hole",
      risk: "network-critical",
      parameters: { backupId, applicationId: "pi-hole" },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");

    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.backup", { backupId }, expect.objectContaining({ timeoutMs: 10 * 60 * 1000 }));
    expect(started.state).toBe("applying");
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(store.getJob(job.id)).toMatchObject({ state: "completed", result: { applicationId: "pi-hole", routerMutationPerformed: false, dnsCutoverPerformed: false } });
    store.close();
  });

  it("runs a Keel backup as a typed long-running job and records only restarted isolated export evidence", async () => {
    const backupId = "22222222-2222-4222-8222-222222222222";
    const result = {
      backupId,
      applicationId: "keel",
      releaseVersion: "1.2.6",
      sourceRestartVerified: true,
      restoreDrill: { passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, environmentIncluded: true, treeDigestMatched: true, applicationStarted: false, productionStateReplaced: false },
      boundary: { sourceServiceStopped: true, sourceRestarted: true, secretContentReturned: false, environmentContentReturned: false, registrationChanged: false, claimChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false },
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({ type: "application.keel.backup", title: "Back up and restore-test Keel Notes", risk: "medium", parameters: { backupId, applicationId: "keel" }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.keel.backup", { backupId }, expect.objectContaining({ timeoutMs: 20 * 60 * 1000 }));
    expect(started.state).toBe("applying");
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs only the exact drilled Keel production promotion and records rollback evidence", async () => {
    const input = {
      promotionId: "11111111-1111-4111-8111-111111111111", recoveryId: "22222222-2222-4222-8222-222222222222",
      drillId: "33333333-3333-4333-8333-333333333333", expectedInstallId: "44444444-4444-4444-8444-444444444444",
      expectedEvidenceChecksumSha256: "a".repeat(64), expectedStateTreeDigestSha256: "b".repeat(64),
    };
    const result = {
      schemaVersion: 1, passed: true, ...input, previousInstallId: input.expectedInstallId,
      sourceEvidenceChecksumSha256: input.expectedEvidenceChecksumSha256, sourceStateTreeDigestSha256: input.expectedStateTreeDigestSha256,
      previousStateTreeDigestSha256: "c".repeat(64), promotedStateTreeDigestSha256: input.expectedStateTreeDigestSha256,
      rollbackAvailable: true, healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true,
      productionStateReplaced: true, sourceRecoveryUnchanged: true, ownerLoginTested: false, publishedPortsChanged: false,
      tailscaleChanged: false, firewallChanged: false, routerChanged: false,
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateKeelPromotionJob = vi.fn(async () => ({ input }));
    const recordKeelPromotionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateKeelPromotionJob, recordKeelPromotionResult });
    const job = store.createJob({ type: "application.keel.promotion", title: "Promote Keel recovery", risk: "critical", parameters: { input }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(validateKeelPromotionJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.keel.promotion.create", input, expect.objectContaining({ timeoutMs: 20 * 60 * 1000 }));
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordKeelPromotionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs only the exact Keel operator rollback and records both preserved state boundaries", async () => {
    const input = {
      rollbackId: "55555555-5555-4555-8555-555555555555", promotionId: "33333333-3333-4333-8333-333333333333",
      expectedInstallId: "44444444-4444-4444-8444-444444444444", expectedRollbackEvidenceChecksumSha256: "a".repeat(64),
      expectedPreviousStateTreeDigestSha256: "b".repeat(64),
    };
    const result = {
      schemaVersion: 1, passed: true, rollbackId: input.rollbackId, promotionId: input.promotionId, installId: input.expectedInstallId,
      sourceRollbackEvidenceChecksumSha256: input.expectedRollbackEvidenceChecksumSha256,
      sourcePreviousStateTreeDigestSha256: input.expectedPreviousStateTreeDigestSha256,
      restoredStateTreeDigestSha256: input.expectedPreviousStateTreeDigestSha256, displacedStateRetained: true,
      sourceRollbackCheckpointUnchanged: true, rollbackRequested: true, productionStateReplaced: true, healthIdentityVerified: true,
      databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, automaticFailureRecoveryTested: false, ownerLoginTested: false,
      publishedPortsChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false,
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateKeelRollbackJob = vi.fn(async () => ({ input }));
    const recordKeelRollbackResult = vi.fn();
    const jobs = createJobService(store, helper, { validateKeelRollbackJob, recordKeelRollbackResult });
    const job = store.createJob({ type: "application.keel.rollback", title: "Roll back Keel promotion", risk: "critical", parameters: { input }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(validateKeelRollbackJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.keel.rollback.create", input, expect.objectContaining({ timeoutMs: 20 * 60 * 1000 }));
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordKeelRollbackResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs a migration bundle transfer in the background without sending source records or paths to the helper", async () => {
    const input = {
      transferId: "11111111-1111-4111-8111-111111111111",
      bundleId: "22222222-2222-4222-8222-222222222222",
      sourceId: "source-one",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      contentRevision: "b".repeat(64),
      expectedDestinationState: "empty",
      expectedRemainingBytes: 8192,
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateMigrationTransferJob = vi.fn(async () => ({ input }));
    const recordMigrationTransferResult = vi.fn();
    const jobs = createJobService(store, helper, { validateMigrationTransferJob, recordMigrationTransferResult });
    const job = store.createJob({ type: "migration.bundle.transfer", title: "Stage migration bundle", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("migration.bundle.transfer", {
      transferId: input.transferId,
      bundleId: input.bundleId,
      sourceFingerprint: input.sourceFingerprint,
      contentRevision: input.contentRevision,
      expectedDestinationState: "empty",
      expectedRemainingBytes: 8192,
    }, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = {
      created: true,
      transferId: input.transferId,
      bundleId: input.bundleId,
      contentVerified: true,
      sourcePreserved: true,
      activationPerformed: false,
      networkCutoverPerformed: false,
      sourceDeletionPerformed: false,
    };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordMigrationTransferResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("revalidates and executes only the staged typed VM input", async () => {
    const input = { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false };
    const helper = { request: vi.fn(async () => ({ created: true, verified: true, domain: input.name, media: input.isoFile })) };
    const { store, owner } = await setup(helper);
    const validateVmCreationJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateVmCreationJob });
    const job = store.createJob({
      type: "virtualization.domain.create",
      title: "Create ubuntu-lab",
      parameters: { input },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateVmCreationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.create", input, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed).toMatchObject({ state: "completed", result: { verified: true, domain: "ubuntu-lab" } });
    store.close();
  });

  it("revalidates and executes only the staged VM media evidence", async () => {
    const input = { importId: "77777777-7777-4777-8777-777777777777", filename: "ubuntu.iso", expectedSizeBytes: 8192, expectedSha256: "a".repeat(64), expectedRevision: "b".repeat(64) };
    const result = { imported: true, verified: true, importId: input.importId, filename: input.filename, sizeBytes: input.expectedSizeBytes, sha256: input.expectedSha256, boundary: { existingMediaOverwritten: false, arbitraryPathAccepted: false, virtualMachineCreated: false, libvirtChanged: false } };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateVmMediaImportJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateVmMediaImportJob });
    const job = store.createJob({ type: "virtualization.media.import", title: "Import ubuntu.iso", parameters: { input }, recovery: { automaticRollback: true }, createdBy: owner.id });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validateVmMediaImportJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.media.import", input, expect.objectContaining({ timeoutMs: 6 * 60 * 60 * 1000 }));
    expect(completed).toMatchObject({ state: "completed", result: { imported: true, verified: true, filename: "ubuntu.iso" } });
    store.close();
  });

  it("revalidates and executes only a stopped-domain snapshot plan", async () => {
    const input = { name: "ubuntu-lab", snapshotName: "pre-upgrade", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) };
    const helper = { request: vi.fn(async () => ({ created: true, verified: true, domain: input.name, snapshotName: input.snapshotName, consistency: "offline-consistent", independentBackup: false })) };
    const { store, owner } = await setup(helper);
    const validateVmSnapshotJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateVmSnapshotJob });
    const job = store.createJob({ type: "virtualization.domain.snapshot.create", title: "Snapshot ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateVmSnapshotJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.snapshot.create", input, expect.objectContaining({ jobId: expect.any(String) }));
    expect(completed).toMatchObject({ state: "completed", result: { consistency: "offline-consistent", independentBackup: false } });
    store.close();
  });

  it("starts a long stopped-VM export in the background and records only verified local evidence", async () => {
    const input = { name: "ubuntu-lab", exportId: "11111111-1111-4111-8111-111111111111", expectedUuid: "22222222-2222-4222-8222-222222222222", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmExportJob = vi.fn(async () => ({ input }));
    const recordVmExportResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmExportJob, recordVmExportResult });
    const job = store.createJob({ type: "virtualization.domain.export.create", title: "Export ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.export.create", input, expect.objectContaining({ timeoutMs: 6 * 60 * 60 * 1000 }));
    const result = { created: true, contentVerified: true, domain: input.name, uuid: input.expectedUuid, exportId: input.exportId, protected: false, encrypted: false, restoreDrill: { passed: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmExportResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("records confined cleanup when a VM export fails", async () => {
    const input = { name: "ubuntu-lab", exportId: "11111111-1111-4111-8111-111111111111", expectedUuid: "22222222-2222-4222-8222-222222222222", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) };
    const helper = { request: vi.fn(async () => { throw new Error("conversion failed Automated export cleanup completed."); }) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, { validateVmExportJob: async () => ({ input }) });
    const job = store.createJob({ type: "virtualization.domain.export.create", title: "Export ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("cleanup completed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "rollback", state: "completed" })]) });
    store.close();
  });

  it("starts encrypted independent VM protection in the background without claiming restore protection", async () => {
    const input = { backupId: "11111111-1111-4111-8111-111111111111", exportId: "22222222-2222-4222-8222-222222222222", domainName: "ubuntu-lab", domainUuid: "33333333-3333-4333-8333-333333333333", expectedManifestChecksumSha256: "a".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "b".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmProtectionJob = vi.fn(async () => ({ input }));
    const recordVmProtectionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmProtectionJob, recordVmProtectionResult });
    const job = store.createJob({ type: "virtualization.export.backup.create", title: "Protect ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.create", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = { created: true, backupId: input.backupId, exportId: input.exportId, encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmProtectionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs exact VM retention in the background and records verified no-prune evidence", async () => {
    const input = {
      retentionId: "11111111-1111-4111-8111-111111111111",
      repositoryId: "a".repeat(64),
      expectedDestinationRevision: "b".repeat(64),
      expectedSnapshotSetRevision: "c".repeat(64),
      forgetSnapshotIds: ["d".repeat(64)],
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmRetentionJob = vi.fn(async () => ({ input }));
    const recordVmRetentionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRetentionJob, recordVmRetentionResult });
    const job = store.createJob({ type: "virtualization.export.backup.retention.apply", title: "Apply retention", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.retention.apply", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = { applied: true, complete: true, retentionId: input.retentionId, repositoryId: input.repositoryId, repositoryVerified: true, prunePerformed: false, spaceReclaimed: false };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmRetentionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("records confirmed retention mutation before failing a later repository verification", async () => {
    const input = {
      retentionId: "11111111-1111-4111-8111-111111111111", repositoryId: "a".repeat(64), expectedDestinationRevision: "b".repeat(64),
      expectedSnapshotSetRevision: "c".repeat(64), forgetSnapshotIds: ["d".repeat(64)],
    };
    const result = { applied: true, complete: true, retentionId: input.retentionId, repositoryId: input.repositoryId, forgottenSnapshotIds: input.forgetSnapshotIds, repositoryVerified: false, prunePerformed: false, spaceReclaimed: false };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const recordVmRetentionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRetentionJob: async () => ({ input }), recordVmRetentionResult });
    const job = store.createJob({ type: "virtualization.export.backup.retention.apply", title: "Apply retention", parameters: { input }, recovery: {}, createdBy: owner.id });

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("invalid operation result");
    expect(recordVmRetentionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(store.getJob(job.id).state).toBe("failed");
    store.close();
  });

  it("starts an isolated restore drill in the background and records only passing cleanup evidence", async () => {
    const input = {
      drillId: "11111111-1111-4111-8111-111111111111", backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333",
      domainName: "ubuntu-lab", domainUuid: "44444444-4444-4444-8444-444444444444", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64),
      expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64),
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmRestoreDrillJob = vi.fn(async () => ({ input }));
    const recordVmRestoreDrillResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRestoreDrillJob, recordVmRestoreDrillResult });
    const job = store.createJob({ type: "virtualization.export.backup.restore-drill", title: "Drill ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.restore-drill", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = { passed: true, drillId: input.drillId, backupId: input.backupId, network: "none", transient: true, persistentDomainCreated: false, guestAgentPing: true, temporaryQemuDiskAccessGranted: true, temporaryQemuDiskAccessRemoved: true, transientFirmwareStateRemoved: true, cleanupVerified: true, protected: true };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmRestoreDrillResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("creates a guarded recovery clone in the background and records only stopped no-network evidence", async () => {
    const input = {
      restoreId: "11111111-1111-4111-8111-111111111111", backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333",
      sourceDomainName: "ubuntu-lab", sourceDomainUuid: "44444444-4444-4444-8444-444444444444", targetDomainName: "ubuntu-lab-recovery",
      restoreDrillId: "55555555-5555-4555-8555-555555555555", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64),
      expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64),
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmRecoveryJob = vi.fn(async () => ({ input }));
    const recordVmRecoveryResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRecoveryJob, recordVmRecoveryResult });
    const job = store.createJob({ type: "virtualization.backup.recovery.create", title: "Recover ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.backup.recovery.create", input, expect.objectContaining({ timeoutMs: 12 * 60 * 60 * 1000 }));
    const result = {
      created: true, restoreId: input.restoreId, backupId: input.backupId, domain: input.targetDomainName,
      persistent: true, state: "stopped", network: "none", autostart: false, sourceUnchanged: true, snapshotUnchanged: true,
    };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmRecoveryResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("records exact recovery-clone rollback without touching protected source evidence", async () => {
    const input = { restoreId: "11111111-1111-4111-8111-111111111111", backupId: "22222222-2222-4222-8222-222222222222", targetDomainName: "ubuntu-lab-recovery" };
    const helper = { request: vi.fn(async () => { throw new Error("definition verification failed Automatic recovery-clone rollback removed the new domain definition and generated disk directory."); }) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, { validateVmRecoveryJob: async () => ({ input }) });
    const job = store.createJob({ type: "virtualization.backup.recovery.create", title: "Recover ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("rollback removed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "rollback", state: "completed" })]) });
    store.close();
  });
});

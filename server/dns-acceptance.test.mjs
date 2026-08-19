import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDnsAcceptanceService, dnsAcceptanceInternals } from "./dns-acceptance.mjs";
import { createJobService } from "./jobs.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

function passingChecks() {
  return dnsAcceptanceInternals.acceptanceChecks.map((check) => ({
    id: check.id,
    protocol: check.protocol,
    name: check.name,
    type: "A",
    expectedRcode: check.expectedRcode,
    rcode: check.expectedRcode,
    answers: check.requireAnswers ? 1 : 0,
    recursionAvailable: true,
    truncated: false,
    latencyMs: 4,
    passed: true,
  }));
}

async function fixture({ sourceInstalled = true, withBackup = true, probeResolver = vi.fn(async () => passingChecks()) } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-dns-acceptance-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: await hashPassword("correct horse battery") });
  const assessment = store.createPlan({
    type: "network.dns.assessment",
    subjectId: "flint2-edge-tplink-ap",
    input: {
      topology: "flint2-edge-tplink-ap", dnsRole: "pihole-on-host", gatewayAddress: "192.168.8.1",
      serverAddress: "192.168.8.10", dnsServiceAddress: "192.168.8.10", fallbackDnsAddress: "94.140.14.59",
      routerBackupRecorded: true, emergencyResolverTested: true, secondDeviceReady: true, tailscaleDnsOverride: false,
    },
    output: { readyForChangeWindow: true, blockers: [] },
    createdBy: owner.id,
  });
  const deployment = store.createJob({
    type: "application.pi-hole.deploy",
    title: "Stage Pi-hole",
    parameters: { networkAssessmentId: assessment.id, lanAddress: "192.168.8.10", hostPort: 8080 },
    createdBy: owner.id,
  });
  store.transitionJob(deployment.id, "awaiting_approval", "applying");
  store.transitionJob(deployment.id, "applying", "verifying");
  store.transitionJob(deployment.id, "verifying", "completed", { result: {
    installed: true, healthy: true, lanAddress: "192.168.8.10", dnsTcpBound: true, dnsUdpBound: true,
  } });
  let backup = null;
  if (withBackup) {
    backup = store.recordBackup({
      id: "22222222-2222-4222-8222-222222222222",
      applicationId: "pi-hole",
      destination: "local-managed",
      artifactPath: "/var/lib/boxpilot-managed/backups/pi-hole/22222222-2222-4222-8222-222222222222.tar.gz",
      checksumSha256: "a".repeat(64),
      sizeBytes: 4096,
      downtimeMs: 500,
      restoreDrill: { passed: true, network: "none" },
      createdBy: owner.id,
    });
  }
  const source = sourceInstalled ? {
    installed: true, healthy: true, state: "running", lanAddress: "192.168.8.10",
    dnsTcpBound: true, dnsUdpBound: true, detail: "healthy",
  } : { installed: false, healthy: false, state: "not-installed", lanAddress: null, dnsTcpBound: false, dnsUdpBound: false, detail: "not installed" };
  const helper = { request: vi.fn(async () => source) };
  const network = { validateAcceptanceBaseline: vi.fn(async () => ({ gatewayAddress: "192.168.8.1", resolverAddress: "192.168.8.10", exactTcpListener: true, exactUdpListener: true })) };
  const service = createDnsAcceptanceService({ store, helper, network, probeResolver });
  return { store, owner, assessment, deployment: store.getJob(deployment.id), backup, helper, network, service, probeResolver };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("direct DNS acceptance", () => {
  it("encodes and validates allowlisted DNS response evidence", async () => {
    const query = dnsAcceptanceInternals.buildDnsQuery("pi.hole", 0x1234);
    expect(query.readUInt16BE(0)).toBe(0x1234);
    expect(query.subarray(12, 21).toString("hex")).toBe("02706904686f6c6500");
    const response = Buffer.alloc(12);
    response.writeUInt16BE(0x1234, 0);
    response.writeUInt16BE(0x8180, 2);
    response.writeUInt16BE(1, 4);
    response.writeUInt16BE(1, 6);
    expect(dnsAcceptanceInternals.parseDnsResponse(response, 0x1234)).toEqual({ rcode: 0, truncated: false, recursionAvailable: true, questions: 1, answers: 1 });
    expect(() => dnsAcceptanceInternals.parseDnsResponse(response, 0x9999)).toThrow("transaction id");

    const udp = vi.fn(async (_server, packet) => {
      const answer = Buffer.alloc(12);
      answer.writeUInt16BE(packet.readUInt16BE(0), 0);
      answer.writeUInt16BE(0x8180, 2);
      answer.writeUInt16BE(1, 4);
      answer.writeUInt16BE(1, 6);
      return answer;
    });
    await expect(dnsAcceptanceInternals.queryDns("192.168.8.10", dnsAcceptanceInternals.acceptanceChecks[0], { udp, clock: () => 10 })).resolves.toMatchObject({ id: "local-udp", passed: true, rcode: 0, answers: 1 });
    await expect(dnsAcceptanceInternals.queryDns("8.8.8.8", { id: "custom", protocol: "udp", name: "secret.local" }, { udp })).rejects.toThrow("not allowlisted");
    await expect(dnsAcceptanceInternals.queryDns("192.168.8.10", { ...dnsAcceptanceInternals.acceptanceChecks[0], requireAnswers: false }, { udp })).rejects.toThrow("not allowlisted");
    await expect(dnsAcceptanceInternals.queryDns("192.168.8.10", { ...dnsAcceptanceInternals.acceptanceChecks[0], expectedRcode: 3 }, { udp })).rejects.toThrow("not allowlisted");
  });

  it("plans, stages, approves, probes, and records controller-only evidence", async () => {
    const { store, owner, assessment, deployment, backup, service, probeResolver } = await fixture();
    const status = await service.inspect();
    expect(status).toMatchObject({ linkedDeploymentJobId: deployment.id, linkedBackupId: backup.id, acceptances: [] });

    const plan = await service.plan(owner.id);
    expect(plan.output).toMatchObject({
      executable: true,
      resolverAddress: "192.168.8.10",
      linkedAssessmentId: assessment.id,
      evidenceBoundary: { provesHostPath: true, provesSecondDevicePath: false, routerMutationSupported: false, dnsCutoverSupported: false },
      blockers: [],
    });
    expect(plan.output.tests).toHaveLength(4);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "network.dns.acceptance.run", risk: "network-read", state: "awaiting_approval" });

    const privilegedHelper = { request: vi.fn() };
    const jobs = createJobService(store, privilegedHelper, {
      validateDnsAcceptanceJob: service.validateJob,
      executeDnsAcceptanceJob: service.executeJob,
      recordDnsAcceptanceResult: service.recordResult,
    });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(probeResolver).toHaveBeenCalledWith("192.168.8.10");
    expect(privilegedHelper.request).not.toHaveBeenCalled();
    expect(completed).toMatchObject({ state: "completed", result: {
      passed: true, origin: "boxpilot-controller", secondDeviceTested: false,
      routerMutationPerformed: false, dnsCutoverPerformed: false, clientSettingsChanged: false,
    } });
    expect(store.listDnsAcceptances()).toEqual([expect.objectContaining({
      id: job.parameters.acceptanceId,
      resolverAddress: "192.168.8.10",
      origin: "boxpilot-controller",
      passed: true,
      secondDeviceTested: false,
    })]);
    expect(store.listAudit().map((event) => event.type)).toContain("network.dns.acceptance.verified");
    store.close();
  });

  it("blocks planning until Pi-hole and its restore evidence both exist", async () => {
    const { store, owner, service, network } = await fixture({ sourceInstalled: false, withBackup: false });
    const plan = await service.plan(owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers.map((item) => item.id)).toEqual(expect.arrayContaining(["pi-hole-installed", "pi-hole-deployment-evidence", "pi-hole-restore-evidence"]));
    expect(network.validateAcceptanceBaseline).not.toHaveBeenCalled();
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("fails the durable job without recording acceptance when a fixed check fails", async () => {
    const failedChecks = passingChecks();
    failedChecks[2] = { ...failedChecks[2], passed: false, answers: 0 };
    const { store, owner, service } = await fixture({ probeResolver: vi.fn(async () => failedChecks) });
    const plan = await service.plan(owner.id);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const jobs = createJobService(store, { request: vi.fn() }, {
      validateDnsAcceptanceJob: service.validateJob,
      executeDnsAcceptanceJob: service.executeJob,
      recordDnsAcceptanceResult: service.recordResult,
    });
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("checks failed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: expect.stringContaining("router and client DNS remain unchanged") });
    expect(store.listDnsAcceptances()).toEqual([]);
    store.close();
  });
});

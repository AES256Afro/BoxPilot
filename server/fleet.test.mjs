import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dnsAcceptanceInternals } from "./dns-acceptance.mjs";
import { createFleetService, signedAgentMessage } from "./fleet.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const current = new Date("2026-08-16T02:00:00.000Z");

async function fixture({ withControllerAcceptance = true, withRouterAcceptance = false } = {}) {
  let observedNow = current;
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-fleet-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory, now: () => observedNow });
  const bootstrap = store.createBootstrapToken();
  const password = "correct horse battery";
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: await hashPassword(password) });
  if (withControllerAcceptance) {
    const assessment = store.createPlan({ type: "network.dns.assessment", subjectId: "fixture", createdBy: owner.id });
    const deployment = store.createJob({ type: "application.pi-hole.deploy", title: "Pi-hole", createdBy: owner.id });
    const backup = store.recordBackup({
      id: "11111111-1111-4111-8111-111111111111", applicationId: "pi-hole", destination: "local-managed",
      artifactPath: "/fixture.tar.gz", checksumSha256: "a".repeat(64), sizeBytes: 1024, downtimeMs: 10,
      restoreDrill: { passed: true }, createdBy: owner.id,
    });
    const job = store.createJob({ type: "network.dns.acceptance.run", title: "DNS", createdBy: owner.id });
    store.recordDnsAcceptance({
      id: "22222222-2222-4222-8222-222222222222", jobId: job.id, applicationId: "pi-hole",
      resolverAddress: "192.168.8.10", assessmentId: assessment.id, deploymentJobId: deployment.id, backupId: backup.id,
      origin: "boxpilot-controller", checks: [], passed: true, secondDeviceTested: false, createdBy: owner.id,
    });
  }
  if (withRouterAcceptance) {
    const checkpoint = store.recordRouterCheckpoint({ modelId: "glinet-flint-2", firmwareVersion: "4.8.2", checksumSha256: "b".repeat(64), sizeBytes: 4096, hashOrigin: "browser-webcrypto", configurationUploaded: false, fileRetainedByOperator: true, createdBy: owner.id });
    const plan = store.createPlan({ type: "network.flint2-adguard.acceptance", subjectId: "glinet-flint-2", input: {}, output: {}, createdBy: owner.id });
    const job = store.createJob({ type: "network.flint2-adguard.acceptance.run", title: "Flint 2 DNS", createdBy: owner.id });
    store.recordRouterDnsAcceptance({
      id: "33333333-3333-4333-8333-333333333333", jobId: job.id, planId: plan.id, checkpointId: checkpoint.id,
      resolverAddress: "192.168.8.1", origin: "boxpilot-controller", checks: [], assertions: {}, passed: true, createdBy: owner.id,
    });
  }
  return { store, owner, password, service: createFleetService({ store, now: () => observedNow }), setNow: (value) => { observedNow = new Date(value); } };
}

function keyPair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
}

function signedHeaders({ agentId, privateKey, sequence, timestamp = current.toISOString(), method, requestPath, body = null }) {
  const message = Buffer.from(signedAgentMessage({ agentId, sequence, timestamp, method, path: requestPath, body }), "utf8");
  return { agentId, sequence: String(sequence), timestamp, signature: sign(null, message, { key: privateKey, format: "der", type: "pkcs8" }).toString("base64url") };
}

function passingChecks(expectedChecks = dnsAcceptanceInternals.acceptanceChecks) {
  return expectedChecks.map((check) => ({
    id: check.id, protocol: check.protocol, name: check.name, type: "A", expectedRcode: check.expectedRcode,
    rcode: check.expectedRcode, answers: check.requireAnswers ? 1 : 0, recursionAvailable: true,
    truncated: false, latencyMs: 4, passed: true,
  }));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("signed fleet agent", () => {
  it("enrolls once, polls a fixed task, records signed evidence, and rejects replay", async () => {
    const { store, owner, password, service } = await fixture();
    const enrollment = await service.createEnrollment(owner.id, { password });
    const keys = keyPair();
    const agent = service.enroll({ token: enrollment.token, name: "macbook-lan", publicKey: keys.publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] });
    expect(() => service.enroll({ token: enrollment.token, name: "again-lan", publicKey: keyPair().publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] })).toThrow("invalid or expired");
    expect(service.inspect().agents[0]).toMatchObject({ id: agent.id, name: "macbook-lan", status: "active", lastSequence: 0 });
    expect(service.inspect().agents[0]).not.toHaveProperty("publicKey");

    const task = await service.createDnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 0, password });
    expect(task).toMatchObject({ agentId: agent.id, type: "dns.pi-hole.acceptance.v1", payload: { resolverAddress: "192.168.8.10", boundary: { arbitraryCommand: false, arbitraryTarget: false } } });
    const polled = service.nextTask({ headers: signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 1, method: "GET", requestPath: "/api/v1/agent/tasks/next" }) });
    expect(polled.id).toBe(task.id);

    const body = { taskId: task.id, observedAt: current.toISOString(), checks: passingChecks(), passed: true };
    const headers = signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 2, method: "POST", requestPath: "/api/v1/agent/evidence", body });
    const evidence = service.submitEvidence({ headers }, body);
    expect(evidence).toMatchObject({ taskId: task.id, agentId: agent.id, sequence: 2, passed: true, result: { secondDeviceTested: true, routerMutationPerformed: false, dnsCutoverPerformed: false } });
    expect(store.getFleetTask(task.id).state).toBe("completed");
    expect(() => service.submitEvidence({ headers }, body)).toThrow("replayed");
  });

  it("rejects forged signatures, arbitrary capabilities, stale timestamps, and tasks without controller proof", async () => {
    const { owner, password, service } = await fixture({ withControllerAcceptance: false });
    const enrollment = await service.createEnrollment(owner.id, { password });
    const keys = keyPair();
    expect(() => service.enroll({ token: enrollment.token, name: "unsafe-agent", publicKey: keys.publicKey.toString("base64url"), capabilities: ["remote-shell"] })).toThrow("dns-probe-v1");
    const agent = service.enroll({ token: enrollment.token, name: "safe-agent", publicKey: keys.publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] });
    await expect(service.createDnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 0, password })).rejects.toThrow("passing direct Bigbox");
    const forged = signedHeaders({ agentId: agent.id, privateKey: keyPair().privateKey, sequence: 1, method: "GET", requestPath: "/api/v1/agent/tasks/next" });
    expect(() => service.nextTask({ headers: forged })).toThrow("signature verification");
    const stale = signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 1, timestamp: "2026-08-16T01:00:00.000Z", method: "GET", requestPath: "/api/v1/agent/tasks/next" });
    expect(() => service.nextTask({ headers: stale })).toThrow("five-minute window");
  });

  it("dispatches and records a separate signed Flint 2 gateway proof linked to controller evidence", async () => {
    const { store, owner, password, service } = await fixture({ withControllerAcceptance: false, withRouterAcceptance: true });
    const enrollment = await service.createEnrollment(owner.id, { password });
    const keys = keyPair();
    const agent = service.enroll({ token: enrollment.token, name: "flint2-lan-agent", publicKey: keys.publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] });
    const task = await service.createFlint2DnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 0, password });
    expect(task).toMatchObject({
      type: "dns.flint2-adguard.acceptance.v1", controllerAcceptanceId: null, routerAcceptanceId: "33333333-3333-4333-8333-333333333333",
      payload: { resolverAddress: "192.168.8.1", checkpointId: expect.any(String), boundary: { arbitraryCommand: false, arbitraryTarget: false, targetMustEqualNodeDefaultGateway: true, routerMutation: false, dnsCutover: false, dhcpMutation: false, clientSettingsMutation: false, modelAttestation: false } },
    });
    expect(task.payload.checks.map((check) => `${check.protocol}:${check.name}`)).toEqual(["udp:example.com", "tcp:example.com", "udp:example.net", "udp:boxpilot.invalid"]);
    const polled = service.nextTask({ headers: signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 1, method: "GET", requestPath: "/api/v1/agent/tasks/next" }) });
    expect(polled.id).toBe(task.id);
    const body = { taskId: task.id, observedAt: current.toISOString(), checks: passingChecks(dnsAcceptanceInternals.flint2AdguardChecks), passed: true };
    const headers = signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 2, method: "POST", requestPath: "/api/v1/agent/evidence", body });
    const evidence = service.submitEvidence({ headers }, body);
    expect(evidence).toMatchObject({ passed: true, result: { type: "dns.flint2-adguard.acceptance.v1", resolverAddress: "192.168.8.1", routerAcceptanceId: "33333333-3333-4333-8333-333333333333", checkpointId: task.payload.checkpointId, secondDeviceTested: true, modelIdentityVerified: false, gatewayMatchedByAgentContract: true, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpChanged: false, clientSettingsChanged: false } });
    expect(store.getFleetTask(task.id)).toMatchObject({ state: "completed", routerAcceptanceId: "33333333-3333-4333-8333-333333333333" });
    store.close();
  });

  it("requires owner reauthentication for enrollment and revocation", async () => {
    const { owner, password, service } = await fixture();
    await expect(service.createEnrollment(owner.id, { password: "wrong password" })).rejects.toThrow("reauthentication");
    const enrollment = await service.createEnrollment(owner.id, { password });
    const keys = keyPair();
    const agent = service.enroll({ token: enrollment.token, name: "revoked-agent", publicKey: keys.publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] });
    await expect(service.revoke(owner.id, agent.id, { password: "wrong password" })).rejects.toThrow("reauthentication");
    await expect(service.revoke(owner.id, agent.id, { password })).resolves.toMatchObject({ status: "revoked" });
    const headers = signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 1, method: "GET", requestPath: "/api/v1/agent/tasks/next" });
    expect(() => service.nextTask({ headers })).toThrow("Active agent not found");
  });

  it("schedules only an approved one-shot delay and withholds the task until its exact window", async () => {
    const { store, owner, password, service, setNow } = await fixture();
    const enrollment = await service.createEnrollment(owner.id, { password });
    const keys = keyPair();
    const agent = service.enroll({ token: enrollment.token, name: "scheduled-agent", publicKey: keys.publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] });
    await expect(service.createDnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 7, password })).rejects.toThrow("immediate, 5 minutes, or 10 minutes");
    await expect(service.createDnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 5, password: "wrong password" })).rejects.toThrow("reauthentication");
    await expect(service.createDnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 5, password, command: "reboot" })).rejects.toThrow("accepts only");

    const task = await service.createDnsProbeTask(owner.id, { agentId: agent.id, delayMinutes: 5, password });
    expect(task).toMatchObject({ state: "pending", availableAt: "2026-08-16T02:05:00.000Z", expiresAt: "2026-08-16T02:15:00.000Z", payload: { schedule: { delayMinutes: 5, recurring: false, unattended: false } } });
    expect(service.nextTask({ headers: signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 1, method: "GET", requestPath: "/api/v1/agent/tasks/next" }) })).toBeNull();
    setNow("2026-08-16T02:05:00.000Z");
    expect(service.nextTask({ headers: signedHeaders({ agentId: agent.id, privateKey: keys.privateKey, sequence: 2, timestamp: "2026-08-16T02:05:00.000Z", method: "GET", requestPath: "/api/v1/agent/tasks/next" }) })).toMatchObject({ id: task.id, availableAt: task.availableAt });
    expect(service.inspect().schedulingPolicy).toMatchObject({ recurrenceSupported: false, unattendedExecutionSupported: false, allowedDelayMinutes: [0, 5, 10], passwordReauthenticationRequired: true });
    store.close();
  });
});

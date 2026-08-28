import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
import { createJobService } from "./jobs.mjs";
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
  it("keeps secret parameters out of the database and hands them to the operation at run time", async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })) };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("share.mount", { kind: "smb", host: "nas", share: "Public", name: "nas", username: "jamie", password: "hunter2 hunter2" }, owner.id);
    expect(job.parameters.password).toBe("[secret]");
    expect(store.getJob(job.id).parameters.password).toBe("[secret]");
    expect(JSON.stringify(store.getJob(job.id))).not.toContain("hunter2");
    await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery" });
    expect(helper.request).toHaveBeenCalledWith("share.mount", expect.objectContaining({ password: "hunter2 hunter2", username: "jamie" }), expect.anything());
    expect(JSON.stringify(store.getJob(job.id))).not.toContain("hunter2");

    // A job whose secrets were forgotten (service restart) cannot run with the placeholder.
    const orphan = await jobs.createOperationJob("share.mount", { kind: "smb", host: "nas", share: "Public", name: "nas2", username: "jamie", password: "x" }, owner.id);
    const { jobs: freshService } = { jobs: (await import("./jobs.mjs")).createJobService(store, helper) };
    await expect(freshService.approveAndRun(orphan.id, owner.id, { password: "correct horse battery" })).rejects.toThrow("no longer available");
  });

  it("requires password reauthentication before invoking the helper", async () => {
    const helper = { request: vi.fn() };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "wrong password")).rejects.toThrow("reauthentication failed");
    expect(helper.request).not.toHaveBeenCalled();
    expect(store.getJob(job.id).state).toBe("awaiting_approval");
    store.close();
  });

  it("approves low-risk jobs with one click, records the method, and keeps a wrong password rejected", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const session = store.getSession(store.createSession(owner.id).token);
    expect(jobs.describeApproval((await jobs.createOperationJob("apt.refresh", {}, owner.id)).id, session)).toMatchObject({ tier: "low", passwordRequired: false, mode: "tiered" });
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
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
    const canary = await jobs.createOperationJob("apt.refresh", {}, owner.id);
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
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
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
    await expect(jobs.createOperationJob("apt.upgradable.inspect", {}, owner.id)).rejects.toThrow("Read-only");
    await expect(jobs.createOperationJob("nope.op", {}, owner.id)).rejects.toThrow("Operation not found");
    await expect(jobs.createOperationJob("apt.install", { packages: ["bad name"] }, owner.id)).rejects.toThrow("invalid package name");
    const job = await jobs.createOperationJob("apt.upgrade", { packages: ["htop"] }, owner.id);
    expect(job).toMatchObject({ type: "op:apt.upgrade", title: "Install package updates", risk: "medium", state: "awaiting_approval" });
    expect(jobs.describeApproval(job.id, session)).toMatchObject({ tier: "medium", passwordRequired: false });
    const completed = await jobs.approveAndRun(job.id, owner.id, { session });
    expect(helper.request).toHaveBeenCalledWith("apt.upgrade", { packages: ["htop"] }, expect.objectContaining({ timeoutMs: 185 * 60 * 1000 }));
    expect(completed.state).toBe("completed");
    expect(completed.result).toMatchObject({ upgraded: true });
    const purge = await jobs.createOperationJob("apt.purge", { packages: ["htop"] }, owner.id);
    expect(jobs.describeApproval(purge.id, session)).toMatchObject({ tier: "high", passwordRequired: true });
    await expect(jobs.approveAndRun(purge.id, owner.id, { session })).rejects.toThrow("high-risk");
    store.close();
  });

  it("records the complete approved low-risk operation lifecycle", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
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
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("Helper unavailable");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: "Helper unavailable" });
    store.close();
  });

  it("pins prepared parameters, runs long operations in the background, and records evidence through the hook", async () => {
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const pinned = { name: "ubuntu-lab", exportId: "11111111-1111-4111-8111-111111111111", expectedUuid: "22222222-2222-4222-8222-222222222222", expectedState: "stopped" };
    const prepare = vi.fn(async (parameters) => ({ ...parameters, ...pinned }));
    const record = vi.fn();
    const jobs = createJobService(store, helper, {
      operationPrepareHooks: { "vm.export.create": prepare },
      operationRecordHooks: { "vm.export.create": record },
    });
    const job = await jobs.createOperationJob("vm.export.create", { name: "ubuntu-lab" }, owner.id);
    expect(prepare).toHaveBeenCalledWith({ name: "ubuntu-lab" });
    expect(job.parameters).toMatchObject(pinned);

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("vm.export.create", expect.objectContaining(pinned), expect.objectContaining({ timeoutMs: 6 * 60 * 60 * 1000 }));
    const result = { created: true, contentVerified: true, domain: "ubuntu-lab", exportId: pinned.exportId };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("fails the job when the evidence record hook rejects the result", async () => {
    const helper = { request: vi.fn(async () => ({ created: true })) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, {
      operationRecordHooks: { "vm.export.create": () => { throw new Error("Recorded evidence does not match the helper result"); } },
    });
    const job = await jobs.createOperationJob("vm.export.create", { name: "ubuntu-lab" }, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("Recorded evidence does not match");
    expect(store.getJob(job.id).state).toBe("failed");
    store.close();
  });

  it("refuses legacy job types now that only registry operations execute", async () => {
    const helper = { request: vi.fn() };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper);
    const job = store.createJob({ type: "virtualization.domain.create", title: "legacy", parameters: {}, recovery: {}, createdBy: owner.id });
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("not supported by this executor");
    expect(helper.request).not.toHaveBeenCalled();
    store.close();
  });

  it("records a rollback step when a failed operation reports confined cleanup", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("conversion failed; automated export cleanup completed."); }) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper);
    const job = await jobs.createOperationJob("vm.export.create", { name: "ubuntu-lab" }, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("cleanup completed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "rollback", state: "completed" })]) });
    store.close();
  });

  it("lets operators run low and medium work but reserves high-risk staging and approval for owners", async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })) };
    const { store, owner, jobs } = await setup(helper);
    const operator = store.createOwnerAccount({ username: "sam", passwordHash: await hashPassword("sams long password"), role: "operator", createdBy: owner.id });
    const operatorSession = store.getSession(store.createSession(operator.id).token);
    const medium = await jobs.createOperationJob("apt.upgrade", { packages: ["htop"] }, operator.id, { role: "operator" });
    await expect(jobs.approveAndRun(medium.id, operator.id, { session: operatorSession })).resolves.toMatchObject({ state: "completed" });
    await expect(jobs.createOperationJob("apt.purge", { packages: ["htop"] }, operator.id, { role: "operator" })).rejects.toThrow("Only the owner can stage high-risk");
    const staged = await jobs.createOperationJob("apt.purge", { packages: ["htop"] }, operator.id, { role: "owner" });
    await expect(jobs.approveAndRun(staged.id, operator.id, { password: "sams long password", session: operatorSession })).rejects.toThrow("Only the owner can approve high-risk");
    const viewer = store.createOwnerAccount({ username: "vee", passwordHash: "x", role: "viewer", createdBy: owner.id });
    await expect(jobs.createOperationJob("apt.refresh", {}, viewer.id, { role: "viewer" })).rejects.toThrow("Viewers cannot stage");
    store.close();
  });
});

describe("guarding restarts against running jobs (M4.5 / self-update safety)", () => {
  it("refuses to start a service-restarting job while another job runs, then allows it once idle", async () => {
    const helper = { request: vi.fn(async () => ({ started: true })) };
    const { store, owner, jobs } = await setup(helper);
    const expectedCommit = "a".repeat(40);

    // A job that is actively running (an update now would cut it off).
    const running = store.createJob({ type: "op:share.mount", title: "Mounting nas", parameters: {}, recovery: {}, createdBy: owner.id });
    store.transitionJob(running.id, "awaiting_approval", "applying");

    const update = await jobs.createOperationJob("system.update", { tag: "v1.62.0", expectedCommit }, owner.id);
    await expect(jobs.approveAndRun(update.id, owner.id, { password: "correct horse battery" })).rejects.toThrow(/Wait for a running job to finish first: Mounting nas/);
    expect(helper.request).not.toHaveBeenCalled();
    // The blocked update is still awaiting approval, not left half-transitioned.
    expect(store.getJob(update.id).state).toBe("awaiting_approval");

    // Once the other job finishes, the same update proceeds.
    store.transitionJob(running.id, "applying", "verifying");
    store.transitionJob(running.id, "verifying", "completed", { result: {} });
    const started = await jobs.approveAndRun(update.id, owner.id, { password: "correct horse battery" });
    expect(started.state).toBe("completed");
    expect(helper.request).toHaveBeenCalledWith("system.update", expect.objectContaining({ tag: "v1.62.0" }), expect.anything());
    store.close();
  });

  it("does not block ordinary operations while a job runs", async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })) };
    const { store, owner, jobs } = await setup(helper);
    const running = store.createJob({ type: "op:share.mount", title: "Mounting nas", parameters: {}, recovery: {}, createdBy: owner.id });
    store.transitionJob(running.id, "awaiting_approval", "applying");
    // apt.refresh does not restart the service, so it is free to run alongside.
    const refresh = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    await expect(jobs.approveAndRun(refresh.id, owner.id, { session: store.getSession(store.createSession(owner.id).token) })).resolves.toMatchObject({ state: "completed" });
    store.close();
  });
});

describe("cancelling staged jobs", () => {
  it("lets the creator withdraw a job awaiting approval and refuses to approve it afterwards", async () => {
    const helper = { request: vi.fn() };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    const cancelled = jobs.cancelJob(job.id, owner.id, { role: "owner" });
    expect(cancelled.state).toBe("cancelled");
    expect(() => jobs.cancelJob(job.id, owner.id)).toThrow("awaiting approval");
    await expect(jobs.approveAndRun(job.id, owner.id, { session: store.getSession(store.createSession(owner.id).token) })).rejects.toThrow();
    expect(helper.request).not.toHaveBeenCalled();
    store.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
import { createJobService, jobLogAlertKey, logUnreadable, recordFailed } from "./jobs.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";
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
  it("saves completed output before asking the helper to release the protected cache", async () => {
    const seen = [];
    let store;
    const helper = { request: vi.fn(async (operation, parameters) => {
      if (operation === "job.output.release") { seen.push(store.getJobOutput(parameters.jobId)); return { removed: true }; }
      return { ok: true };
    }) };
    const setupResult = await setup(helper); store = setupResult.store;
    const jobs = createJobService(store, helper, { jobLog: { read: async () => ({ text: "final output", exists: true }), remove: () => { throw new Error("web must not unlink root logs"); } } });
    const job = await jobs.createOperationJob("apt.refresh", {}, setupResult.owner.id);
    expect((await jobs.approveAndRun(job.id, setupResult.owner.id, {})).state).toBe("completed");
    expect(seen).toEqual(["final output"]);
    store.close();
  });
  it("preserves failed output without requesting cache deletion", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("operation failed"); }) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, { jobLog: { read: async () => ({ text: "failure details", exists: true }) } });
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow("operation failed");
    expect(store.getJobOutput(job.id)).toBe("failure details");
    expect(helper.request).toHaveBeenCalledOnce();
    store.close();
  });
  it.each([false, true])("refreshes evidence after a settled operation without masking its outcome (failure=%s)", async (failed) => {
    const helper = { request: async () => { if (failed) throw new Error("original operation error"); return { ok: true }; } };
    const { store, owner } = await setup(helper);
    const statesAtRefresh = [];
    const hook = vi.fn(async (job) => { statesAtRefresh.push(store.getJob(job.id).state); throw new Error("refresh failed"); });
    const jobs = createJobService(store, helper, { onOperationSettled: hook });
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    if (failed) await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow("original operation error");
    else expect((await jobs.approveAndRun(job.id, owner.id, {})).state).toBe("completed");
    expect(hook).toHaveBeenCalledOnce();
    expect(statesAtRefresh).toEqual([failed ? "applying" : "verifying"]);
    expect(store.getJob(job.id).state).toBe(failed ? "failed" : "completed");
    store.close();
  });
  it("expires secret-bearing approvals at the boundary and drops abandoned credentials", async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })) };
    const { store, owner } = await setup(helper);
    let clock = Date.parse("2026-09-07T12:00:00Z");
    const jobs = createJobService(store, helper, { now: () => clock });
    const first = await jobs.createOperationJob("samba.user.set", { username: "sam", password: "twelve chars long" }, owner.id);
    const ordinary = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    expect(jobs.describeApproval(first.id)).toMatchObject({ expiresAt: "2026-09-07T12:30:00.000Z", expired: false });
    clock += 30 * 60_000 - 1;
    expect(jobs.pruneStagedSecrets()).toBe(0);
    clock += 1;
    await expect(jobs.approveAndRun(first.id, owner.id, {})).rejects.toThrow("approval expired");
    expect(store.getJob(first.id).state).toBe("cancelled");
    expect(helper.request).not.toHaveBeenCalled();
    expect(jobs.describeApproval(ordinary.id)).toMatchObject({ expiresAt: null, expired: false });
    const second = await jobs.createOperationJob("samba.user.set", { username: "sam", password: "another password" }, owner.id);
    clock += 30 * 60_000;
    expect(jobs.pruneStagedSecrets()).toBe(1);
    expect(jobs.pruneStagedSecrets()).toBe(0);
    expect(store.getJob(second.id).state).toBe("cancelled");
    const restarted = createJobService(store, helper, { now: () => clock });
    await expect(restarted.approveAndRun(second.id, owner.id, {})).rejects.toThrow("approval expired");
    expect(JSON.stringify(store.listJobs())).not.toContain("another password");
    store.close();
  });

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
    store.close();
  });

  it("keeps raw Compose credentials out of persisted jobs while delivering the approved edit", async () => {
    const helper = { request: vi.fn(async () => ({ edited: true })) };
    const { store, owner, jobs } = await setup(helper);
    const compose = "services:\n  demo:\n    environment:\n      TOKEN: private-compose-fixture\n";
    try {
      const job = await jobs.createOperationJob("app.compose.edit", { id: "demo", compose }, owner.id);
      expect(store.getJob(job.id).parameters.compose).toBe("[secret]");
      await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery" });
      expect(helper.request).toHaveBeenCalledWith("app.compose.edit", expect.objectContaining({ compose }), expect.anything());
      expect(JSON.stringify(store.getJob(job.id))).not.toContain("private-compose-fixture");
    } finally { store.close(); }
  });

  it("requires password reauthentication before invoking the helper", async () => {
    const helper = { request: vi.fn() };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "wrong password")).rejects.toThrow("Wrong password");
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
    await expect(jobs.approveAndRun(job.id, owner.id, { password: "wrong password", session })).rejects.toThrow("Wrong password");
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
    await expect(jobs.approveAndRun(job.id, owner.id, { session })).rejects.toThrow("Enter the owner password");
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
    await expect(jobs.approveAndRun(job.id, owner.id, { session })).rejects.toThrow("Enter the owner password");
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

  // Dockge's failed Start (2026-09-29) read "apply · running" beside "verify · failed": the failure
  // closed a step that never ran and left the one that did running forever.
  it("ends the step that was running when the operation fails, and no step is left running", async () => {
    const reason = "Dockge was not started. Port 5001 is taken on the tailnet address (100.64.0.10) by Tailscale Serve, which publishes Dockge itself at https://homebox.tailXXXX.ts.net:5001.";
    const helper = { request: vi.fn(async () => { throw new Error(reason); }) };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("app.action", { id: "dockge", action: "start" }, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("Port 5001 is taken");
    const failed = store.getJob(job.id);
    expect(failed.state).toBe("failed");
    const latest = new Map(failed.steps.map((step) => [step.name, step]));
    expect([...latest.values()].filter((step) => step.state === "running")).toEqual([]);
    expect(latest.get("apply")).toMatchObject({ state: "failed", detail: `Start, stop, pause, or restart application failed: ${reason}` });
    // Verify never ran, so it is not said to have failed.
    expect(failed.steps.some((step) => step.name === "verify")).toBe(false);
    store.close();
  });

  it("fails verify, not apply, when the operation ran and its result could not be recorded", async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, { operationRecordHooks: { "apt.refresh": () => { throw new Error("disk full"); } } });
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("disk full");
    const steps = store.getJob(job.id).steps;
    const latest = new Map(steps.map((step) => [step.name, step.state]));
    expect(latest.get("apply")).toBe("completed");
    expect(latest.get("verify")).toBe("failed");
    expect([...latest.values()]).not.toContain("running");
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

  describe("a result that could not be saved (M27.2)", () => {
    // Closed before the directory goes, pass or fail: an open database cannot be deleted on Windows.
    const open = [];
    afterEach(() => { for (const store of open.splice(0)) { try { store.close(); } catch { /* already closed */ } } });
    // The real health-alert ledger over the job store, with a stand-in notification target.
    async function recording({ target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })) } = {}) {
      const helper = { request: vi.fn(async () => ({ created: true })) };
      const { store, owner } = await setup(helper);
      open.push(store);
      const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => target, send }, store, now: () => new Date("2026-09-27T03:00:00Z") });
      let broken = true;
      const jobs = createJobService(store, helper, {
        alerts,
        operationRecordHooks: { "vm.export.create": () => { if (broken) throw new Error("UNIQUE constraint failed: vm_exports.id"); } },
      });
      const runOnce = async () => {
        const job = await jobs.createOperationJob("vm.export.create", { name: "ubuntu-lab" }, owner.id);
        await jobs.approveAndRun(job.id, owner.id, "correct horse battery").catch(() => {});
        await alerts.clear("nothing:pending"); // the job announces without waiting; this waits for it
        return store.getJob(job.id);
      };
      return { store, send, runOnce, fix: () => { broken = false; }, state: () => store.getSetting("healthAlertsState", {}) };
    }
    const key = "record.failed:vm.export.create:ubuntu-lab";

    it("says which half failed, is announced once per operation, and clears when it records again", async () => {
      const { send, runOnce, fix, state } = await recording();
      const failed = await runOnce();
      expect(failed.state).toBe("failed");
      // The job record says the operation ran and only the record did not land; the notifier reads
      // this to leave the job's own push to the alert.
      expect(recordFailed(failed)).toBe(true);
      expect(failed.steps.find((step) => step.name === "record").detail).toContain("The operation ran, but BoxPilot could not save its result: UNIQUE constraint failed");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Result not saved: Export a stopped VM (ubuntu-lab)", message: expect.stringContaining("could not save what it did: UNIQUE constraint failed: vm_exports.id. Pages that show it"), priority: "high" });

      await runOnce();
      expect(send).toHaveBeenCalledTimes(1); // the same record failing again is not a second push

      fix();
      const recorded = await runOnce();
      expect(recorded.state).toBe("completed");
      expect(recordFailed(recorded)).toBe(false);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved. Result not saved: Export a stopped VM (ubuntu-lab)" }));
      expect(state()).toEqual({});
    });

    it("is kept as not announced when there is no target", async () => {
      const { send, runOnce, state } = await recording({ target: null });
      await runOnce();
      expect(send).not.toHaveBeenCalled();
      expect(state()[key]).toMatchObject({ notified: false, title: "Result not saved: Export a stopped VM (ubuntu-lab)", message: expect.stringContaining("UNIQUE constraint failed") });
    });

    it("is kept as not announced when the target does not answer", async () => {
      const send = vi.fn(async () => { throw new Error("The notification target answered 502"); });
      const { runOnce, state } = await recording({ send });
      await runOnce();
      expect(send).toHaveBeenCalledTimes(1);
      expect(state()[key]).toMatchObject({ notified: false });
    });
  });

  describe("a job log BoxPilot cannot open (M30.1)", () => {
    const open = [];
    afterEach(() => { for (const store of open.splice(0)) { try { store.close(); } catch { /* already closed */ } } });
    /**
     * The real ledger and job service over a stand-in log reader whose `check` answers what the
     * test says: the M27.4 canary's question, asked of every job once the helper is done with it.
     */
    async function logging({ target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })), fails = false } = {}) {
      const helper = { request: vi.fn(async (operation) => { if (operation !== "job.output.release" && fails) throw new Error("apt-get update failed"); return { ok: true }; }) };
      const { store, owner } = await setup(helper);
      open.push(store);
      const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => target, send }, store, now: () => new Date("2026-09-28T03:00:00Z") });
      let status = { state: "unreadable", code: "EACCES", blocking: { what: "folder", mode: 0o700 } };
      const jobLog = { check: vi.fn(async () => status), read: vi.fn(async () => ({ text: "the output", exists: true })) };
      const jobs = createJobService(store, helper, { alerts, jobLog });
      const runOnce = async () => {
        const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
        await jobs.approveAndRun(job.id, owner.id, {}).catch(() => {});
        await alerts.clear("nothing:pending"); // the job announces without waiting; this waits for it
        return store.getJob(job.id);
      };
      return { store, send, jobLog, helper, runOnce, set: (next) => { status = next; }, state: () => store.getSetting("healthAlertsState", {}) };
    }

    it("says so on the job instead of an empty log, raises one condition, and clears on the next readable log", async () => {
      const { store, send, jobLog, helper, runOnce, set, state } = await logging();
      const first = await runOnce();
      // The operation's own outcome stands; the log is what is missing, and the job says why.
      expect(first.state).toBe("completed");
      expect(logUnreadable(first)).toBe(true);
      expect(first.steps.find((step) => step.name === "log")).toMatchObject({ state: "failed", detail: expect.stringContaining("permission denied (the log folder is mode 700)") });
      // Cheap: an open and a stat, not a read of what could be a 4 MiB log, and nothing saved or released.
      expect(jobLog.read).not.toHaveBeenCalled();
      expect(store.getJobOutput(first.id)).toBeNull();
      expect(helper.request).not.toHaveBeenCalledWith("job.output.release", expect.anything(), expect.anything());
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Job output cannot be read", message: expect.stringContaining("The helper wrote the output of Refresh package lists, but BoxPilot could not open it: permission denied"), priority: "high" });
      expect(Object.keys(state())).toEqual([jobLogAlertKey]);

      // Every job after it is the same failure, and the same one push.
      expect(logUnreadable(await runOnce())).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);

      // A job that printed nothing proves nothing either way: the condition stands.
      set({ state: "absent" });
      const quiet = await runOnce();
      expect(logUnreadable(quiet)).toBe(false);
      expect(Object.keys(state())).toEqual([jobLogAlertKey]);

      set({ state: "readable", bytes: 10 });
      const readable = await runOnce();
      expect(logUnreadable(readable)).toBe(false);
      expect(store.getJobOutput(readable.id)).toBe("the output");
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved. Job output cannot be read" }));
      expect(state()).toEqual({});
    });

    it("is checked for a failed job too, and kept as not announced when there is no target", async () => {
      const { send, runOnce, state } = await logging({ target: null, fails: true });
      const failed = await runOnce();
      expect(failed.state).toBe("failed");
      expect(logUnreadable(failed)).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(state()[jobLogAlertKey]).toMatchObject({ notified: false, title: "Job output cannot be read" });
    });

    it("leaves a reader without the check, and a check that throws, to the old path", async () => {
      const helper = { request: vi.fn(async () => ({ ok: true })) };
      const { store, owner } = await setup(helper);
      open.push(store);
      const raise = vi.fn(async () => ({}));
      const jobs = createJobService(store, helper, { alerts: { raise, clear: vi.fn(async () => ({})) }, jobLog: { check: async () => { throw new Error("stat failed"); }, read: async () => ({ text: "saved anyway", exists: true }) } });
      const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
      await jobs.approveAndRun(job.id, owner.id, {});
      expect(store.getJobOutput(job.id)).toBe("saved anyway");
      expect(raise).not.toHaveBeenCalled();
    });
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

  it("records a rollback as completed only when the operation's own rollback worked", async () => {
    // Any error mentioning "rollback" used to be recorded as "undid its partial changes", and the
    // errors that mention it are mostly the ones whose rollback FAILED; the ones that worked
    // ("the previous image was restored") recorded nothing.
    const rollbackSteps = async (error) => {
      const helper = { request: vi.fn(async () => { throw error; }) };
      const { store, owner, jobs } = await setup(helper);
      try {
        const job = await jobs.createOperationJob("app.update", { id: "jellyfin" }, owner.id);
        await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow();
        return store.getJob(job.id).steps.filter((step) => step.name === "rollback").map((step) => step.state);
      } finally { store.close(); }
    };
    // The helper says which, as rolledBack on the error.
    expect(await rollbackSteps(Object.assign(new Error("Jellyfin update failed and automatic rollback also failed. docker compose up failed"), { rolledBack: false }))).toEqual(["failed"]);
    expect(await rollbackSteps(Object.assign(new Error("Jellyfin update failed; the previous image was restored. docker compose up failed"), { rolledBack: true }))).toEqual(["completed"]);
    // Without it, only the words for a rollback that worked count; the bare word never does.
    expect(await rollbackSteps(new Error("Jellyfin update failed and automatic rollback also failed. docker compose up failed"))).toEqual([]);
    expect(await rollbackSteps(new Error("The incomplete recovery domain failed exact rollback validation"))).toEqual([]);
    expect(await rollbackSteps(new Error("Jellyfin update failed; the previous image was restored. docker compose up failed"))).toEqual(["completed"]);
    expect(await rollbackSteps(new Error("Jellyfin rejected the edited compose file; the previous one was restored. docker compose up failed"))).toEqual(["completed"]);
    expect(await rollbackSteps(new Error("Jellyfin installation failed and was rolled back. docker compose up failed"))).toEqual(["completed"]);
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
    const { store, owner } = await setup(helper);
    // Running 1.61.0, so an update to 1.62.0 is still worth approving (M36 cancels one that is not).
    const jobs = createJobService(store, helper, { version: "1.61.0" });
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

// M36: two updates staged for 1.116 waited three weeks for approval on a server running 1.138.
describe("staged jobs nobody will approve", () => {
  const day = 86_400_000;
  const expectedCommit = "a".repeat(40);

  it("cancels an update to a version already running, at approval and in the sweep, and says why", async () => {
    const helper = { request: vi.fn(async () => ({ started: true })) };
    const { store, owner } = await setup(helper);
    const staged = createJobService(store, helper, { version: "1.116.0" });
    const older = await staged.createOperationJob("system.update", { tag: "v1.116.0", expectedCommit }, owner.id);
    const newer = await staged.createOperationJob("system.update", { tag: "v1.139.0", expectedCommit }, owner.id);
    const other = await staged.createOperationJob("apt.refresh", {}, owner.id);

    // The server has been updated to 1.138.0 since.
    const jobs = createJobService(store, helper, { version: "1.138.0" });
    await expect(jobs.approveAndRun(older.id, owner.id, { password: "correct horse battery" })).rejects.toThrow("BoxPilot is already at 1.138.0, so the update to v1.116.0 has nothing to do, so BoxPilot cancelled it. Nothing ran.");
    expect(helper.request).not.toHaveBeenCalled();
    expect(store.getJob(older.id)).toMatchObject({ state: "cancelled", error: "Superseded: BoxPilot is already at 1.138.0, so the update to v1.116.0 has nothing to do." });

    const again = await staged.createOperationJob("system.update", { tag: "v1.116.1", expectedCommit }, owner.id);
    expect(jobs.sweepStaleApprovals()).toEqual([{ id: again.id, why: "superseded", reason: "BoxPilot is already at 1.138.0, so the update to v1.116.1 has nothing to do" }]);
    expect(store.getJob(again.id).steps.at(-1)).toMatchObject({ name: "cancelled", detail: expect.stringMatching(/^Superseded: /) });
    // An update to a newer version, and any other operation, keep waiting.
    expect(store.getJob(newer.id).state).toBe("awaiting_approval");
    expect(store.getJob(other.id).state).toBe("awaiting_approval");
    store.close();
  });

  it("cancels a job left a week without an approval, and tells the owner once", async () => {
    const helper = { request: vi.fn() };
    const { store, owner } = await setup(helper);
    let clock = Date.now();
    const told = [];
    const alerts = { raise: async () => ({}), clear: async () => ({}), tell: vi.fn(async (entry) => { told.push(entry); return { notified: false }; }) };
    const jobs = createJobService(store, helper, { alerts, now: () => clock });
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    clock += 6 * day;
    expect(jobs.sweepStaleApprovals()).toEqual([]);
    clock += 2 * day;
    expect(jobs.sweepStaleApprovals()).toEqual([{ id: job.id, why: "lapsed" }]);
    expect(store.getJob(job.id)).toMatchObject({ state: "cancelled", error: expect.stringMatching(/^Nobody approved it in 7 days/) });
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toMatchObject({ key: `approval.lapsed:${job.id}`, title: "Not approved in 7 days: Refresh package lists" });
    expect(jobs.sweepStaleApprovals()).toEqual([]);
    expect(told).toHaveLength(1);
    store.close();
  });

  it("lets a failed job be dismissed by its creator or the owner, once, and only a failed one", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("operation failed"); }) };
    const { store, owner, jobs } = await setup(helper);
    const job = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow("operation failed");
    const dismissedJob = jobs.dismissFailure(job.id, owner.id);
    expect(dismissedJob.state).toBe("failed");
    expect(dismissedJob.steps.filter((step) => step.name === "dismissed")).toHaveLength(1);
    expect(dismissedJob.steps.at(-1).detail).toMatch(/^Dismissed by operator\./);
    expect(jobs.dismissFailure(job.id, owner.id).steps.filter((step) => step.name === "dismissed")).toHaveLength(1);
    expect(() => jobs.dismissFailure(job.id, "someone-else", { role: "operator" })).toThrow("Job not found");
    const pending = await jobs.createOperationJob("apt.refresh", {}, owner.id);
    expect(() => jobs.dismissFailure(pending.id, owner.id)).toThrow("Only a failed job can be dismissed");
    store.close();
  });
});

describe("an app's own secrets, typed into the install form", () => {
  // The registry can only flag top-level fields. A tunnel token or API key arrives nested inside
  // values.env, and before this it was written to the jobs table in clear - and from there into
  // every controller backup and machine snapshot while the row was retained.
  async function withManifestSecret() {
    const seen = [];
    const helper = { request: async (operation, parameters) => { seen.push({ operation, parameters }); return { installed: true }; } };
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-jobs-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: await hashPassword("correct horse battery") });
    const jobs = createJobService(store, helper, { secretEnvNamesFor: async (id) => (id === "cloudflared" ? ["TUNNEL_TOKEN"] : []) });
    return { store, owner, jobs, seen };
  }

  it("keeps the token out of the job record and hands the real one to the helper", async () => {
    const { store, owner, jobs, seen } = await withManifestSecret();
    const job = await jobs.createOperationJob("app.install", { id: "cloudflared", values: { env: { TUNNEL_TOKEN: "eyJ-very-secret", TUNNEL_NAME: "home" } } }, owner.id);
    expect(store.getJob(job.id).parameters.values.env).toEqual({ TUNNEL_TOKEN: "[secret]", TUNNEL_NAME: "home" });   // the record
    expect(JSON.stringify(store.getJob(job.id))).not.toContain("eyJ-very-secret");
    await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery" });
    const install = seen.find((call) => call.operation === "app.install");
    expect(install.parameters.values.env.TUNNEL_TOKEN).toBe("eyJ-very-secret");   // the helper gets the real one
    store.close();
  });

  it("leaves an app with no secret env alone", async () => {
    const { store, owner, jobs } = await withManifestSecret();
    const job = await jobs.createOperationJob("app.install", { id: "jellyfin", values: { env: { TZ: "UTC" } } }, owner.id);
    expect(store.getJob(job.id).parameters.values.env).toEqual({ TZ: "UTC" });
    store.close();
  });

  it("refuses to install with the placeholder when the staged copy is gone", async () => {
    // A restart empties the in-memory staging. Installing with the literal text "[secret]" as the
    // token would be worse than failing.
    const { store, owner, jobs } = await withManifestSecret();
    const job = await jobs.createOperationJob("app.install", { id: "cloudflared", values: { env: { TUNNEL_TOKEN: "eyJ-very-secret" } } }, owner.id);
    const fresh = createJobService(store, { request: async () => ({}) }, { secretEnvNamesFor: async () => ["TUNNEL_TOKEN"] });
    await expect(fresh.approveAndRun(job.id, owner.id, { password: "correct horse battery" })).rejects.toThrow("no longer available");
    store.close();
  });
});

describe("staged secrets whose job is finished with them", () => {
  it("are dropped by the prune, while a job still awaiting approval keeps its own", async () => {
    // A job abandoned by closing the tab is pruned from the database after thirty days; its
    // password sat in this process's memory for as long as the process lived.
    const seen = [];
    const helper = { request: async (operation, parameters) => { seen.push({ operation, parameters }); return { mounted: true }; } };
    const { store, owner, jobs } = await setup(helper);
    const waiting = await jobs.createOperationJob("share.mount", { kind: "smb", host: "nas", share: "Public", name: "nas-a", username: "jamie", password: "hunter2 hunter2" }, owner.id);
    const abandoned = await jobs.createOperationJob("share.mount", { kind: "smb", host: "nas", share: "Public", name: "nas-b", username: "jamie", password: "hunter2 hunter2" }, owner.id);
    // Another service on the same database cancels it - the way a prune or a second process would
    // change the row without this process's map hearing about it.
    createJobService(store, helper).cancelJob(abandoned.id, owner.id, { role: "owner" });
    expect(jobs.pruneStagedSecrets()).toBe(1);
    expect(jobs.pruneStagedSecrets()).toBe(0);
    await jobs.approveAndRun(waiting.id, owner.id, { password: "correct horse battery" });
    expect(seen.find((call) => call.operation === "share.mount")?.parameters.password).toBe("hunter2 hunter2");
    store.close();
  });
});

describe("an app secret typed as a number", () => {
  // values.env accepts numbers and the deployer turns them into text, so a PIN or a numeric token
  // can arrive as 918273645546372 rather than "918273645546372". Only strings were staged: the
  // number went into the jobs table, and every backup of it, in clear.
  it("is staged like a string one and still reaches the helper", async () => {
    const seen = [];
    const helper = { request: async (operation, parameters) => { seen.push({ operation, parameters }); return { installed: true }; } };
    const { store, owner } = await setup(helper);
    try {
      const jobs = createJobService(store, helper, { secretEnvNamesFor: async () => ["ADMIN_PIN"] });
      const job = await jobs.createOperationJob("app.install", { id: "pinned-app", values: { env: { ADMIN_PIN: 918273645546372, TZ: "UTC" } } }, owner.id);
      expect(store.getJob(job.id).parameters.values.env).toEqual({ ADMIN_PIN: "[secret]", TZ: "UTC" });
      expect(JSON.stringify(store.listJobs())).not.toContain("918273645546372");
      await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery" });
      expect(seen.find((call) => call.operation === "app.install").parameters.values.env.ADMIN_PIN).toBe(918273645546372);
      expect(JSON.stringify(store.listJobs())).not.toContain("918273645546372");
    } finally { store.close(); }
  });
});

describe("an app the catalog cannot name", () => {
  it("has every setting staged, since any of them might be its secret", async () => {
    // A mistyped id: the catalog answers null, which used to read as "no secrets", so the token
    // typed beside it went into the jobs table before the install failed to find the app.
    const seen = [];
    const helper = { request: async (operation, parameters) => { seen.push({ operation, parameters }); return { installed: true }; } };
    const { store, owner } = await setup(helper);
    try {
      const jobs = createJobService(store, helper, { secretEnvNamesFor: async (id) => (id === "cloudflared" ? ["TUNNEL_TOKEN"] : null) });
      const job = await jobs.createOperationJob("app.install", { id: "cloudfared", values: { env: { TUNNEL_TOKEN: "eyJ-typo-token", TUNNEL_NAME: "home" } } }, owner.id);
      expect(store.getJob(job.id).parameters.values.env).toEqual({ TUNNEL_TOKEN: "[secret]", TUNNEL_NAME: "[secret]" });
      await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery" });
      expect(seen.find((call) => call.operation === "app.install").parameters.values.env).toEqual({ TUNNEL_TOKEN: "eyJ-typo-token", TUNNEL_NAME: "home" });
      expect(JSON.stringify(store.listJobs())).not.toContain("eyJ-typo-token");
    } finally { store.close(); }
  });
});

describe("a job that ran out of time (M30.3)", () => {
  const minutes = (value) => value * 60_000;
  const log = "$ docker compose up --detach --remove-orphans\n jellyfin Pulling\n abc123 Downloading 812MB/2.1GB\n";

  /**
   * A store and job service on one injected clock. `answer(operation, parameters, options, advance)`
   * plays the helper: it moves the clock on by however long the operation "took", then answers.
   */
  async function timed(answer, options = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-jobs-timeout-"));
    directories.push(directory);
    let at = Date.parse("2026-09-28T09:00:00.000Z");
    const advance = (ms) => { at += ms; };
    const store = createStateStore({ stateDirectory: directory, now: () => new Date(at) });
    const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "operator", passwordHash: "not-checked-here" });
    const helper = { request: vi.fn(async (operation, parameters, requestOptions) => answer(operation, parameters, requestOptions, advance)) };
    const jobs = createJobService(store, helper, { now: () => at, jobLog: { read: async () => ({ text: log, exists: true }) }, ...options });
    return { store, owner, jobs, helper, advance };
  }
  // What the helper client throws when the whole budget runs out, and what a helper reply carries
  // when one step inside the operation hit its own limit.
  const budgetRanOut = (options, advance, extra = {}) => { advance(options.timeoutMs); throw Object.assign(new Error("Helper request timed out (overall deadline reached)"), { code: "timeout", timeout: { scope: "operation", budgetMs: options.timeoutMs, ...extra } }); };

  it("records the budget, the time used and how far it got, instead of a failure sentence", async () => {
    const { store, owner, jobs, helper } = await timed((_operation, _parameters, options, advance) => budgetRanOut(options, advance));
    try {
      const job = await jobs.createOperationJob("app.install", { id: "jellyfin", values: {} }, owner.id);
      await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow("overall deadline");
      expect(helper.request).toHaveBeenCalledWith("app.install", { id: "jellyfin", values: {} }, { timeoutMs: minutes(25), jobId: job.id });
      const failed = store.getJob(job.id);
      expect(failed.state).toBe("failed");
      expect(failed.timeout).toEqual({ scope: "operation", budgetMs: minutes(25), elapsedMs: minutes(25), phase: "running", step: null, lastOutput: "abc123 Downloading 812MB/2.1GB", moreTimeMs: minutes(50) });
      expect(failed.error).toBe("Install application did not finish within 25 minutes. It may still be running on the server; Activity shows how far it got.");
      expect(failed.steps.find((step) => step.name === "timeout")).toMatchObject({ state: "reached", detail: "Used its whole 25 minutes; BoxPilot stopped waiting after 25 minutes" });
      expect(failed.steps.some((step) => step.name === "verify" && step.state === "failed")).toBe(false);
    } finally { store.close(); }
  });

  it("keeps the operation's own sentence when one step inside it hit its limit", async () => {
    const { store, owner, jobs } = await timed((_operation, _parameters, _options, advance) => {
      advance(minutes(33));
      // As the helper-response reader rebuilds it from the helper's reply.
      throw Object.assign(new Error("Jellyfin update failed before anything was restarted; the app was unchanged. Downloading the new images did not finish within 30 minutes"), { code: "timeout", timeout: { scope: "step", budgetMs: minutes(30), step: "Downloading the new images" } });
    });
    try {
      const job = await jobs.createOperationJob("app.update", { id: "jellyfin" }, owner.id);
      await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow("was unchanged");
      const failed = store.getJob(job.id);
      expect(failed.timeout).toMatchObject({ scope: "step", budgetMs: minutes(30), elapsedMs: minutes(33), step: "Downloading the new images", moreTimeMs: minutes(80) });
      expect(failed.error).toMatch(/^Jellyfin update failed before anything was restarted/);
      expect(failed.steps.map((step) => step.name)).toEqual(expect.arrayContaining(["timeout", "rollback"]));
    } finally { store.close(); }
  });

  it("offers more time only to operations that declare it, and not to a job that never started", async () => {
    const { store, owner, jobs } = await timed((operation, _parameters, options, advance) => (operation === "app.model.pull" ? budgetRanOut(options, advance, { phase: "queued" }) : budgetRanOut(options, advance)));
    try {
      const upgrade = await jobs.createOperationJob("apt.upgrade", { packages: ["htop"] }, owner.id);
      await expect(jobs.approveAndRun(upgrade.id, owner.id, {})).rejects.toThrow();
      expect(store.getJob(upgrade.id).timeout).toMatchObject({ scope: "operation", budgetMs: minutes(185), moreTimeMs: null });
      const queued = await jobs.createOperationJob("app.model.pull", { id: "ollama", model: "llama3:8b" }, owner.id);
      await expect(jobs.approveAndRun(queued.id, owner.id, {})).rejects.toThrow();
      expect(store.getJob(queued.id).timeout).toMatchObject({ phase: "queued", moreTimeMs: null });
      expect(store.getJob(queued.id).error).toMatch(/waited 2 hours 30 minutes behind other work/);
      await expect(jobs.retryWithMoreTime(queued.id, owner.id)).rejects.toThrow("never started");
    } finally { store.close(); }
  });

  it("leaves an ordinary failure without a timeout", async () => {
    const { store, owner, jobs } = await timed(() => { throw new Error("docker compose up failed: no such image"); });
    try {
      const job = await jobs.createOperationJob("app.install", { id: "jellyfin", values: {} }, owner.id);
      await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow("no such image");
      expect(store.getJob(job.id)).toMatchObject({ state: "failed", timeout: null, error: "docker compose up failed: no such image" });
      await expect(jobs.retryWithMoreTime(job.id, owner.id)).rejects.toThrow("Only a job that ran out of time");
    } finally { store.close(); }
  });

  it("stages the same operation again with twice the budget, through approval, up to the maximum", async () => {
    const { store, owner, jobs, helper } = await timed((_operation, _parameters, options, advance) => budgetRanOut(options, advance));
    try {
      const first = await jobs.createOperationJob("app.install", { id: "jellyfin", values: {} }, owner.id);
      await expect(jobs.approveAndRun(first.id, owner.id, {})).rejects.toThrow();

      const second = await jobs.retryWithMoreTime(first.id, owner.id);
      // Staged, not run: it waits for the same approval as anything else.
      expect(second).toMatchObject({ state: "awaiting_approval", type: "op:app.install", parameters: { id: "jellyfin", values: {} }, recovery: { budgetMs: minutes(50), retryOf: first.id } });
      expect(second.steps.find((step) => step.name === "budget").detail).toBe("Allowed 50 minutes instead of the usual 25 minutes");
      expect(store.getJob(first.id).steps.at(-1)).toMatchObject({ name: "retry", state: "staged", detail: `Staged again with 50 minutes as job ${second.id}` });
      expect(jobs.describeApproval(second.id)).toMatchObject({ tier: "medium", passwordRequired: false });
      expect(helper.request).toHaveBeenCalledTimes(1);

      await expect(jobs.approveAndRun(second.id, owner.id, {})).rejects.toThrow();
      // The larger budget reaches the helper, which checks it against the registry.
      expect(helper.request).toHaveBeenLastCalledWith("app.install", { id: "jellyfin", values: {} }, { timeoutMs: minutes(50), jobId: second.id, budgetMs: minutes(50) });
      expect(store.getJob(second.id).timeout).toMatchObject({ budgetMs: minutes(50), elapsedMs: minutes(50), moreTimeMs: minutes(100) });

      const third = await jobs.retryWithMoreTime(second.id, owner.id);
      expect(third.recovery.budgetMs).toBe(minutes(100));
      await expect(jobs.approveAndRun(third.id, owner.id, {})).rejects.toThrow();
      expect(store.getJob(third.id).timeout.moreTimeMs).toBeNull();
      await expect(jobs.retryWithMoreTime(third.id, owner.id)).rejects.toThrow("already had the most time it can have, 1 hour 40 minutes");
    } finally { store.close(); }
  });

  it("never skips approval: always-ask still wants the password for the retry", async () => {
    const { store, owner, jobs, helper } = await timed((_operation, _parameters, options, advance) => budgetRanOut(options, advance));
    try {
      const first = await jobs.createOperationJob("app.update", { id: "jellyfin" }, owner.id);
      await expect(jobs.approveAndRun(first.id, owner.id, {})).rejects.toThrow();
      store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
      const retry = await jobs.retryWithMoreTime(first.id, owner.id);
      expect(jobs.describeApproval(retry.id)).toMatchObject({ passwordRequired: true, tier: "medium" });
      await expect(jobs.approveAndRun(retry.id, owner.id, {})).rejects.toThrow("Enter the owner password");
      expect(helper.request).toHaveBeenCalledTimes(1);
      expect(store.getJob(retry.id).state).toBe("awaiting_approval");
    } finally { store.close(); }
  });

  it("is the creator's or the owner's to retry, and never a job whose secrets are gone", async () => {
    const { store, owner, jobs } = await timed((_operation, _parameters, options, advance) => budgetRanOut(options, advance), { secretEnvNamesFor: async () => ["API_TOKEN"] });
    try {
      const sam = store.createOwnerAccount({ username: "sam", passwordHash: "x", role: "operator", createdBy: owner.id });
      const job = await jobs.createOperationJob("app.install", { id: "jellyfin", values: {} }, owner.id);
      await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow();
      await expect(jobs.retryWithMoreTime(job.id, sam.id, { role: "operator" })).rejects.toThrow("Job not found");

      const withToken = await jobs.createOperationJob("app.install", { id: "jellyfin", values: { env: { API_TOKEN: "tok-123456" } } }, owner.id);
      await expect(jobs.approveAndRun(withToken.id, owner.id, {})).rejects.toThrow();
      // The token was handed to the operation and dropped; a retry would have only the placeholder.
      expect(store.getJob(withToken.id).timeout.moreTimeMs).toBeNull();
      await expect(jobs.retryWithMoreTime(withToken.id, owner.id)).rejects.toThrow("does not keep them");
    } finally { store.close(); }
  });
});

describe("a result shown once (M38: Zulip's organization link)", () => {
  const link = "https://homebox.tail1234.ts.net:8543/new/abcdefghij2345klmnopqrst";
  it("never stores the field, and gives it to the person who ran the job once", async () => {
    const helper = { request: vi.fn(async () => ({ link, expiresInDays: 7, host: "homebox.tail1234.ts.net:8543" })) };
    let now = Date.parse("2026-09-29T12:00:00.000Z");
    const { store, owner } = await setup(helper);
    try {
      const jobs = createJobService(store, helper, { now: () => now });
      const sam = store.createOwnerAccount({ username: "sam", passwordHash: "x", role: "operator", createdBy: owner.id });
      const job = await jobs.createOperationJob("app.zulip.organization.link", { id: "zulip" }, owner.id);
      const done = await jobs.approveAndRun(job.id, owner.id, {});
      expect(done.state).toBe("completed");
      expect(done.result).toEqual({ expiresInDays: 7, host: "homebox.tail1234.ts.net:8543", oneTime: ["link"] });
      // Not in the job, not in the list, not anywhere the store can hand out.
      expect(JSON.stringify(store.getJob(job.id))).not.toContain("/new/");
      expect(JSON.stringify(store.listJobs(50, {}))).not.toContain("/new/");
      expect(jobs.takeOneTime(job.id, sam.id)).toBeNull();
      expect(jobs.takeOneTime(job.id, owner.id)).toEqual({ link });
      expect(jobs.takeOneTime(job.id, owner.id)).toBeNull();

      // Unclaimed, it is gone after a quarter of an hour.
      const again = await jobs.createOperationJob("app.zulip.organization.link", { id: "zulip" }, owner.id);
      await jobs.approveAndRun(again.id, owner.id, {});
      now += 16 * 60_000;
      expect(jobs.takeOneTime(again.id, owner.id)).toBeNull();

      // And gone with the minute's sweep, whether or not anyone asks again: it used to stay in
      // memory, a live single-use link, until someone next took one.
      const unclaimed = await jobs.createOperationJob("app.zulip.organization.link", { id: "zulip" }, owner.id);
      await jobs.approveAndRun(unclaimed.id, owner.id, {});
      expect(jobs.oneTimeHeld()).toBe(1);
      now += 16 * 60_000;
      jobs.pruneStagedSecrets();
      expect(jobs.oneTimeHeld()).toBe(0);
    } finally { store.close(); }
  });
});

describe("a tier that depends on what an operation acts on", () => {
  // An app's manifest says how risky it is to deploy: the DNS servers the house depends on and the
  // VPN are high, as ADR-001 counts DNS cutovers and network-critical deploys. Staging and approval
  // ask for that tier, never less than the operation's own.
  it("stages and approves installing an app its manifest calls high risk as high", async () => {
    const helper = { request: vi.fn(async () => ({ installed: true })) };
    const { store, owner } = await setup(helper);
    try {
      const operator = store.createOwnerAccount({ username: "sam", passwordHash: "x", role: "operator", createdBy: owner.id });
      const jobs = createJobService(store, helper, { operationRiskHooks: { "app.install": async ({ id }) => (id === "pi-hole" ? "high" : "low") } });
      await expect(jobs.createOperationJob("app.install", { id: "pi-hole" }, operator.id, { role: "operator" })).rejects.toThrow(/Only the owner/);
      const job = await jobs.createOperationJob("app.install", { id: "pi-hole" }, owner.id, { role: "owner" });
      expect(job.risk).toBe("high");
      expect(jobs.describeApproval(job.id, null)).toMatchObject({ tier: "high", passwordRequired: true });
      await expect(jobs.approveAndRun(job.id, owner.id, {})).rejects.toThrow(/password/);
      expect(helper.request).not.toHaveBeenCalled();
      // A lower answer never lowers the operation's own tier.
      const other = await jobs.createOperationJob("app.install", { id: "jellyfin" }, operator.id, { role: "operator" });
      expect(other.risk).toBe("medium");
      expect(jobs.describeApproval(other.id, null)).toMatchObject({ tier: "medium", passwordRequired: false });
    } finally { store.close(); }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("requires password reauthentication before invoking the helper", async () => {
    const helper = { request: vi.fn() };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createCanary(owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "wrong password")).rejects.toThrow("reauthentication failed");
    expect(helper.request).not.toHaveBeenCalled();
    expect(store.getJob(job.id).state).toBe("awaiting_approval");
    store.close();
  });

  it("records the complete approved canary lifecycle", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createCanary(owner.id);
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(helper.request).toHaveBeenCalledWith("canary.verify", {});
    expect(completed.state).toBe("completed");
    expect(completed.steps.map((step) => step.name)).toEqual(["preflight", "checkpoint", "approval", "apply", "apply", "verify"]);
    expect(store.listAudit().map((event) => event.type)).toContain("job.completed");
    store.close();
  });

  it("fails closed when the helper is unavailable", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("Helper unavailable"); }) };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createCanary(owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("Helper unavailable");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: "Helper unavailable" });
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
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.deploy", { hostPort: 3101 });
    expect(completed).toMatchObject({ state: "completed", result: { healthy: true, hostPort: 3101 } });
    store.close();
  });
});

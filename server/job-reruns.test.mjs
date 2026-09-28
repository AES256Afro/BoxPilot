import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planInterruptedReruns, rerunRefusal } from "./job-reruns.mjs";
import { createJobService } from "./jobs.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** A store and job service on one injected clock, and a helper that answers `answer`. */
async function setup(answer = async () => ({ synced: true })) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-reruns-"));
  directories.push(directory);
  let at = Date.parse("2026-09-28T03:00:00.000Z");
  const store = createStateStore({ stateDirectory: directory, now: () => new Date(at) });
  const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "operator", passwordHash: "not-checked-here" });
  const helper = { request: vi.fn(answer) };
  const jobs = createJobService(store, helper, { now: () => at });
  return { store, owner, jobs, helper, tick: (ms) => { at += ms; } };
}

/** Stage and approve a job, then let a BoxPilot restart cut it off mid-run. */
async function interrupt(store, jobs, operationId, parameters, ownerId, options = {}) {
  const job = await jobs.createOperationJob(operationId, parameters, ownerId, options);
  store.transitionJob(job.id, "awaiting_approval", "applying");
  return job;
}

const finished = async (store, id) => vi.waitFor(() => {
  const job = store.getJob(id);
  if (!["completed", "failed", "cancelled"].includes(job.state)) throw new Error(`still ${job.state}`);
  return job;
});

describe("an interrupted job whose operation is safe to repeat (M30.2)", () => {
  it("runs again once, as its creator, through approval, and the two records name each other", async () => {
    const { store, owner, jobs, helper, tick } = await setup();
    try {
      const job = await interrupt(store, jobs, "homepage.sync", { host: "192.0.2.10" }, owner.id);
      tick(5 * 60_000); // the self-update takes a while
      const interrupted = store.recoverInterruptedJobs();
      const announce = vi.fn();
      const plan = planInterruptedReruns(interrupted, { store, jobs, announce });
      expect(plan.has(job.id)).toBe(true);

      const [rerun] = await plan.start();
      expect(rerun).toMatchObject({ type: "op:homepage.sync", createdBy: owner.id, parameters: { host: "192.0.2.10" }, recovery: { rerunOf: job.id } });
      const done = await finished(store, rerun.id);
      expect(done.state).toBe("completed");
      expect(done.approvals).toHaveLength(1);
      expect(done.steps.find((step) => step.name === "rerun").detail).toBe(`Ran again after BoxPilot restarted. The first run, job ${job.id}, was cut off.`);
      expect(helper.request).toHaveBeenCalledWith("homepage.sync", { host: "192.0.2.10" }, expect.objectContaining({ jobId: rerun.id }));

      // The first run stays as it was - failed, cut off - and points at the second.
      const original = store.getJob(job.id);
      expect(original.state).toBe("failed");
      expect(original.steps.at(-1)).toMatchObject({ name: "rerun", state: "started", detail: `Running again as job ${rerun.id}` });
      expect(announce).not.toHaveBeenCalled();
      expect(store.listAudit().some((event) => event.type === "job.rerun" && event.subjectId === rerun.id)).toBe(true);
    } finally { store.close(); }
  });

  it("is run again only once: a rerun a second restart cuts off stays failed", async () => {
    // The helper never answers, so every run is still going when the next "restart" comes.
    const { store, owner, jobs } = await setup(() => new Promise(() => {}));
    try {
      const job = await interrupt(store, jobs, "dns.names.apply", { address: "192.0.2.10" }, owner.id);
      const first = planInterruptedReruns(store.recoverInterruptedJobs(), { store, jobs });
      const [rerun] = await first.start();
      await vi.waitFor(() => expect(store.getJob(rerun.id).state).toBe("applying"));

      const again = store.recoverInterruptedJobs();
      expect(again.map((entry) => entry.id)).toEqual([rerun.id]);
      const second = planInterruptedReruns(again, { store, jobs });
      expect(second.has(rerun.id)).toBe(false);
      expect(await second.start()).toEqual([]);
      expect(store.getJob(rerun.id).steps.at(-1)).toMatchObject({ name: "rerun", state: "skipped", detail: "Not run again: it was already the second run" });
      expect(store.listJobs(50).filter((entry) => entry.type === "op:dns.names.apply")).toHaveLength(2);
      expect(store.getJob(job.id).state).toBe("failed");
    } finally { store.close(); }
  });

  it("leaves everything that changes the server as it was: failed, for the owner to check", async () => {
    const { store, owner, jobs, helper } = await setup();
    try {
      const job = await interrupt(store, jobs, "apt.upgrade", { packages: ["htop"] }, owner.id);
      const plan = planInterruptedReruns(store.recoverInterruptedJobs(), { store, jobs });
      expect(plan.has(job.id)).toBe(false);
      expect(await plan.start()).toEqual([]);
      expect(helper.request).not.toHaveBeenCalled();
      // Today's record, unchanged: no rerun step at all.
      expect(store.getJob(job.id).steps.map((step) => step.name)).not.toContain("rerun");
      expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: expect.stringContaining("check what it changed") });
    } finally { store.close(); }
  });

  it("leaves a scheduled run to its schedule and an automation's step to its automation", async () => {
    const { store, owner, jobs } = await setup();
    try {
      const scheduled = await interrupt(store, jobs, "backup.sync", {}, owner.id);
      const step = await interrupt(store, jobs, "homepage.sync", {}, owner.id);
      const flow = store.createFlow({ name: "Nightly tidy", steps: [{ operationId: "homepage.sync", parameters: {} }], createdBy: owner.id });
      store.markFlowRun(flow.id, { result: "running step 1 of 1 (Sync Homepage with installed apps)", jobIds: [step.id] });
      const plan = planInterruptedReruns(store.recoverInterruptedJobs(), { store, jobs, scheduled: new Set([scheduled.id]) });
      expect(plan.has(scheduled.id)).toBe(false);
      expect(plan.has(step.id)).toBe(false);
      expect(store.getJob(scheduled.id).steps.at(-1).detail).toBe("Not run again: its schedule runs it again at the next time");
      expect(store.getJob(step.id).steps.at(-1).detail).toBe("Not run again: it was a step of an automation, which reports what happened");
    } finally { store.close(); }
  });

  it("does not run anything again while approvals always ask for the password, or for someone who can no longer approve", async () => {
    const { store, owner, jobs } = await setup();
    try {
      const sam = store.createOwnerAccount({ username: "sam", passwordHash: "x", role: "operator", createdBy: owner.id });
      const theirs = await interrupt(store, jobs, "homepage.sync", {}, sam.id, { role: "operator" });
      store.disableOwner(sam.id, { actorId: owner.id });
      const ours = await interrupt(store, jobs, "backup.sync", {}, owner.id);
      store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
      const plan = planInterruptedReruns(store.recoverInterruptedJobs(), { store, jobs });
      expect(plan.planned).toEqual([]);
      expect(store.getJob(ours.id).steps.at(-1).detail).toBe("Not run again: approvals are set to always ask for the owner password");
      store.setSetting("approvalMode", "tiered", { updatedBy: owner.id });
      expect(rerunRefusal(store.getJob(theirs.id), { creator: store.findOwnerById(sam.id) })).toBe("the person who started it can no longer approve jobs");
    } finally { store.close(); }
  });

  it("announces a rerun that could not start, and withdraws what it staged", async () => {
    const { store, owner, jobs } = await setup();
    try {
      const job = await interrupt(store, jobs, "homepage.sync", {}, owner.id);
      const announce = vi.fn();
      const refusing = { ...jobs, approveAndStart: async () => { throw new Error("Helper unavailable: connect ENOENT"); } };
      const plan = planInterruptedReruns(store.recoverInterruptedJobs(), { store, jobs: refusing, announce });
      expect(await plan.start()).toEqual([]);
      expect(announce).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
      expect(store.getJob(job.id).steps.at(-1)).toMatchObject({ name: "rerun", state: "failed", detail: "Could not run it again: Helper unavailable: connect ENOENT" });
      const staged = store.listJobs(50).find((entry) => entry.recovery?.rerunOf === job.id);
      expect(staged.state).toBe("cancelled");
    } finally { store.close(); }
  });
});

describe("what makes a job safe to run again", () => {
  const job = (overrides = {}) => ({ type: "op:homepage.sync", parameters: {}, recovery: {}, ...overrides });
  const creator = { role: "owner" };

  it("is the registry's declaration, plus a job with nothing a restart took away", () => {
    expect(rerunRefusal(job(), { creator })).toBeNull();
    expect(rerunRefusal(job({ type: "op:app.install" }), { creator })).toMatch(/changes the server/);
    expect(rerunRefusal(job({ type: "helper.canary.verify" }), { creator })).toMatch(/not a registered operation/);
    expect(rerunRefusal(job({ recovery: { rerunOf: "a1b2" } }), { creator })).toBe("it was already the second run");
  });

  it("never includes a job staged with secrets: they lived in memory and the restart took them", () => {
    expect(rerunRefusal(job({ recovery: { approvalExpiresAt: "2026-09-28T03:30:00.000Z" } }), { creator })).toBe("the passwords it was given do not survive a restart");
    expect(rerunRefusal(job({ parameters: { host: "[secret]" } }), { creator })).toBe("the passwords it was given do not survive a restart");
  });
});

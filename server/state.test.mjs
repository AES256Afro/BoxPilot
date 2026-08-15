import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateStore } from "./state.mjs";

const directories = [];

async function testStore(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-state-"));
  directories.push(directory);
  return createStateStore({ stateDirectory: directory, ...options });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BoxPilot state store", () => {
  it("requires a fresh server-local token to bootstrap one owner", async () => {
    const store = await testStore({ tokenBytes: () => Buffer.alloc(32, 7) });
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });

    expect(owner.username).toBe("operator");
    expect(store.ownerCount()).toBe(1);
    expect(() => store.consumeBootstrapToken(bootstrap.token, { username: "again", passwordHash: "hash" })).toThrow("already exists");
    expect(store.listAudit()).toMatchObject([{ type: "owner.bootstrapped", actorId: owner.id }]);
    store.close();
  });

  it("expires bootstrap tokens without creating an owner", async () => {
    let current = new Date("2026-08-15T12:00:00Z");
    const store = await testStore({ now: () => current });
    const bootstrap = store.createBootstrapToken({ ttlMs: 1000 });
    current = new Date("2026-08-15T12:00:02Z");

    expect(() => store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" })).toThrow("invalid or expired");
    expect(store.ownerCount()).toBe(0);
    store.close();
  });

  it("stores only a digest of session tokens and enforces expiry", async () => {
    let current = new Date("2026-08-15T12:00:00Z");
    const store = await testStore({ now: () => current });
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const session = store.createSession(owner.id, { ttlMs: 1000 });

    expect(store.getSession(session.token)?.owner.username).toBe("operator");
    current = new Date("2026-08-15T12:00:02Z");
    expect(store.getSession(session.token)).toBeNull();
    expect(store.deleteExpiredSessions()).toBe(1);
    store.close();
  });

  it("persists job plans, approvals, steps, and terminal results", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const job = store.createJob({
      type: "helper.canary.verify",
      title: "Verify helper",
      createdBy: owner.id,
      recovery: { reason: "No mutation" },
    });

    expect(job.state).toBe("awaiting_approval");
    expect(job.steps).toHaveLength(2);
    store.addApproval(job.id, owner.id);
    store.transitionJob(job.id, "awaiting_approval", "applying");
    store.transitionJob(job.id, "applying", "completed", { result: { verified: true } });

    expect(store.getJob(job.id)).toMatchObject({
      state: "completed",
      result: { verified: true },
      approvals: [{ ownerId: owner.id }],
    });
    store.close();
  });

  it("fails interrupted jobs without automatically retrying them", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const job = store.createJob({ type: "helper.canary.verify", title: "Verify helper", createdBy: owner.id });
    store.transitionJob(job.id, "awaiting_approval", "applying");

    expect(store.recoverInterruptedJobs()).toBe(1);
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: expect.stringContaining("restarted") });
    store.close();
  });
});

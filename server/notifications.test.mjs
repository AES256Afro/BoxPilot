import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRequest, createNotificationService, validateTarget } from "./notifications.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function setup({ fetcher } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-notify-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
  const requests = [];
  const service = createNotificationService({
    store,
    fetcher: fetcher ?? vi.fn(async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; }),
  });
  return { store, owner, service, requests };
}

describe("failed-job notifications", () => {
  it("validates targets and builds the right request per kind", () => {
    expect(validateTarget({ kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" })).toBeNull();
    expect(validateTarget({ kind: "ntfy", url: "http://127.0.0.1:8093", topic: "bad topic!" })).toContain("topic");
    expect(validateTarget({ kind: "gotify", url: "http://127.0.0.1:8091" })).toContain("token");
    expect(validateTarget({ kind: "telegram", url: "http://x" })).toContain("kind");

    const ntfy = buildRequest({ kind: "ntfy", url: "http://127.0.0.1:8093/", topic: "boxpilot" }, { title: "T", message: "M", priority: "high" });
    expect(ntfy.url).toBe("http://127.0.0.1:8093/boxpilot");
    expect(ntfy.options.headers).toMatchObject({ Title: "T", Priority: "high" });
    const gotify = buildRequest({ kind: "gotify", url: "http://127.0.0.1:8091", token: "app-token" }, { title: "T", message: "M" });
    expect(gotify.url).toBe("http://127.0.0.1:8091/message?token=app-token");
    expect(JSON.parse(gotify.options.body)).toEqual({ title: "T", message: "M", priority: 4 });
    const hook = buildRequest({ kind: "webhook", url: "http://127.0.0.1:9000/hook", token: "t" }, { title: "T", message: "M" });
    expect(JSON.parse(hook.options.body)).toMatchObject({ source: "boxpilot", title: "T" });
    expect(hook.options.headers.Authorization).toBe("Bearer t");
  });

  it("stores the target, never exposes the token, and sends a test", async () => {
    const { store, owner, service, requests } = await setup();
    expect(service.describe()).toMatchObject({ configured: false });
    service.setTarget({ kind: "gotify", url: "http://127.0.0.1:8091", token: "secret-token" }, { updatedBy: owner.id });
    expect(service.describe()).toEqual({ configured: true, kind: "gotify", url: "http://127.0.0.1:8091", topic: null, hasToken: true });
    expect(JSON.stringify(service.describe())).not.toContain("secret-token");
    await expect(service.send({ title: "T", message: "M" })).resolves.toEqual({ sent: true, kind: "gotify" });
    expect(requests).toHaveLength(1);
    expect(() => service.setTarget({ kind: "ntfy", url: "ftp://nope", topic: "x" })).toThrow("http");
    store.close();
  });

  it("pushes once per failed job through the job-event stream and audits delivery", async () => {
    const { store, owner, service, requests } = await setup();
    service.setTarget({ kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" }, { updatedBy: owner.id });
    const stop = service.start();

    const job = store.createJob({ type: "op:app.backup", title: "Back up application data", risk: "medium", createdBy: owner.id, initialSteps: [] });
    store.transitionJob(job.id, "awaiting_approval", "applying");
    store.transitionJob(job.id, "applying", "failed", { error: "tar failed: disk full" });
    await new Promise((resolve) => setTimeout(resolve, 5)); // microtask emit + async send
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://127.0.0.1:8093/boxpilot");
    expect(requests[0].options.body).toContain("disk full");
    expect(requests[0].options.headers.Title).toContain("Back up application data failed");

    service.onJob({ ...store.getJob(job.id) }); // duplicate event: no second push
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests).toHaveLength(1);
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "notifications.sent", subjectId: job.id })]));
    stop();
    store.close();
  });

  it("leaves a job that has its own announcement to it, and still pushes when unsure", async () => {
    // A scheduled run, an automation's step, a result not saved: announced once per condition by the
    // health alerts. Pushing the job as well is what made a nightly failure a nightly push.
    const requests = [];
    const store = { getSetting: () => ({ kind: "webhook", url: "http://127.0.0.1:9000/hook" }), recordAudit: vi.fn() };
    const claimed = vi.fn((job) => {
      if (job.id === "20000000-0000-4000-8000-000000000003") throw new Error("scheduler is not there yet");
      return job.id === "20000000-0000-4000-8000-000000000001";
    });
    const service = createNotificationService({ store, claimed, fetcher: vi.fn(async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; }) });
    service.onJob({ id: "20000000-0000-4000-8000-000000000001", state: "failed", title: "Back up application data", error: "disk full" });
    service.onJob({ id: "20000000-0000-4000-8000-000000000002", state: "failed", title: "Install package updates", error: "apt lock" });
    service.onJob({ id: "20000000-0000-4000-8000-000000000003", state: "failed", title: "Refresh package lists", error: "mirror down" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests.map((request) => JSON.parse(request.options.body).title)).toEqual(["BoxPilot: Install package updates failed", "BoxPilot: Refresh package lists failed"]);
  });

  it("does not push an old failure again when a step is written to it after a restart", async () => {
    // This process has no memory of what the last one pushed. A job a restart cut off is told by
    // whoever owns it, and the rerun planner (M30.2) writes on it whether it ran again; a job that
    // ran out of time gets a step when it is retried with more time (M30.3). Neither is a new failure.
    const requests = [];
    const store = { getSetting: () => ({ kind: "webhook", url: "http://127.0.0.1:9000/hook" }), recordAudit: vi.fn() };
    const service = createNotificationService({ store, fetcher: vi.fn(async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; }) });
    const recovery = { name: "recovery", state: "required", detail: "The operation was interrupted by a BoxPilot restart" };
    service.onJob({ id: "30000000-0000-4000-8000-000000000001", state: "failed", title: "Sync Homepage with installed apps", error: "BoxPilot restarted", steps: [recovery, { name: "rerun", state: "started", detail: "Running again as job x" }] });
    service.onJob({ id: "30000000-0000-4000-8000-000000000002", state: "failed", title: "Refresh package lists", error: "BoxPilot restarted", steps: [recovery, { name: "rerun", state: "failed", detail: "Could not run it again" }] });
    service.onJob({ id: "30000000-0000-4000-8000-000000000003", state: "failed", title: "Update application", error: "did not finish", steps: [{ name: "timeout", state: "reached", detail: "x" }, { name: "retry", state: "staged", detail: "Staged again" }] });
    // The retry itself, or a rerun, failing is news: they carry their own "retry" and "rerun" steps, completed.
    service.onJob({ id: "30000000-0000-4000-8000-000000000004", state: "failed", title: "Update application", error: "pull failed", steps: [{ name: "retry", state: "completed", detail: "Trying again with more time" }] });
    service.onJob({ id: "30000000-0000-4000-8000-000000000005", state: "failed", title: "Sync Homepage with installed apps", error: "no homepage", steps: [{ name: "rerun", state: "completed", detail: "Ran again after BoxPilot restarted" }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests.map((request) => JSON.parse(request.options.body).title)).toEqual(["BoxPilot: Update application failed", "BoxPilot: Sync Homepage with installed apps failed"]);
  });

  it("audits delivery failures instead of throwing into the job path", async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 500 }));
    const { store, owner, service } = await setup({ fetcher: failing });
    service.setTarget({ kind: "webhook", url: "http://127.0.0.1:9000/hook" }, { updatedBy: owner.id });
    service.onJob({ id: "10000000-0000-4000-8000-000000000000", state: "failed", title: "Anything", error: "boom" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "notifications.failed" })]));
    store.close();
  });
});

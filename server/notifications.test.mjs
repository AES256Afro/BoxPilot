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

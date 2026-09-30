import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pushDevice } from "../test/web-push-device.mjs";
import { createNotificationHistory } from "./notification-history.mjs";
import { buildRequest } from "./notifications.mjs";
import { approvalMessage, cleanOrigin, createPushApprovals, defaultMayApprove, inQuietHours, normalizePushSettings, webPushPayload } from "./push-approvals.mjs";
import { vapidKeysFrom } from "./web-push.mjs";

/*
 * Push approvals (M25.2). What a push may carry is the first thing tested, down to the bytes the
 * device decrypts: a title and a link naming the job, and nothing the job was given. Then when a push
 * goes, to whom, how often, and by which channel - and that none of it can approve anything.
 */

const origin = "https://homebox.example.ts.net";
const start = Date.parse("2026-09-29T09:00:00");
const minute = 60_000;
const vapid = vapidKeysFrom(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
const secrets = ["hunter2-secret", "tok-SECRET-value", "/srv/private/photos", "AKIAEXAMPLESECRET", "pull failed: token tok-SECRET-value"];

/** An in-memory store with the parts the service reads: settings, the waiting jobs, the people. */
function memoryStore({ people = [{ id: "owner-1", username: "alex", role: "owner" }] } = {}) {
  const settings = new Map();
  const jobs = [];
  const audit = [];
  const listeners = new Set();
  return {
    jobs, audit, people,
    getSetting: (key, fallback) => (settings.has(key) ? structuredClone(settings.get(key)) : fallback),
    setSetting: (key, value) => { settings.set(key, structuredClone(value)); },
    listAwaitingApproval: () => jobs.filter((job) => job.state === "awaiting_approval").map((job) => structuredClone(job)),
    listOwners: () => people,
    recordAudit: (action, entry) => audit.push({ action, ...entry }),
    subscribeJobs: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    stage(overrides = {}) {
      const job = { id: randomUUID(), type: "op:app.update", title: "Update an app", state: "awaiting_approval", risk: "medium", createdBy: "owner-1", createdAt: new Date(start).toISOString(),
        parameters: { id: "jellyfin", password: secrets[0], token: secrets[1], path: secrets[2], values: { env: { AWS_KEY: secrets[3] } } },
        error: secrets[4], recovery: { reason: `Uses ${secrets[2]}` }, ...overrides };
      jobs.push(job);
      for (const listener of listeners) listener(job);
      return job;
    },
  };
}

/** The service with a stand-in network: every request it makes, and the answer each push service gives. */
function harness({ store = memoryStore(), answer = () => 201, body = () => null, target = null, settings = null, contact = null } = {}) {
  let time = start;
  const requests = [];
  const notifications = {
    getTarget: () => target,
    send: async (message) => { const { url, options } = buildRequest(target, message); requests.push({ kind: "target", url, options }); return { sent: true }; },
  };
  const fetcher = async (url, options) => { requests.push({ kind: "push", url, options }); return new Response(body(url), { status: answer(url) }); };
  const history = createNotificationHistory({ store, now: () => new Date(time) });
  const push = createPushApprovals({ store, notifications, history, loadVapid: () => vapid, fetcher, now: () => new Date(time), contact, subjectOf: (job) => (job.parameters?.id === "jellyfin" ? "Jellyfin" : null) });
  if (settings) push.saveSettings(settings, { actorId: "owner-1", origin });
  const phones = {};
  const addPhone = (accountId = "owner-1", role = "owner") => {
    const phone = pushDevice();
    const endpoint = `https://web.push.apple.com/${randomUUID()}`;
    push.subscribe({ id: accountId, role }, { subscription: { endpoint, keys: phone.keys }, origin, label: "iPhone" });
    phones[endpoint] = phone;
    return endpoint;
  };
  /** What each push said, as the device decrypts it. */
  const opened = () => requests.filter((request) => request.kind === "push").map((request) => ({ endpoint: request.url, headers: request.options.headers, payload: JSON.parse(phones[request.url].read(request.options.body)) }));
  return { store, push, requests, opened, addPhone, history, at: (offset) => { time = start + offset; }, now: () => time };
}

describe("what a push says", () => {
  it("is a title, one sentence the same for every job of its tier, and a link that names only the job", async () => {
    const test = harness();
    test.addPhone();
    const job = test.store.stage();
    test.at(3 * minute);
    await test.push.sweep();
    const [push] = test.opened();
    expect(push.payload).toEqual({
      web_push: 8030,
      notification: {
        title: "Update an app (Jellyfin): approve?",
        body: "Medium risk. Tap to review it in BoxPilot; nothing runs until you approve it there.",
        navigate: `${origin}/?approve=${job.id}`,
        tag: `approval-${job.id.replaceAll("-", "").slice(0, 23)}`,
        silent: false,
      },
    });
  });

  it("carries nothing the job was given - no password, token, path or error - to the phone or to ntfy", async () => {
    const test = harness({ target: { kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" }, settings: { ntfy: "always" } });
    test.addPhone();
    const job = test.store.stage({ type: "op:share.mount", title: "Mount a network share", parameters: { name: "nas", password: secrets[0], username: "jamie" } });
    test.store.stage();
    test.at(3 * minute);
    await test.push.sweep();
    const everything = JSON.stringify([test.opened(), test.requests.map((request) => ({ url: request.url, headers: request.options.headers, body: request.kind === "target" ? request.options.body : null }))]);
    for (const secret of [...secrets, "jamie", "nas"]) expect(everything, secret).not.toContain(secret);
    // The link names the job and nothing else; several at once link to Today.
    const [push] = test.opened();
    expect(push.payload.notification.navigate).toBe(`${origin}/?view=today`);
    const ntfy = test.requests.find((request) => request.kind === "target");
    expect(ntfy.options.headers.Click).toBe(`${origin}/?view=today`);
    expect(ntfy.options.body).toBe("Tap to review them in BoxPilot; nothing runs until you approve each one there.");
    expect(job.parameters.password).toBe(secrets[0]); // the job itself is untouched
  });

  it("builds its words from the operation's title and the catalog's app name only", () => {
    const job = { id: randomUUID(), title: "Restart a service", risk: "high", parameters: { unit: "secret-unit.service" } };
    const message = approvalMessage([job], { origin, subjectOf: () => null });
    expect(message).toMatchObject({ title: "Restart a service: approve?", body: "High risk. Tap to review it in BoxPilot; nothing runs until you approve it there.", url: `${origin}/?approve=${job.id}` });
    expect(JSON.stringify(webPushPayload(message))).not.toContain("secret-unit");
    // An id that is not a job id is never put in a link.
    expect(approvalMessage([{ ...job, id: "../../evil" }], { origin }).url).toBe(`${origin}/?view=today`);
    expect(approvalMessage([job], { origin: null }).url).toBeNull();
  });
});

describe("when a push goes", () => {
  it("waits two minutes, so approving in the dialog that staged it never pushes", async () => {
    const test = harness();
    test.addPhone();
    test.store.stage();
    test.at(90_000);
    expect((await test.push.sweep()).due).toEqual([]);
    test.store.jobs[0].state = "applying"; // approved in the dialog
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.opened()).toEqual([]);
  });

  it("pushes each job once, however many sweeps see it", async () => {
    const test = harness();
    test.addPhone();
    test.store.stage();
    for (const offset of [3, 4, 10, 30]) { test.at(offset * minute); await test.push.sweep(); }
    expect(test.opened()).toHaveLength(1);
  });

  it("says several waiting at once in one push, and two identical jobs as one", async () => {
    const test = harness();
    test.addPhone();
    test.store.stage();
    test.store.stage(); // the same update staged twice
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.opened().map((push) => push.payload.notification.title)).toEqual(["Update an app (Jellyfin): approve?"]);
    test.store.stage({ type: "op:apt.upgrade", title: "Install all updates", parameters: {}, createdAt: new Date(start + 20 * minute).toISOString() });
    test.store.stage({ type: "op:system.reboot", title: "Reboot the server", parameters: {}, risk: "high", createdAt: new Date(start + 20 * minute).toISOString() });
    test.at(23 * minute);
    await test.push.sweep();
    expect(test.opened().map((push) => push.payload.notification.title)).toEqual(["Update an app (Jellyfin): approve?", "2 approvals waiting"]);
  });

  it("keeps at least two minutes between pushes and at most ten an hour", async () => {
    const test = harness();
    test.addPhone();
    for (let index = 0; index < 14; index += 1) {
      test.store.stage({ type: `op:job.${index}`, title: `Job ${index}`, parameters: {}, createdAt: new Date(start + index * 3 * minute).toISOString() });
      test.at(index * 3 * minute + 2.5 * minute);
      const outcome = await test.push.sweep();
      if (index >= 10) expect(outcome.held).toBe("rate-limit");
    }
    expect(test.opened()).toHaveLength(10);
    // Straight after a push, the next due job waits its turn.
    const fresh = harness();
    fresh.addPhone();
    fresh.store.stage();
    fresh.at(3 * minute);
    await fresh.push.sweep();
    fresh.store.stage({ type: "op:apt.upgrade", title: "Install all updates", parameters: {}, createdAt: new Date(start + 2 * minute).toISOString() });
    fresh.at(4.1 * minute);
    expect((await fresh.push.sweep()).held).toBe("rate-limit");
    fresh.at(5.1 * minute);
    await fresh.push.sweep();
    expect(fresh.opened()).toHaveLength(2);
  });

  it("holds everything in the quiet hours, then says what still waits once, together", async () => {
    const test = harness({ settings: { quietHours: { enabled: true, start: "22:00", end: "07:00" } } });
    test.addPhone();
    const night = Date.parse("2026-09-29T23:30:00") - start;
    test.store.stage({ createdAt: new Date(start + night).toISOString() });
    test.store.stage({ type: "op:apt.upgrade", title: "Install all updates", parameters: {}, createdAt: new Date(start + night + minute).toISOString() });
    test.at(night + 10 * minute);
    expect((await test.push.sweep()).held).toBe("quiet-hours");
    expect(test.opened()).toEqual([]);
    test.at(Date.parse("2026-09-30T07:00:30") - start);
    await test.push.sweep();
    expect(test.opened().map((push) => push.payload.notification.title)).toEqual(["2 approvals waiting"]);
  });

  it("pushes only the tiers the owner chose: medium and high unless told otherwise", async () => {
    const test = harness();
    test.addPhone();
    test.store.stage({ risk: "low", type: "op:apt.refresh", title: "Refresh package lists", parameters: {} });
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.opened()).toEqual([]);
    test.push.saveSettings({ tiers: { low: true, medium: true, high: true } }, { actorId: "owner-1", origin });
    test.store.stage({ risk: "low", type: "op:apt.clean", title: "Clean the package cache", parameters: {}, createdAt: new Date(start + 3 * minute).toISOString() });
    test.at(6 * minute);
    await test.push.sweep();
    expect(test.opened().map((push) => push.payload.notification.title)).toEqual(["Clean the package cache: approve?"]);
  });

  it("never pushes a job staged more than a day ago, or one whose staged credentials have expired", async () => {
    const test = harness();
    test.addPhone();
    test.store.stage({ createdAt: new Date(start - 25 * 60 * minute).toISOString() });
    test.store.stage({ type: "op:share.mount", title: "Mount a network share", parameters: {}, recovery: { approvalExpiresAt: new Date(start + minute).toISOString() } });
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.opened()).toEqual([]);
  });
});

describe("who hears about it", () => {
  const people = [{ id: "owner-1", role: "owner" }, { id: "op-1", role: "operator" }, { id: "viewer-1", role: "viewer" }];

  it("tells the owner about every job, and an operator about the ones they staged and may approve", () => {
    const store = { listOwners: () => people };
    expect(defaultMayApprove(store, { createdBy: "op-1", risk: "medium" })).toEqual(["owner-1", "op-1"]);
    expect(defaultMayApprove(store, { createdBy: "op-1", risk: "high" })).toEqual(["owner-1"]);
    expect(defaultMayApprove(store, { createdBy: "op-1", risk: "medium" }, { minimumRole: "owner" })).toEqual(["owner-1"]);
    expect(defaultMayApprove(store, { createdBy: "viewer-1", risk: "low" })).toEqual(["owner-1"]);
    expect(defaultMayApprove(store, { createdBy: "owner-1", risk: "low" })).toEqual(["owner-1"]);
  });

  it("sends each account only its own jobs", async () => {
    const test = harness({ store: memoryStore({ people }) });
    const ownerPhone = test.addPhone("owner-1", "owner");
    const operatorPhone = test.addPhone("op-1", "operator");
    test.store.stage({ createdBy: "owner-1" });
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.opened().map((push) => push.endpoint)).toEqual([ownerPhone]);
    test.store.stage({ type: "op:apt.upgrade", title: "Install all updates", parameters: {}, createdBy: "op-1", createdAt: new Date(start + 3 * minute).toISOString() });
    test.at(6 * minute);
    await test.push.sweep();
    expect(test.opened().slice(1).map((push) => push.endpoint).sort()).toEqual([ownerPhone, operatorPhone].sort());
  });

  it("lets only someone who can approve turn pushes on, from BoxPilot's HTTPS address, to a real push service", () => {
    const test = harness();
    const keys = pushDevice().keys;
    expect(() => test.push.subscribe({ id: "viewer-1", role: "viewer" }, { subscription: { endpoint: "https://web.push.apple.com/x", keys }, origin })).toThrow(/approve/);
    expect(() => test.push.subscribe({ id: "owner-1", role: "owner" }, { subscription: { endpoint: "https://web.push.apple.com/x", keys }, origin: "http://192.168.1.10:8787" })).toThrow(/HTTPS/);
    expect(() => test.push.subscribe({ id: "owner-1", role: "owner" }, { subscription: { endpoint: "http://192.168.1.10/hook", keys }, origin })).toThrow();
    // Nobody removes another account's device.
    const device = test.push.subscribe({ id: "owner-1", role: "owner" }, { subscription: { endpoint: "https://web.push.apple.com/x", keys }, origin, label: "iPad <script>" });
    expect(device.label).toBe("iPad script");
    expect(() => test.push.unsubscribe({ id: "op-1", role: "operator" }, device.id)).toThrow(/no such device/);
    expect(test.push.unsubscribe({ id: "owner-1", role: "owner" }, device.id)).toEqual({ removed: true });
  });
});

describe("which channel", () => {
  const ntfy = { kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" };

  it("uses ntfy when no phone of the owner's took the push, with the approval as its click", async () => {
    const test = harness({ target: ntfy, settings: {} });
    const job = test.store.stage();
    test.at(3 * minute);
    const outcome = await test.push.sweep();
    expect(outcome.target).toBe("sent");
    const [sent] = test.requests;
    expect(sent.url).toBe("http://127.0.0.1:8093/boxpilot");
    expect(sent.options.headers).toMatchObject({ Title: "BoxPilot: Update an app (Jellyfin): approve?", Click: `${origin}/?approve=${job.id}` });
  });

  it("does not use ntfy as well when a phone took it, unless told to always", async () => {
    const test = harness({ target: ntfy, settings: {} });
    test.addPhone();
    test.store.stage();
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.requests.map((request) => request.kind)).toEqual(["push"]);
    const always = harness({ target: ntfy, settings: { ntfy: "always" } });
    always.addPhone();
    always.store.stage();
    always.at(3 * minute);
    await always.push.sweep();
    expect(always.requests.map((request) => request.kind).sort()).toEqual(["push", "target"]);
  });

  it("falls back to ntfy when the phone's push service refuses, and forgets a phone that is gone", async () => {
    const test = harness({ target: ntfy, settings: {}, answer: () => 410 });
    test.addPhone();
    test.store.stage();
    test.at(3 * minute);
    const outcome = await test.push.sweep();
    expect(outcome.target).toBe("sent");
    expect(test.push.devicesOf("owner-1")).toEqual([]);
  });

  it("signs as BoxPilot's own address, or the contact it is given, and says so when Apple refuses it", async () => {
    const claimsOf = (request) => JSON.parse(Buffer.from(/t=[^.]+\.([^.]+)\./.exec(request.options.headers.Authorization)[1], "base64url"));
    const own = harness();
    own.addPhone();
    own.store.stage();
    own.at(3 * minute);
    await own.push.sweep();
    expect(claimsOf(own.requests[0])).toMatchObject({ aud: "https://web.push.apple.com", sub: origin });

    const refused = harness({ contact: "mailto:owner@example.com", answer: () => 403, body: () => JSON.stringify({ reason: "BadJwtToken" }) });
    refused.addPhone();
    refused.store.stage();
    refused.at(3 * minute);
    await refused.push.sweep();
    expect(claimsOf(refused.requests[0]).sub).toBe("mailto:owner@example.com");
    const [device] = refused.push.devicesOf("owner-1");
    expect(device.lastError).toContain("refused the contact mailto:owner@example.com");
    expect(device.lastError).toContain("BOXPILOT_PUSH_CONTACT");
  });

  it("uses no channel at all with ntfy turned off and no phone, and records that nothing arrived", async () => {
    const test = harness({ target: ntfy, settings: { ntfy: "never" } });
    test.store.stage();
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.requests).toEqual([]);
    expect(test.history.list()[0]).toMatchObject({ kind: "approval", title: "Update an app (Jellyfin): approve?", delivered: false });
  });

  it("keeps a record in the notification centre of what was pushed", async () => {
    const test = harness();
    test.addPhone();
    const job = test.store.stage();
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.history.list()[0]).toMatchObject({ kind: "approval", key: `approval.waiting:${job.id}`, delivered: true });
    expect(JSON.stringify(test.history.list())).not.toContain(secrets[0]);
  });
});

describe("the owner's choices", () => {
  it("are checked, with defaults for what is left out", () => {
    expect(normalizePushSettings({})).toEqual({ tiers: { low: false, medium: true, high: true }, quietHours: { enabled: false, start: "22:00", end: "07:00" }, ntfy: "fallback" });
    expect(() => normalizePushSettings({ tiers: { high: "yes" } })).toThrow(/true or false/);
    expect(() => normalizePushSettings({ quietHours: { enabled: true, start: "25:00", end: "07:00" } })).toThrow(/times of day/);
    expect(() => normalizePushSettings({ ntfy: "sometimes" })).toThrow(/ntfy/);
  });

  it("say quiet hours across midnight or within a day", () => {
    const night = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(night, new Date("2026-09-29T23:00:00"))).toBe(true);
    expect(inQuietHours(night, new Date("2026-09-29T06:59:00"))).toBe(true);
    expect(inQuietHours(night, new Date("2026-09-29T07:00:00"))).toBe(false);
    expect(inQuietHours({ enabled: true, start: "13:00", end: "14:00" }, new Date("2026-09-29T13:30:00"))).toBe(true);
    expect(inQuietHours({ ...night, enabled: false }, new Date("2026-09-29T23:00:00"))).toBe(false);
  });

  it("take the address pushes link to only as a bare HTTPS origin", () => {
    expect(cleanOrigin("https://homebox.example.ts.net")).toBe(origin);
    expect(cleanOrigin("http://homebox.local")).toBeNull();
    expect(cleanOrigin("https://homebox.example.ts.net/evil?x=1")).toBeNull();
    expect(cleanOrigin("https://user:pw@homebox.example.ts.net")).toBeNull();
    expect(cleanOrigin(null)).toBeNull();
  });
});

describe("a push never approves anything", () => {
  it("has no way to: the service can only read the waiting jobs and send", async () => {
    const test = harness();
    test.addPhone();
    test.store.stage();
    test.at(3 * minute);
    await test.push.sweep();
    expect(test.store.jobs.every((job) => job.state === "awaiting_approval")).toBe(true);
    expect(Object.keys(test.push).sort()).toEqual(["describeSettings", "devicesOf", "publicKey", "saveSettings", "start", "subscribe", "sweep", "test", "unsubscribe"]);
    expect(test.store.audit.map((entry) => entry.action)).not.toContain("job.approved");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { attemptsIn, autoReconnectLimits, createAutoReconnect, lostDrives, reconnectedNotice, reconnectRefusal } from "./auto-reconnect.mjs";
import { createFlowService } from "./flows.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";
import { createStateStore } from "./state.mjs";

/**
 * M26.5: a drive somebody armed is reconnected when BoxPilot finds it dead or read-only, through its
 * own flow, and never in a loop. These run the real flow service and the real health-alert ledger
 * (so "told once" is the ledger's own promise, not a counter in a fake), with a fake job layer whose
 * remount succeeds or fails on cue, and a clock the test moves.
 */
function fakeStore({ settings = {} } = {}) {
  const flows = new Map();
  const jobs = new Map();
  const audits = [];
  const values = new Map(Object.entries(settings));
  let active = [];
  return {
    flows, jobs, audits, values,
    setActiveJobs(list) { active = list; },
    createFlow(input) {
      const flow = { id: `flow-${flows.size + 1}`, name: input.name, steps: input.steps, createdBy: input.createdBy, lastRunAt: null, lastResult: null, lastJobIds: [], frequency: input.frequency ?? null, minute: null, hour: null, weekday: null, enabled: true, nextDueAt: null, triggerFlowId: input.triggerFlowId ?? null, triggerDrive: input.triggerDrive ?? null };
      flows.set(flow.id, flow);
      return flow;
    },
    getFlow: (id) => flows.get(id) ?? null,
    listFlows: () => [...flows.values()],
    updateFlow(id, changes) { const flow = flows.get(id); for (const [key, value] of Object.entries(changes)) if (value !== undefined) flow[key] = value; return flow; },
    markFlowRun(id, { result, jobIds }) { Object.assign(flows.get(id), { lastResult: result, lastJobIds: jobIds, lastRunAt: "now" }); },
    deleteFlow(id) { if (!flows.delete(id)) throw new Error("Flow not found"); },
    listFlowsTriggeredBy: () => [],
    getJob: (id) => jobs.get(id) ?? null,
    listActiveJobs: () => active,
    getSetting: (key, fallback = null) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    setSetting: (key, value) => { values.set(key, structuredClone(value)); return value; },
    findOwnerById: (id) => (id ? { id, username: id, role: id.startsWith("viewer") ? "viewer" : id.startsWith("operator") ? "operator" : "owner" } : null),
    recordAudit: (event, detail) => audits.push({ event, ...detail }),
    subscribeJobs: () => () => {},
  };
}

/** What storage.remount returns when it worked: mounted again from the drive's new name, three apps restarted. */
const reconnected = (overrides = {}) => ({ remounted: true, name: "media", mountpoint: "/mnt/media", source: "/dev/sdb2", previousSource: "/dev/sda2", deviceChanged: true, restarted: ["bp-plex", "bp-sonarr", "bp-radarr"], restartFailed: [], ...overrides });
const unplugged = { state: "failed", error: "Could not mount /mnt/media again: special device UUID=1234-ABCD does not exist. The drive may be unplugged; check it is connected and try again." };

/** The job layer: every call is recorded, and each job ends as `outcomes` says (the last one repeats). */
function fakeJobs(store, outcomes = [{ state: "completed", result: reconnected() }]) {
  let counter = 0;
  return {
    calls: [],
    async createOperationJob(operationId, parameters, actorId, { role }) {
      counter += 1;
      const job = { id: `job-${counter}`, type: `op:${operationId}`, parameters, createdBy: actorId, state: "awaiting_approval", result: null, error: null };
      store.jobs.set(job.id, job);
      this.calls.push({ operationId, parameters, actorId, role });
      return job;
    },
    async approveAndStart(jobId) {
      const job = store.jobs.get(jobId);
      job.state = "applying";
      const outcome = outcomes[this.calls.length - 1] ?? outcomes.at(-1);
      setTimeout(() => Object.assign(job, outcome), 3);
    },
    cancelJob: vi.fn(),
  };
}

const lost = (family = "detached", target = "/mnt/media") => ({ active: [`storage.mount.${family}:${target}`] });

function setup({ settings = {}, outcomes, target = true, inventory = { inspect: async () => ({}) } } = {}) {
  let clock = new Date("2026-09-28T03:00:00Z");
  const now = () => clock;
  const store = fakeStore({ settings });
  const jobs = fakeJobs(store, outcomes);
  const send = vi.fn(async () => {});
  const notifications = { getTarget: () => (target ? { kind: "ntfy" } : null), send };
  const alerts = createHealthAlerts({ inventory, notifications, store, now });
  const flows = createFlowService({ store, jobs, alerts, pollMs: 2, now });
  const service = createAutoReconnect({ store, flows, alerts, now });
  return {
    store, jobs, alerts, flows, service,
    later: (minutes) => { clock = new Date(clock.getTime() + minutes * 60_000); },
    titles: () => send.mock.calls.map(([payload]) => payload.title),
    pushes: () => send.mock.calls.map(([payload]) => payload),
  };
}

describe("which drives a health round found in trouble", () => {
  it("reads managed drives from the dead-mount and read-only conditions and nothing else", () => {
    const found = lostDrives([
      "storage.mount.detached:/mnt/media",
      "storage.mount.readonly:/mnt/backup",
      "storage.mount.full:/mnt/photos",          // full is not lost
      "storage.mount.detached:/srv/data",         // not a drive BoxPilot mounts
      "storage.mount.detached:/mnt/media/deeper", // not a mount point of its own
      "storage.mount.readonly:/mnt/share-nas",    // a network share has its own operations
      "flow.failed:flow-1",
    ]);
    expect([...found.keys()]).toEqual(["media", "backup"]);
    expect(found.get("media")).toEqual({ key: "storage.mount.detached:/mnt/media", what: "lost its drive" });
    expect(found.get("backup").what).toBe("went read-only");
  });
});

describe("the guardrails, decided without a clock of their own", () => {
  const now = Date.parse("2026-09-28T03:00:00Z");
  const ago = (minutes, outcome = "reconnected") => ({ at: new Date(now - minutes * 60_000).toISOString(), outcome });

  it("lets a drive with a clean slate be reconnected", () => {
    expect(reconnectRefusal({ name: "media", now })).toBeNull();
  });

  it("waits, without telling anyone, while the drive is checked or worked on", () => {
    expect(reconnectRefusal({ name: "media", now, activeJobs: [{ type: "op:storage.check", parameters: { name: "media" } }] })).toMatchObject({ reason: "/mnt/media is being checked", tell: false });
    expect(reconnectRefusal({ name: "media", now, activeJobs: [{ type: "op:storage.remount", parameters: { name: "media" } }] })).toMatchObject({ tell: false });
    // Another drive's check is none of this drive's business.
    expect(reconnectRefusal({ name: "media", now, activeJobs: [{ type: "op:storage.check", parameters: { name: "backup" } }] })).toBeNull();
  });

  it("leaves a drive whose last check found errors to a person, and says so", () => {
    expect(reconnectRefusal({ name: "media", now, lastCheck: { clean: false, checkedAt: "2026-09-27T20:00:00Z" } })).toMatchObject({ tell: true, reason: expect.stringMatching(/^its last check found errors/) });
    expect(reconnectRefusal({ name: "media", now, lastCheck: { clean: true, checkedAt: "2026-09-27T20:00:00Z" } })).toBeNull();
  });

  it("holds after a failure, cools down between reconnects, and caps them per window", () => {
    expect(reconnectRefusal({ name: "media", now, record: { heldSince: "2026-09-28T02:00:00Z", heldBecause: "the last automatic reconnect did not work" } })).toMatchObject({ tell: false });
    expect(reconnectRefusal({ name: "media", now, record: { attempts: [ago(29)] } })).toMatchObject({ tell: false, reason: expect.stringMatching(/under 30 minutes ago/) });
    expect(reconnectRefusal({ name: "media", now, record: { attempts: [ago(31)] } })).toBeNull();
    expect(reconnectRefusal({ name: "media", now, record: { attempts: [ago(300), ago(200), ago(100)] } })).toMatchObject({ tell: true, reason: expect.stringMatching(/3 times in the last 24 hours/) });
    // The oldest falls out of the window, and the drive may be reconnected again.
    expect(reconnectRefusal({ name: "media", now, record: { attempts: [ago(24 * 60 + 1), ago(200), ago(100)] } })).toBeNull();
    expect(attemptsIn({ attempts: [ago(24 * 60 + 1), ago(5)] }, now)).toHaveLength(1);
  });
});

describe("what the owner is told when it worked", () => {
  it("says which drive, from where, and which apps it restarted", () => {
    expect(reconnectedNotice({ name: "media", what: "lost its drive", result: reconnected() })).toEqual({
      title: "Reconnected /mnt/media and restarted 3 apps",
      message: "It lost its drive. It is mounted again from /dev/sdb2 and reads. plex, sonarr and radarr were restarted so they see it. Automatic reconnect 1 of 3 allowed in a day.",
      priority: "default",
    });
    expect(reconnectedNotice({ name: "media", what: "went read-only", result: reconnected({ restarted: ["bp-plex"] }), attempt: 2 }).message).toBe("It went read-only. It is mounted again from /dev/sdb2 and reads. plex was restarted so it sees it. Automatic reconnect 2 of 3 allowed in a day.");
    expect(reconnectedNotice({ name: "media", what: "lost its drive", result: reconnected({ restarted: [] }) }).title).toBe("Reconnected /mnt/media");
  });

  it("does not bury an app that would not restart", () => {
    const notice = reconnectedNotice({ name: "media", what: "lost its drive", result: reconnected({ restarted: ["bp-plex"], restartFailed: ["bp-sonarr"] }) });
    expect(notice.title).toBe("Reconnected /mnt/media; 1 app did not restart");
    expect(notice.message).toContain("Could not restart sonarr; restart it from the App catalog.");
    expect(notice.priority).toBe("high");
  });
});

describe("auto-reconnect", () => {
  it("is off by default: a drive nobody armed is left for a person", async () => {
    const { service, jobs, titles } = setup();
    expect(await service.onRound(lost())).toEqual([]);
    expect(jobs.calls).toEqual([]);
    expect(titles()).toEqual([]);
    expect(service.status().drives).toEqual({});
  });

  it("reconnects an armed drive that lost its drive, as an ordinary job under the armer's authority, and says what it did", async () => {
    const { service, flows, jobs, store, pushes } = setup();
    const flow = await service.arm("media", "owner-1");
    expect(flow).toMatchObject({ name: "Reconnect /mnt/media when it drops", triggerDrive: "media", steps: [{ operationId: "storage.remount", parameters: { name: "media" } }] });

    const [outcome] = await service.onRound(lost());
    expect(outcome.outcome).toBe("reconnected");
    // Nothing about the finding reaches the step: the drive name is the one written when arming.
    expect(jobs.calls).toEqual([{ operationId: "storage.remount", parameters: { name: "media" }, actorId: "owner-1", role: "owner" }]);
    expect(flows.owns("job-1")).toBe(true);     // the flow's job: no separate failed-job push path
    expect(store.getFlow(flow.id).lastResult).toBe("completed");
    expect(store.audits.find((entry) => entry.event === "drive.reconnect.triggered")).toMatchObject({ actorId: "owner-1", subjectId: flow.id, details: { drive: "media", condition: "storage.mount.detached:/mnt/media" } });
    expect(pushes()).toEqual([{ title: "BoxPilot: Reconnected /mnt/media and restarted 3 apps", message: "It lost its drive. It is mounted again from /dev/sdb2 and reads. plex, sonarr and radarr were restarted so they see it. Automatic reconnect 1 of 3 allowed in a day.", priority: "default" }]);
    expect(service.status().drives.media).toMatchObject({ enabled: true, held: false, attempts: 1, lastOutcome: "reconnected" });
  });

  it("keeps what an armed drive runs fixed: it can be renamed or paused, and anything else means arming it again", async () => {
    const { service, flows } = setup();
    const flow = await service.arm("media", "owner-1");
    await expect(flows.update(flow.id, { steps: [{ operationId: "storage.remount", parameters: { name: "backup" } }] }, "owner-1")).rejects.toThrow("arm the drive again");
    await expect(flows.update(flow.id, { cadence: { frequency: "daily", hour: 3, minute: 0 } }, "owner-1")).rejects.toThrow("arm the drive again");
    await expect(flows.update(flow.id, { triggerFlowId: "flow-9" }, "owner-1")).rejects.toThrow("arm the drive again");
    expect(await flows.update(flow.id, { name: "Media drive", steps: flow.steps }, "owner-1")).toMatchObject({ name: "Media drive", steps: flow.steps, triggerDrive: "media" });
    expect(await flows.update(flow.id, { enabled: false }, "owner-1")).toMatchObject({ enabled: false, triggerDrive: "media" });
  });

  it("reconnects a drive that went read-only the same way", async () => {
    const { service, jobs, titles } = setup();
    await service.arm("media", "owner-1");
    await service.onRound(lost("readonly"));
    expect(jobs.calls).toHaveLength(1);
    expect(titles()).toEqual(["BoxPilot: Reconnected /mnt/media and restarted 3 apps"]);
  });

  it("waits out a cooldown between two reconnects of one drive", async () => {
    const { service, jobs, titles, later } = setup();
    await service.arm("media", "owner-1");
    await service.onRound(lost());
    later(15);   // the next health round: the drive dropped again already
    expect(await service.onRound(lost())).toEqual([{ name: "media", outcome: "waiting", reason: "the last automatic reconnect was under 30 minutes ago", told: false }]);
    expect(jobs.calls).toHaveLength(1);
    later(16);
    await service.onRound(lost());
    expect(jobs.calls).toHaveLength(2);
    expect(titles()).toEqual(["BoxPilot: Reconnected /mnt/media and restarted 3 apps", "BoxPilot: Reconnected /mnt/media and restarted 3 apps"]);
  });

  it("stops at three a day, tells the owner once, and starts again when the oldest falls out of the day", async () => {
    const { service, jobs, store, titles, later } = setup();
    const flow = await service.arm("media", "owner-1");
    for (let round = 0; round < 3; round += 1) { await service.onRound(lost()); later(31); }
    expect(jobs.calls).toHaveLength(3);
    await service.onRound(lost());
    later(31);
    await service.onRound(lost());   // still dropped, still capped: no second push
    expect(jobs.calls).toHaveLength(3);
    expect(titles().filter((title) => title === "BoxPilot: Did not reconnect /mnt/media")).toHaveLength(1);
    expect(store.getFlow(flow.id).lastResult).toBe("skipped: it has been reconnected automatically 3 times in the last 24 hours, which is the limit");
    expect(store.audits.filter((entry) => entry.event === "flow.skipped")).toHaveLength(1);
    expect(store.getSetting("healthAlertsState", {})[`flow.failed:${flow.id}`]).toMatchObject({ title: "Did not reconnect /mnt/media", notified: true });

    later(24 * 60 - 3 * 31);   // the first reconnect is now more than a day old
    await service.onRound(lost());
    expect(jobs.calls).toHaveLength(4);
    // The automation ran cleanly again, so its standing "did not reconnect" is resolved.
    expect(titles()).toContain("BoxPilot: resolved. Did not reconnect /mnt/media");
  });

  it("stops after a reconnect that failed, tells the owner once, and waits until it is reconnected by hand", async () => {
    const { service, jobs, store, titles, pushes, later } = setup({ outcomes: [unplugged, { state: "completed", result: reconnected() }] });
    const flow = await service.arm("media", "owner-1");
    const [outcome] = await service.onRound(lost());
    expect(outcome).toMatchObject({ outcome: "failed", told: true });
    // One push, in the drive's words, and not the generic "Automation stopped" as well.
    expect(pushes()).toEqual([{ title: "BoxPilot: Could not reconnect /mnt/media", message: "It lost its drive, and reconnecting it automatically failed: Could not mount /mnt/media again: special device UUID=1234-ABCD does not exist. The drive may be unplugged; check it is connected and try again. BoxPilot will not try again on its own until it has been reconnected by hand, from Repair.", priority: "high" }]);
    expect(service.status().drives.media).toMatchObject({ held: true, heldBecause: "the last automatic reconnect did not work", lastOutcome: "failed" });

    later(120);   // long past the cooldown: still held, still quiet
    expect(await service.onRound(lost())).toEqual([{ name: "media", outcome: "waiting", reason: "the last automatic reconnect did not work", told: false }]);
    expect(jobs.calls).toHaveLength(1);
    expect(titles()).toHaveLength(1);

    // The owner reconnects it from Repair: an ordinary job this service did not start.
    service.onJob({ id: "job-by-hand", type: "op:storage.remount", state: "completed", parameters: { name: "media" } });
    expect(service.status().drives.media.held).toBe(false);
    await vi.waitFor(() => expect(titles()).toContain("BoxPilot: resolved. Could not reconnect /mnt/media"));
    expect(store.getSetting("healthAlertsState", {})[`flow.failed:${flow.id}`]).toBeUndefined();

    later(60);    // it drops again another day: armed as before
    await service.onRound(lost());
    expect(jobs.calls).toHaveLength(2);
  });

  it("never runs while that drive is being checked", async () => {
    const { service, store, jobs, titles } = setup();
    await service.arm("media", "owner-1");
    store.setActiveJobs([{ id: "check-1", type: "op:storage.check", state: "applying", parameters: { name: "media" } }]);
    expect(await service.onRound(lost())).toEqual([{ name: "media", outcome: "waiting", reason: "/mnt/media is being checked", told: false }]);
    expect(jobs.calls).toEqual([]);
    expect(titles()).toEqual([]);
    expect(service.status().drives.media.attempts).toBe(0);

    store.setActiveJobs([{ id: "check-2", type: "op:storage.check", state: "applying", parameters: { name: "backup" } }]);
    await service.onRound(lost());
    expect(jobs.calls).toHaveLength(1);
  });

  it("never reconnects a drive whose last check found errors, and tells the owner once", async () => {
    const { service, store, jobs, titles, later } = setup({ settings: { driveChecks: { media: { checkedAt: "2026-09-27T20:00:00Z", clean: false, checker: "fsck.exfat", summary: "corrupted directory entry" } } } });
    const flow = await service.arm("media", "owner-1");
    const [outcome] = await service.onRound(lost("readonly"));
    expect(outcome).toMatchObject({ outcome: "waiting", told: true });
    later(60);
    await service.onRound(lost("readonly"));
    expect(jobs.calls).toEqual([]);
    expect(titles()).toEqual(["BoxPilot: Did not reconnect /mnt/media"]);
    expect(store.getSetting("healthAlertsState", {})[`flow.failed:${flow.id}`]).toMatchObject({ title: "Did not reconnect /mnt/media", notified: true });
    expect(store.getFlow(flow.id).lastResult).toMatch(/^skipped: its last check found errors/);
    expect(service.status().drives.media.lastCheckFoundErrors).toBe(true);

    // A person repaired it and it checked clean: reconnecting is automatic again.
    store.setSetting("driveChecks", { media: { checkedAt: "2026-09-28T03:30:00Z", clean: true, checker: "fsck.exfat", summary: "clean" } });
    later(60);
    await service.onRound(lost("readonly"));
    expect(jobs.calls).toHaveLength(1);
  });

  it("keeps the scheduler's consent rules: always-ask approvals and a creator who lost the role both stop it, and no attempt is counted", async () => {
    const { service, store, jobs, titles, pushes } = setup({ settings: { approvalMode: "always-password" } });
    const flow = await service.arm("media", "owner-1");
    const [outcome] = await service.onRound(lost());
    expect(outcome).toMatchObject({ outcome: "refused", told: true });
    expect(jobs.calls).toEqual([]);
    expect(titles()).toEqual(["BoxPilot: Did not reconnect /mnt/media"]);
    expect(pushes()[0].message).toMatch(/always ask/);
    expect(store.getFlow(flow.id).lastResult).toMatch(/^skipped: Approval mode is set to always ask/);
    expect(service.status().drives.media.attempts).toBe(0);

    const demoted = setup();
    await demoted.service.arm("media", "viewer-1", { role: "operator" });   // armed while an operator, since demoted
    await demoted.service.onRound(lost());
    expect(demoted.jobs.calls).toEqual([]);
    expect(demoted.pushes()[0].message).toContain("viewer-1 can no longer approve jobs");
  });

  it("does nothing for a drive whose automation is paused", async () => {
    const { service, store, jobs } = setup();
    const flow = await service.arm("media", "owner-1");
    store.updateFlow(flow.id, { enabled: false });
    expect(await service.onRound(lost())).toEqual([]);
    expect(jobs.calls).toEqual([]);
    expect(service.status().drives.media.enabled).toBe(false);
  });

  it("holds a drive whose reconnect a BoxPilot restart cut off", async () => {
    const { service, store, jobs, later } = setup();
    await service.arm("media", "owner-1");
    store.setSetting("driveReconnects", { media: { attempts: [{ at: "2026-09-28T02:40:00Z", outcome: "running" }] } });
    expect(service.recover()).toBe(1);
    expect(service.status().drives.media).toMatchObject({ held: true, heldBecause: "BoxPilot restarted while it was reconnecting the drive", attempts: 1, lastOutcome: "interrupted" });
    later(60);
    await service.onRound(lost());
    expect(jobs.calls).toEqual([]);
  });

  it("arms one automation per drive, only for drives it mounts, and never for a viewer", async () => {
    const { service, store } = setup();
    await service.arm("media", "owner-1");
    await expect(service.arm("media", "owner-1")).rejects.toThrow("Reconnect /mnt/media when it drops already runs when /mnt/media drops");
    for (const name of ["share-nas", "swap", "../etc", "Media"]) await expect(service.arm(name, "owner-1")).rejects.toThrow(/under \/mnt/);
    await expect(service.arm("backup", "viewer-1", { role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    expect(service.status()).toEqual({
      limits: { cooldownMinutes: 30, maxAttempts: 3, windowHours: 24 },
      drives: { media: { flowId: "flow-1", flowName: "Reconnect /mnt/media when it drops", enabled: true, held: false, heldSince: null, heldBecause: null, attempts: 0, lastAttemptAt: null, lastOutcome: null, lastCheckFoundErrors: false } },
    });

    // Only its creator or an owner may disarm it; disarming removes the automation, and its record.
    expect(() => service.disarm("media", "operator-2", { role: "operator" })).toThrow(/creator or an owner/);
    store.setSetting("driveReconnects", { media: { attempts: [{ at: "2026-09-28T02:40:00Z", outcome: "failed" }], heldSince: "2026-09-28T02:40:00Z", heldBecause: "the last automatic reconnect did not work" } });
    expect(service.disarm("media", "owner-1")).toMatchObject({ removed: true });
    expect(store.listFlows()).toEqual([]);
    expect(store.getSetting("driveReconnects", {})).toEqual({});
    let notArmed = null;
    try { service.disarm("media", "owner-1"); } catch (error) { notArmed = error; }
    expect(notArmed?.code).toBe("not_found");
  });

  it("acts on what a real health round found, and the reconnect stands in for the drop's 'resolved'", async () => {
    let snapshot = {
      storage: {
        root: { usedPercent: 30 },
        filesystems: { available: true, mounts: [
          { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", usedPercent: 30, capacityState: "healthy" },
          { target: "/mnt/media", source: "/dev/sda2", usedPercent: 40, capacityState: "healthy" },
        ] },
        blockDevices: { available: true, devices: [{ name: "/dev/sdb" }, { name: "/dev/sdb2" }, { name: "/dev/mapper/ubuntu--vg-ubuntu--lv" }] },
      },
    };
    const { service, alerts, jobs, store, titles } = setup({ inventory: { inspect: async () => snapshot } });
    const stop = service.start();
    await service.arm("media", "owner-1");
    await alerts.check();
    await vi.waitFor(() => expect(titles()).toContain("BoxPilot: Reconnected /mnt/media and restarted 3 apps"));
    expect(titles()[0]).toBe("BoxPilot: /mnt/media lost its drive");
    expect(jobs.calls).toHaveLength(1);
    expect(store.getSetting("healthAlertsState", {})["storage.mount.detached:/mnt/media"]).toBeUndefined();

    // The next round finds it mounted from its new name: nothing more to say.
    snapshot = structuredClone(snapshot);
    snapshot.storage.filesystems.mounts[1].source = "/dev/sdb2";
    await alerts.check();
    expect(titles()).toEqual(["BoxPilot: /mnt/media lost its drive", "BoxPilot: Reconnected /mnt/media and restarted 3 apps"]);
    stop();
  });

  it("leaves a real health round alone when nothing is armed", async () => {
    const snapshot = { storage: { filesystems: { available: true, mounts: [{ target: "/mnt/media", source: "/dev/sda2", capacityState: "healthy" }] }, blockDevices: { available: true, devices: [{ name: "/dev/sdb2" }] } } };
    const { service, alerts, jobs, titles } = setup({ inventory: { inspect: async () => snapshot } });
    const stop = service.start();
    await alerts.check();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(jobs.calls).toEqual([]);
    expect(titles()).toEqual(["BoxPilot: /mnt/media lost its drive"]);
    stop();
  });

  it("uses the limits the roadmap states: 30 minutes apart, 3 a day", () => {
    expect(autoReconnectLimits).toEqual({ cooldownMs: 30 * 60_000, maxAttempts: 3, windowMs: 24 * 60 * 60_000 });
  });
});

describe("the drive a flow is armed for, in the real database", () => {
  it("is stored with the flow and read back", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-reconnect-"));
    const store = createStateStore({ stateDirectory: directory });
    try {
      const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "owner", passwordHash: "not-checked-here" });
      const flow = store.createFlow({ name: "Reconnect /mnt/media when it drops", steps: [{ operationId: "storage.remount", parameters: { name: "media" } }], createdBy: owner.id, triggerDrive: "media" });
      const plain = store.createFlow({ name: "Nightly", steps: [{ operationId: "controller.backup.create", parameters: {} }], createdBy: owner.id });
      expect(store.getFlow(flow.id).triggerDrive).toBe("media");
      expect(store.getFlow(plain.id).triggerDrive).toBeNull();
      expect(store.listFlows().map((entry) => entry.triggerDrive)).toEqual(["media", null]);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

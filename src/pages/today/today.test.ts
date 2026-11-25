import { describe, expect, it } from "vitest";
import type { Job } from "../../operations";
import type { Need } from "../../home/needs";
import { offlineCopy, overnightWindow, ranKind, todayVerdict, whatRan, type TodayModel } from "./today";

const at = (text: string) => new Date(text).getTime();
const job = (id: string, type: string, state: string, updatedAt: string, extra: Partial<Job> = {}): Job => ({
  id, type, title: type.replace(/^op:/, ""), state, risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: updatedAt, updatedAt, ...extra,
} as Job);

describe("overnight", () => {
  it("runs from 18:00 yesterday until the evening, then from 06:00 today", () => {
    const morning = at("2026-09-29T07:30:00");
    expect(overnightWindow(morning)).toEqual({ since: at("2026-09-28T18:00:00"), label: "since 18:00 yesterday" });
    expect(overnightWindow(at("2026-09-29T17:59:00")).since).toBe(at("2026-09-28T18:00:00"));
    expect(overnightWindow(at("2026-09-29T18:00:00"))).toEqual({ since: at("2026-09-29T06:00:00"), label: "since 06:00" });
    expect(overnightWindow(at("2026-09-29T23:10:00")).since).toBe(at("2026-09-29T06:00:00"));
  });

  it("crosses a month without losing a day", () => {
    expect(overnightWindow(at("2026-10-01T05:00:00")).since).toBe(at("2026-09-30T18:00:00"));
  });
});

describe("what ran", () => {
  const since = at("2026-09-28T18:00:00");
  const jobs = [
    job("b1", "op:app.backup", "completed", "2026-09-29T02:00:00Z", { parameters: { id: "jellyfin" } }),
    job("b2", "op:controller.backup.create", "failed", "2026-09-29T03:00:00Z"),
    job("u1", "op:app.update", "completed", "2026-09-29T04:00:00Z", { parameters: { id: "immich" } }),
    job("u2", "op:apt.upgrade", "applying", "2026-09-29T06:50:00Z"),
    job("o1", "op:storage.remount", "completed", "2026-09-29T05:00:00Z", { parameters: { name: "media" } }),
    // Not part of the glance: waiting for a person, withdrawn, and from before the window.
    job("w1", "op:app.update", "awaiting_approval", "2026-09-29T06:00:00Z"),
    job("c1", "op:app.backup", "cancelled", "2026-09-29T06:10:00Z"),
    job("old", "op:app.backup", "completed", "2026-09-27T02:00:00Z"),
  ];

  it("groups the jobs that ran as backups, updates and the rest, and counts each", () => {
    const groups = whatRan(jobs, since);
    expect(groups.map((group) => [group.kind, group.completed, group.failed, group.running])).toEqual([
      ["backup", 1, 1, 0], ["update", 1, 0, 1], ["other", 1, 0, 0],
    ]);
    expect(groups.flatMap((group) => group.jobs.map((entry) => entry.id))).not.toEqual(expect.arrayContaining(["w1", "c1", "old"]));
  });

  it("puts a failure first in its group, and names what each job acted on", () => {
    const [backups] = whatRan(jobs, since);
    expect(backups.jobs.map((entry) => entry.id)).toEqual(["b2", "b1"]);
    expect(backups.jobs[1]).toMatchObject({ target: "jellyfin", status: "good" });
    expect(backups.jobs[0]).toMatchObject({ target: "", status: "danger" });
  });

  it("knows a backup and an update by their operation", () => {
    expect(ranKind({ type: "op:vm.export.create" })).toBe("backup");
    expect(ranKind({ type: "op:host.snapshot.create" })).toBe("backup");
    expect(ranKind({ type: "op:system.update" })).toBe("update");
    expect(ranKind({ type: "op:app.rollback" })).toBe("update");
    expect(ranKind({ type: "op:firewall.rule.set" })).toBe("other");
  });

  it("keeps a group short", () => {
    const many = Array.from({ length: 9 }, (_, index) => job(`b${index}`, "op:app.backup", "completed", `2026-09-29T0${index}:00:00Z`));
    const [group] = whatRan(many, since, { perGroup: 6 });
    expect(group.completed).toBe(9);
    expect(group.jobs).toHaveLength(6);
  });
});

describe("the copy kept for offline reads", () => {
  it("keeps what was said and drops every button, so nothing can be approved from it", () => {
    const approval: Need = {
      id: "approval:j1", kind: "approval", severity: "warning", title: "Waiting for approval: Update an app", detail: "Staged 3 minutes ago", view: "repairs", jobId: "j1", risk: "medium",
      action: { operationId: "app.update", label: "Review", title: "Update an app", parameters: {}, preview: "", risk: "medium", existingJobId: "j1" },
    };
    const fix: Need = { id: "repair:x", kind: "repair", severity: "danger", title: "A drive dropped", detail: null, view: "repairs", action: { operationId: "storage.remount", label: "Reconnect", title: "Reconnect", parameters: { name: "media" }, preview: "", risk: "low" }, actions: [] };
    const model = { approvals: [approval], attention: [fix] } as unknown as TodayModel;
    const copy = offlineCopy(model);
    expect(copy.approvals[0]).toMatchObject({ title: "Waiting for approval: Update an app", risk: "medium", action: null });
    expect(copy.approvals[0].jobId).toBeUndefined();
    expect(copy.attention[0]).toMatchObject({ title: "A drive dropped", risk: "low", action: null });
    expect(copy.attention[0].actions).toBeUndefined();
    expect(JSON.stringify(copy)).not.toContain("existingJobId");
    expect(JSON.stringify(copy)).not.toContain("\"name\":\"media\"");
  });
});

describe("counts that agree (M88)", () => {
  const since = at("2026-09-28T18:00:00");
  const dismissed = { name: "dismissed", state: "completed", detail: "Dismissed by alex", createdAt: "2026-09-29T07:07:00Z" };

  it("does not count or lead with a failure dismissed since, nor one a later run of the same work covers", () => {
    // The audit's probe: a 03:00 backup failure dismissed at 07:07, and a 07:05 retry that worked.
    const failed = job("f", "op:app.backup", "failed", "2026-09-29T03:00:00Z", { parameters: { id: "immich" }, steps: [dismissed] });
    const retried = job("r", "op:app.backup", "completed", "2026-09-29T07:05:00Z", { parameters: { id: "immich" } });
    const [backups] = whatRan([retried, failed], since);
    // Before: { completed: 1, failed: 1 }, with "Failed, dismissed" listed first.
    expect(backups).toMatchObject({ completed: 1, failed: 0 });
    expect(backups.jobs.map((entry) => entry.id)).toEqual(["r"]);
    // Only dismissed, with no run since: listed as it is, after what ran, and not counted as failed.
    const alone = whatRan([job("ok", "op:app.backup", "completed", "2026-09-29T02:00:00Z", { parameters: { id: "jellyfin" } }), job("f2", "op:app.backup", "failed", "2026-09-29T01:00:00Z", { parameters: { id: "immich" }, steps: [dismissed] })], since)[0];
    expect(alone).toMatchObject({ completed: 1, failed: 0, dismissed: 1 });
    expect(alone.jobs.map((entry) => entry.id)).toEqual(["ok", "f2"]);
    // Still open: counted, and first.
    const open = whatRan([job("ok", "op:app.backup", "completed", "2026-09-29T02:00:00Z", { parameters: { id: "jellyfin" } }), job("f3", "op:app.backup", "failed", "2026-09-29T01:00:00Z", { parameters: { id: "immich" } })], since)[0];
    expect(open).toMatchObject({ completed: 1, failed: 1, dismissed: 0 });
    expect(open.jobs.map((entry) => entry.id)).toEqual(["f3", "ok"]);
  });

  // M88 review: a retry waiting for approval settled the failure, which then vanished from What ran
  // with nothing listed in its place, since a staged job is not one that ran.
  it("keeps a failure whose retry still waits for approval, and drops one a later run that ran covers", () => {
    const failed = job("f", "op:app.backup", "failed", "2026-09-29T03:00:00Z", { parameters: { id: "immich" } });
    const staged = job("s", "op:app.backup", "awaiting_approval", "2026-09-29T07:00:00Z", { parameters: { id: "immich" } });
    const [waiting] = whatRan([staged, failed], since);
    expect(waiting.jobs.map((entry) => entry.id)).toEqual(["f"]);
    // Not counted as failed (the needs list's rule: someone has tried again), and not as dismissed.
    expect(waiting).toMatchObject({ completed: 0, failed: 0, dismissed: 0 });
    for (const state of ["applying", "completed"]) {
      const [ran] = whatRan([job("r", "op:app.backup", state, "2026-09-29T07:00:00Z", { parameters: { id: "immich" } }), failed], since);
      expect(ran.jobs.map((entry) => entry.id)).toEqual(["r"]);
    }
  });
});

describe("the header agrees with the panels (M88)", () => {
  const approval: Need = { id: "approval:s", kind: "approval", severity: "warning", title: "Waiting for approval: Reconnect a drive", detail: null, view: "repairs", action: null };
  const look: Need = { id: "updates", kind: "updates", severity: "warning", title: "4 updates available", detail: null, view: "updates", action: null };
  const wait: Need = { id: "app-update:x", kind: "updates", severity: "neutral", title: "An update for X", detail: null, view: "catalog", action: null };
  const read = { hostname: "homebox", checking: false, unread: [] };

  it("says one job waits for approval, not that one thing needs a look, when that is all there is", () => {
    // Before: "1 to look at · homebox is running. One thing needs a look." over an empty "Needs a look".
    expect(todayVerdict([approval], read)).toEqual({ status: "warning", label: "1 to approve", sentence: "homebox is running. One job waits for your approval." });
    expect(todayVerdict([approval, { ...approval, id: "approval:t" }, wait], read).sentence).toBe("homebox is running. 2 jobs wait for your approval. One more thing can wait.");
  });

  it("counts the approvals apart from what needs a look", () => {
    expect(todayVerdict([approval, look], read)).toEqual({ status: "warning", label: "1 to look at", sentence: "homebox is running. One thing needs a look. One job waits for your approval." });
    expect(todayVerdict([look], read).sentence).toBe("homebox is running. One thing needs a look.");
    expect(todayVerdict([], read).status).toBe("good");
  });
});

import { describe, expect, it } from "vitest";
import { applyLedger, attemptLimit, dismissalFrom, ranFix, withAttempt, withDismissal } from "./repair-ledger.mjs";
import { fingerprintOf } from "./remediations.mjs";

const now = () => new Date("2026-09-29T12:00:00.000Z");
const remount = { operationId: "storage.remount", parameters: { name: "the-dump" }, label: "Reconnect the drive", preview: "" };
const readOnly = { id: "read-only-remount:the-dump", severity: "critical", title: "/mnt/the-dump has gone read-only", detail: "", evidence: ["mounted from /dev/sdb2 with ro"], fix: remount, fixes: [remount], manual: null };
const split = { id: "split-data-folders", severity: "info", title: "Your apps are saving to different drives", detail: "", evidence: ["qBittorrent uses /srv/media on /"], fix: null, fixes: [], manual: "..." };
const job = (id, fields) => ({ id, type: "op:storage.remount", title: "Reconnect a drive", state: "failed", parameters: { name: "the-dump" }, error: "target is busy", createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:05.000Z", ...fields });

describe("setting a finding aside (M35)", () => {
  it("records the reason, the fingerprint and who, and refuses a critical finding at the door", () => {
    expect(dismissalFrom({ id: split.id, fingerprint: fingerprintOf(split), severity: "info", reason: "  deliberate  " }, { by: "owner-1", now })).toEqual({
      key: "split-data-folders", entry: { kind: "finding", fingerprint: fingerprintOf(split), reason: "deliberate", at: "2026-09-29T12:00:00.000Z", by: "owner-1" },
    });
    expect(dismissalFrom({ id: readOnly.id, fingerprint: fingerprintOf(readOnly), severity: "critical", reason: "later" }).error).toContain("critical finding stays until it is fixed");
    expect(dismissalFrom({ id: split.id, fingerprint: fingerprintOf(split), reason: "" }).error).toContain("Say why");
    expect(dismissalFrom({ id: split.id, reason: "x" }).error).toContain("fingerprint");
    expect(dismissalFrom({ id: "../../etc", fingerprint: fingerprintOf(split), reason: "x" }).error).toBe("That is not a finding id");
    // A failed job is let go on the job itself (M36), the one mark Activity, Home and Ops read.
    expect(dismissalFrom({ jobId: "job-1", reason: "done by hand" }, { now }).error).toContain("POST /api/v1/jobs/:id/dismiss");
  });

  it("hides a finding that still says what it said, and brings it back, marked, once it says anything else", () => {
    const dismissals = { [split.id]: dismissalFrom({ id: split.id, fingerprint: fingerprintOf(split), reason: "deliberate" }, { now }).entry };
    const same = applyLedger([split], { dismissals });
    expect(same.findings).toEqual([]);
    expect(same.dismissed).toMatchObject([{ id: split.id, dismissal: { reason: "deliberate" } }]);
    const changed = applyLedger([{ ...split, evidence: [...split.evidence, "Plex uses /mnt/the-dump on /mnt/the-dump"] }], { dismissals });
    expect(changed.dismissed).toEqual([]);
    expect(changed.findings[0]).toMatchObject({ id: split.id, returned: { reason: "deliberate", why: "changed" } });
  });

  it("never hides a critical finding, even one dismissed before it became critical", () => {
    const dismissals = { [readOnly.id]: { kind: "finding", fingerprint: fingerprintOf(readOnly), reason: "later", at: "x" } };
    const { findings, dismissed } = applyLedger([readOnly], { dismissals });
    expect(dismissed).toEqual([]);
    expect(findings[0].returned).toMatchObject({ why: "critical" });
  });

  it("keeps at most so many, dropping the oldest", () => {
    let ledger = {};
    for (let index = 0; index < 205; index += 1) ledger = withDismissal(ledger, `f${index}`, { kind: "finding", at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
    expect(Object.keys(ledger)).toHaveLength(200);
    expect(ledger.f0).toBeUndefined();
    expect(ledger.f204).toBeDefined();
  });
});

describe("the last try at a fix (M35)", () => {
  it("matches a job to a fix by operation and the parameters the fix names, prepare hooks' additions aside", () => {
    expect(ranFix(job("a"), remount)).toBe(true);
    expect(ranFix(job("a", { parameters: { name: "the-dump", devices: [] } }), remount)).toBe(true);
    expect(ranFix(job("a", { parameters: { name: "media" } }), remount)).toBe(false);
    expect(ranFix(job("a", { type: "op:storage.check" }), remount)).toBe(false);
    expect(ranFix(job("a"), { kind: "schedule", operationId: "storage.remount", parameters: { name: "the-dump" } })).toBe(false);
  });

  it("shows a failed reconnect on its finding, so Home does not list it as a failure of its own", () => {
    // The owner's "Failed: Reconnect a drive" stayed on Home after four refused attempts.
    const refused = job("j1");
    const { findings, jobs } = applyLedger([readOnly], { jobs: [refused] });
    expect(findings[0].lastAttempt).toMatchObject({ jobId: "j1", state: "failed", error: "target is busy", label: "Reconnect the drive", timeout: null });
    expect(jobs.attached).toEqual(["j1"]);
  });

  it("carries a try's timeout, so Repair does not offer it again while it may still be running (sweep 4)", () => {
    const timeout = { scope: "step", budgetMs: 540_000, elapsedMs: 600_000, phase: "running", step: "Root task storage.remount", lastOutput: null, moreTimeMs: null, stillRunning: true };
    const { findings } = applyLedger([readOnly], { jobs: [job("j1", { timeout })], now });
    expect(findings[0].lastAttempt).toMatchObject({ jobId: "j1", state: "failed", timeout });
    expect(findings[0].lastAttempt.timeout.settled).toBeUndefined();
  });

  it("stops calling a try possibly still running 12 hours after it ran out, or its budget again if longer (sweep 5)", () => {
    // One timeout hid the drive's Reconnect for weeks: nothing aged the "may still be running".
    const timeout = { scope: "step", budgetMs: 540_000, elapsedMs: 600_000, phase: "running", step: "Root task storage.remount", lastOutput: null, moreTimeMs: null, stillRunning: true };
    const lastTimeout = (fields, options = {}) => applyLedger([readOnly], { jobs: [job("j1", { timeout, ...fields })], now, ...options }).findings[0].lastAttempt.timeout;
    expect(lastTimeout({ updatedAt: "2026-08-30T12:00:00.000Z" })).toEqual({ ...timeout, settled: true });   // 30 days ago
    expect(lastTimeout({ updatedAt: "2026-09-28T23:30:00.000Z" })).toEqual({ ...timeout, settled: true });   // 12.5 hours ago
    expect(lastTimeout({ updatedAt: "2026-09-29T01:00:00.000Z" })).toEqual(timeout);                          // 11 hours ago: it may be
    // A whole operation that had longer than 12 hours may run on for as long again.
    const long = { ...timeout, scope: "operation", stillRunning: undefined, budgetMs: 18 * 3_600_000 };
    expect(applyLedger([readOnly], { jobs: [job("j1", { timeout: long, updatedAt: "2026-09-28T20:00:00.000Z" })], now }).findings[0].lastAttempt.timeout).toEqual(long);
    expect(applyLedger([readOnly], { jobs: [job("j1", { timeout: long, updatedAt: "2026-09-28T17:00:00.000Z" })], now }).findings[0].lastAttempt.timeout).toEqual({ ...long, settled: true });
    // Let go with M36's mark on the job (Dismiss this try on Repair): settled at once.
    expect(lastTimeout({ steps: [{ name: "dismissed", state: "completed" }] })).toEqual({ ...timeout, settled: true });
    // One that only waited in the queue never started; nothing to settle.
    expect(lastTimeout({ timeout: { ...timeout, phase: "queued", stillRunning: undefined }, updatedAt: "2026-08-30T12:00:00.000Z" })).toEqual({ ...timeout, phase: "queued", stillRunning: undefined });
  });

  it("prefers the newest try, whether it was recorded against the finding or only ran the same fix", () => {
    const older = job("j1", { updatedAt: "2026-09-29T09:00:00.000Z" });
    const newer = job("j2", { state: "completed", error: null, updatedAt: "2026-09-29T11:00:00.000Z" });
    const { findings } = applyLedger([readOnly], { jobs: [older, newer], attempts: { j1: { findingId: readOnly.id } } });
    expect(findings[0].lastAttempt).toMatchObject({ jobId: "j2", state: "completed" });
  });

  it("lets a failed fix drop away once the finding it was fixing is gone, and a failure set aside", () => {
    const refused = job("j1");
    const attempts = withAttempt({}, "j1", readOnly.id, { now });
    const gone = applyLedger([], { jobs: [refused], attempts });
    expect(gone.jobs.resolved).toEqual(["j1"]);
    // A failure dismissed carries M36's "dismissed" step; only jobs this caller may see are named.
    const dismissed = applyLedger([], { jobs: [job("j9", { type: "op:app.update", steps: [{ name: "dismissed", state: "completed", detail: "Dismissed by owner." }] }), job("j10")] });
    expect(dismissed.jobs.dismissed).toEqual(["j9"]);
    expect(applyLedger([], { jobs: [] }).jobs.dismissed).toEqual([]);
  });

  it("lets a failed reconnect go once its drive or share is mounted and well, wherever it was started", () => {
    // The owner's backup share was mounted and readable while Home still said "Failed: Reconnect a
    // drive": that try was started from Home's Try again, not from a finding, so nothing let it go.
    const busy = job("j1");
    const share = job("j2", { parameters: { name: "share-boxpilot-backup" } });
    const byShare = job("j3", { type: "op:share.reconnect", parameters: { name: "nas-public" } });
    const mounts = [
      { target: "/mnt/the-dump", source: "/dev/sdb2", managedName: "the-dump", readOnly: false, options: "defaults,nofail" },
      { target: "/mnt/boxpilot/backup", source: "//nas/backup", managedName: "share-boxpilot-backup", readOnly: false, options: "credentials=x,nofail" },
    ];
    expect(applyLedger([], { jobs: [busy, share, byShare], mounts }).jobs.resolved.sort()).toEqual(["j1", "j2"]);
    // Still read-only, still found by the scan, not mounted at all, or the mounts not read: kept.
    expect(applyLedger([], { jobs: [busy], mounts: [{ ...mounts[0], readOnly: true }] }).jobs.resolved).toEqual([]);
    expect(applyLedger([readOnly], { jobs: [busy, job("j0", { updatedAt: "2026-09-29T09:00:00.000Z" })], mounts }).jobs.resolved).toEqual([]);
    expect(applyLedger([], { jobs: [byShare], mounts }).jobs.resolved).toEqual([]);
    expect(applyLedger([], { jobs: [busy] }).jobs.resolved).toEqual([]);
    // A drive fstab itself mounts read-only is as it should be.
    expect(applyLedger([], { jobs: [busy], mounts: [{ ...mounts[0], readOnly: true, options: "ro,nofail" }] }).jobs.resolved).toEqual(["j1"]);
  });

  it("remembers a bounded number of attempts", () => {
    let attempts = {};
    for (let index = 0; index < attemptLimit + 5; index += 1) attempts = withAttempt(attempts, `j${index}`, "f", { now: () => new Date(Date.UTC(2026, 0, 1, 0, index)) });
    expect(Object.keys(attempts)).toHaveLength(attemptLimit);
    expect(attempts.j0).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { offBoxVerdict, offBoxWarning, mirrorOperations } from "./offBox";

const now = Date.parse("2026-08-25T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const warn = (inputs: Parameters<typeof offBoxVerdict>[0]) => offBoxWarning(offBoxVerdict(inputs, { now }));

describe("whether a copy exists off this server", () => {
  it("says backups are only on this server when nothing is set up", () => {
    // The case BoxPilot used to be silent about, and the one most servers are actually in.
    expect(offBoxVerdict({}, { now }).state).toBe("none");
    expect(warn({})).toBe("Backups are only on this server. A disk failure would take them with it");
  });

  it("distinguishes a destination that exists from one anything has reached", () => {
    const verdict = offBoxVerdict({ cloud: { configured: true, lastSyncAt: null } }, { now });
    expect(verdict).toMatchObject({ configured: true, state: "never", ageDays: null });
    expect(offBoxWarning(verdict)).toBe("Backups have never been copied off this server");
  });

  it("is satisfied by a recent copy and complains about an old one", () => {
    expect(warn({ cloud: { configured: true, lastSyncAt: daysAgo(1) } })).toBeNull();
    expect(warn({ cloud: { configured: true, lastSyncAt: daysAgo(30) } })).toBe("The off-box copy of your backups is 30 days old");
  });

  it("takes the best copy anywhere, not the most neglected destination", () => {
    // Adding a second destination must never make the verdict worse: a fresh cloud copy protects
    // you regardless of a drive nobody has plugged in since spring.
    const verdict = offBoxVerdict({
      cloud: { configured: true, lastSyncAt: daysAgo(1) },
      drive: { configured: true, lastSyncAt: daysAgo(200) },
    }, { now });
    expect(verdict.state).toBe("ok");
    expect(verdict.ageDays).toBe(1);
    expect(verdict.where).toEqual(["cloud", "a backup drive"]);
  });

  it("ignores a destination that was never saved, even if a stale timestamp lingers", () => {
    expect(offBoxVerdict({ ssh: { configured: false, lastSyncAt: daysAgo(2) } }, { now }).state).toBe("none");
  });

  it("notices a mirror that stopped following the backups long before it counts as stale", () => {
    // The live case: nightly local backups kept landing while the drive mirror sat two days
    // behind, and the seven-day age rule said nothing the whole time.
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const inputs = { drive: { configured: true, lastSyncAt: daysAgo(2) } };
    const verdict = offBoxVerdict(inputs, { now, newestLocalBackupAt: hoursAgo(30) });
    expect(verdict.state).toBe("behind");
    expect(verdict.behindHours).toBe(30);
    expect(offBoxWarning(verdict)).toBe("Backups newer than the off-box copy have been waiting 30 hours; the sync that should have followed them has not run");
    // Inside the slack window the ordinary backup-then-sync gap is not an alarm.
    expect(offBoxVerdict(inputs, { now, newestLocalBackupAt: hoursAgo(6) }).state).toBe("ok");
    // A local backup older than the copy means the mirror has everything.
    expect(offBoxVerdict(inputs, { now, newestLocalBackupAt: daysAgo(3) }).state).toBe("ok");
    // Not knowing the local side changes nothing.
    expect(offBoxVerdict(inputs, { now }).state).toBe("ok");
    // Staleness still wins its own case: no local timestamp, just an old copy.
    expect(offBoxVerdict({ drive: { configured: true, lastSyncAt: daysAgo(30) } }, { now, newestLocalBackupAt: hoursAgo(30) }).state).toBe("behind");
  });

  it("schedules only the syncs that have somewhere to go", () => {
    expect(mirrorOperations({})).toEqual([]);
    expect(mirrorOperations({ cloud: { configured: true, lastSyncAt: null }, ssh: { configured: false, lastSyncAt: null } })).toEqual(["backup.cloud.sync"]);
    expect(mirrorOperations({
      cloud: { configured: true, lastSyncAt: null },
      ssh: { configured: true, lastSyncAt: null },
      drive: { configured: true, lastSyncAt: null },
    })).toEqual(["backup.cloud.sync", "backup.remote.sync", "backup.sync"]);
  });
});

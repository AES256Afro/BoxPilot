import { describe, it, expect } from "vitest";
import { offBoxVerdict, offBoxWarning, mirrorOperations } from "./offBox";

const now = Date.parse("2026-08-25T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const warn = (inputs: Parameters<typeof offBoxVerdict>[0]) => offBoxWarning(offBoxVerdict(inputs, { now }));

describe("whether a copy exists off this server", () => {
  it("says backups are only on this server when nothing is set up", () => {
    // The case BoxPilot used to be silent about, and the one most servers are actually in.
    expect(offBoxVerdict({}, { now }).state).toBe("none");
    expect(warn({})).toBe("Backups are only on this server — a disk failure would take them with it");
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

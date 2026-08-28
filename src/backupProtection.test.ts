import { describe, it, expect } from "vitest";
import { behindBackupSchedules, judgeProtection, scheduledAppIds, protectionWarning, type AppProtection } from "./backupProtection";

const now = Date.parse("2026-08-25T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const app = (over: Partial<AppProtection> & { id: string }): AppProtection =>
  ({ name: over.id, protectable: true, backups: 0, newestAt: null, ...over });

describe("deciding which apps are protected", () => {
  it("calls an app with no backup at all 'never', however recently it was installed", () => {
    const [verdict] = judgeProtection([app({ id: "vaultwarden" })], [], { now });
    expect(verdict.state).toBe("never");
    expect(verdict.ageDays).toBeNull();
  });

  it("treats a backup nobody has refreshed as stale, not as protection", () => {
    const verdicts = judgeProtection([
      app({ id: "immich", backups: 3, newestAt: daysAgo(60) }),
      app({ id: "jellyfin", backups: 1, newestAt: daysAgo(2) }),
    ], [], { now });
    expect(verdicts.find((verdict) => verdict.id === "immich")?.state).toBe("stale");
    expect(verdicts.find((verdict) => verdict.id === "jellyfin")?.state).toBe("ok");
  });

  it("never reports an app whose data is not worth backing up", () => {
    // Ollama's only volume is downloaded models: gigabytes that come back on demand. Listing it as
    // unprotected would be noise, and worse, would invite backing up 19 GB of re-downloadable data.
    const verdicts = judgeProtection([app({ id: "ollama", protectable: false })], [], { now });
    expect(verdicts).toEqual([]);
  });

  it("counts only enabled app.backup schedules as protection", () => {
    // `subject` is what /schedules actually returns: the list endpoint reduces the real parameters
    // to a display subject. Reading `id` instead reported every app as unscheduled while its
    // schedule was running, which is exactly what happened on a live server.
    const schedules = [
      { operationId: "app.backup", parameters: { subject: "immich" }, enabled: true },
      { operationId: "app.backup", parameters: { subject: "jellyfin" }, enabled: false }, // paused protects nothing
      { operationId: "apt.upgrade", parameters: {}, enabled: true },                       // not a backup
      { operationId: "app.backup", parameters: {}, enabled: true },                        // malformed, no subject
    ];
    expect([...scheduledAppIds(schedules)]).toEqual(["immich"]);
  });

  it("also accepts the raw parameters used when creating a schedule", () => {
    expect([...scheduledAppIds([{ operationId: "app.backup", parameters: { id: "vaultwarden" }, enabled: true }])]).toEqual(["vaultwarden"]);
  });

  it("separates having a backup from having something that keeps making them", () => {
    // A backup taken once by hand is not the same as being looked after, and the Backups page
    // should be able to say which of the two an app has.
    const verdicts = judgeProtection(
      [app({ id: "immich", backups: 1, newestAt: daysAgo(1) })],
      [{ operationId: "app.backup", parameters: { subject: "immich" }, enabled: false }],
      { now },
    );
    expect(verdicts[0]).toMatchObject({ state: "ok", scheduled: false });
  });
});

describe("what the Overview says about it", () => {
  it("names one or two apps, and counts the rest", () => {
    expect(protectionWarning(judgeProtection([app({ id: "Vaultwarden" })], [], { now })))
      .toBe("Vaultwarden has never been backed up");
    expect(protectionWarning(judgeProtection([app({ id: "Vaultwarden" }), app({ id: "Immich" })], [], { now })))
      .toBe("Vaultwarden and Immich have never been backed up");
    expect(protectionWarning(judgeProtection([app({ id: "Vaultwarden" }), app({ id: "Immich" }), app({ id: "Nextcloud" }), app({ id: "Jellyfin" })], [], { now })))
      .toBe("Vaultwarden, Immich and 2 more have never been backed up");
  });

  it("leads with the apps that have nothing, not the ones merely out of date", () => {
    const warning = protectionWarning(judgeProtection([
      app({ id: "Immich", backups: 2, newestAt: daysAgo(90) }),
      app({ id: "Vaultwarden" }),
    ], [], { now }));
    expect(warning).toBe("Vaultwarden has never been backed up");
  });

  it("says nothing when every app has a recent backup", () => {
    expect(protectionWarning(judgeProtection([app({ id: "immich", backups: 4, newestAt: daysAgo(1) })], [], { now }))).toBeNull();
  });
});

describe("behindBackupSchedules", () => {
  it("keeps only overdue, enabled, backup-related schedules", () => {
    const schedules = [
      { operationId: "app.backup", enabled: true, overdue: true, title: "Back up application data" },
      { operationId: "backup.cloud.sync", enabled: true, overdue: true, title: "Mirror to cloud" },
      { operationId: "app.backup", enabled: true, overdue: false, title: "On time" },       // not overdue
      { operationId: "app.backup", enabled: false, overdue: true, title: "Paused" },          // disabled
      { operationId: "apt.upgrade", enabled: true, overdue: true, title: "Not a backup" },     // unrelated op
    ];
    expect(behindBackupSchedules(schedules).map((s: { title?: string }) => s.title)).toEqual(["Back up application data", "Mirror to cloud"]);
  });
});

import { describe, expect, it } from "vitest";
import type { AppProtection } from "../../backupProtection";
import { offBoxVerdict, type OffBoxInputs } from "../../offBox";
import { dayWords, daysBack, depthWords, offCopyOf, proofOf, recoveryOf, recoveryVerdict, sendOffOperation, serverFacts, type RecoveryInputs } from "./recovery";

/*
 * What you'd get back, worked out from what the server records. The clock and the zone are held
 * still: it is Tuesday 10 November 2026, 19:52 UTC, the evening the page was drawn for.
 */

const now = Date.parse("2026-11-10T19:52:00Z");
const options = { now, timeZone: "UTC" };
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const daysAgo = (days: number) => hoursAgo(days * 24);

const app = (id: string, backups: number, newestAt: string | null, extra: Partial<AppProtection> = {}): AppProtection => ({ id, name: id[0].toUpperCase() + id.slice(1), protectable: true, backups, newestAt, ...extra });
/** A drive that last finished a sync that many hours ago, and nothing else set up. */
const driveSynced = (hours: number, skipped = 0): OffBoxInputs => ({ cloud: { configured: false, lastSyncAt: null }, ssh: { configured: false, lastSyncAt: null }, drive: { configured: true, lastSyncAt: hoursAgo(hours), skipped } });
const nowhere: OffBoxInputs = { cloud: { configured: false, lastSyncAt: null }, ssh: { configured: false, lastSyncAt: null }, drive: { configured: false, lastSyncAt: null } };
const nightly = (id: string) => ({ operationId: "app.backup", parameters: { subject: id }, enabled: true });
const passed = (hours: number) => ({ verified: true, backup: "20261029T031400Z.tar.gz", reason: null, checkedAt: hoursAgo(hours) });

const one = (inputs: Partial<RecoveryInputs> & { apps: AppProtection[] }) => {
  const recovery = recoveryOf({ schedules: [], offBox: nowhere, rehearsals: Object.fromEntries(inputs.apps.map((entry) => [entry.id, null])), ...inputs }, options);
  return { recovery, row: recovery.rows[0] };
};

describe("what an app would get back", () => {
  it("comes back installed and empty when it has never been backed up", () => {
    const { row, recovery } = one({ apps: [app("nextcloud", 0, null)], offBox: driveSynced(2) });
    expect(row).toMatchObject({ depth: 0, grade: "none", status: "danger", outcome: "Comes back installed and empty", next: "back-up", local: { state: "never" }, off: { state: "none" }, proof: { state: "never" } });
    expect(recoveryVerdict(recovery)).toMatchObject({ status: "danger", label: "If the disk died tonight, 1 app comes back empty" });
  });

  it("is gone when its only copy is on this server: nowhere to send it, nothing ever sent, or made after the last sync", () => {
    const gone = { depth: 1, grade: "none", status: "danger", outcome: "Gone: its only copy is on that disk", next: "send-off", off: { state: "none" } };
    expect(one({ apps: [app("webui", 3, hoursAgo(18))], offBox: nowhere }).row).toMatchObject(gone);
    expect(one({ apps: [app("webui", 3, hoursAgo(18))], offBox: { ...nowhere, cloud: { configured: true, lastSyncAt: null } } }).row).toMatchObject(gone);
    // One backup, made five hours ago; the drive last synced twenty hours ago.
    expect(one({ apps: [app("webui", 1, hoursAgo(5))], offBox: driveSynced(20) }).row).toMatchObject(gone);
  });

  it("goes back to an old copy, and says how much is gone", () => {
    const immich = app("immich", 2, "2026-09-08T03:00:00Z");
    const { row } = one({ apps: [immich], offBox: driveSynced(20) });
    expect(row).toMatchObject({ depth: 2, grade: "partly", status: "warning", outcome: "Back to 8 September: 63 days gone, if the copy restores", next: "schedule" });
    expect(row.off).toEqual({ state: "copied", copyAt: "2026-09-08T03:00:00Z", syncedAt: hoursAgo(20) });
    // With a nightly backup that is evidently not keeping it current, a backup now is the step.
    expect(one({ apps: [immich], offBox: driveSynced(20), schedules: [nightly("immich")] }).row.next).toBe("back-up");
    // An old copy that has been proven is still old.
    expect(one({ apps: [immich], offBox: driveSynced(20), schedules: [nightly("immich")], rehearsals: { immich: passed(30) } }).row).toMatchObject({ depth: 3, grade: "partly", status: "warning", outcome: "Back to 8 September: 63 days gone" });
  });

  it("goes back to a fresh copy only if it restores, while no restore has been proven", () => {
    const { row, recovery } = one({ apps: [app("pihole", 4, hoursAgo(30))], offBox: driveSynced(20), schedules: [nightly("pihole")] });
    expect(row).toMatchObject({ depth: 2, grade: "partly", status: "warning", outcome: "Back to yesterday, if the copy restores", next: "rehearse", proof: { state: "never" } });
    expect(recoveryVerdict(recovery)).toMatchObject({ status: "warning", label: "If the disk died tonight, 1 app comes back old or unproven" });
  });

  it("is fully recoverable with a recent copy off this server and a rehearsal that passed", () => {
    const { row, recovery } = one({ apps: [app("jellyfin", 9, hoursAgo(17))], offBox: driveSynced(15), schedules: [nightly("jellyfin")], rehearsals: { jellyfin: passed(12 * 24) } });
    expect(row).toMatchObject({ depth: 3, grade: "full", status: "good", outcome: "Back to earlier today", next: null, proof: { state: "passed", at: hoursAgo(12 * 24) } });
    expect(recoveryVerdict(recovery)).toEqual({ status: "good", label: "If the disk died tonight, the app comes back", short: "every app comes back" });
    // Nothing keeps it current: that is still the step, though the row is whole today.
    expect(one({ apps: [app("jellyfin", 9, hoursAgo(17))], offBox: driveSynced(15), rehearsals: { jellyfin: passed(12 * 24) } }).row).toMatchObject({ grade: "full", next: "schedule" });
  });

  it("does not list an app that holds no data worth backing up", () => {
    const { recovery } = one({ apps: [app("homepage", 0, null, { protectable: false }), app("vaultwarden", 0, null)] });
    expect(recovery.rows.map((row) => row.id)).toEqual(["vaultwarden"]);
    expect(one({ apps: [app("homepage", 0, null, { protectable: false })] }).recovery).toMatchObject({ read: true, rows: [], counts: { full: 0, partly: 0, none: 0, unknown: 0 } });
    expect(recoveryVerdict(one({ apps: [app("homepage", 0, null, { protectable: false })] }).recovery)).toMatchObject({ status: "neutral", label: "No app holds data yet" });
  });

  it("says the newest copy has not left when it was made after every sync, without guessing about the older ones", () => {
    const { row, recovery } = one({ apps: [app("jellyfin", 9, hoursAgo(11))], offBox: driveSynced(7 * 24 + 15), rehearsals: { jellyfin: passed(11) } });
    expect(row.off).toEqual({ state: "waiting", syncedAt: hoursAgo(7 * 24 + 15) });
    expect(row).toMatchObject({ depth: 2, grade: "unknown", status: "warning", outcome: "Back to before 3 November at best: its newer copies are only on that disk", next: "send-off" });
    expect(recoveryVerdict(recovery)).toMatchObject({ status: "warning", label: "If the disk died tonight, what 1 app would get back is not known" });
  });

  it("does not count a copy the only sync since may have left out, and takes a whole sync elsewhere over it", () => {
    const { row } = one({ apps: [app("immich", 2, hoursAgo(30))], offBox: driveSynced(20, 2) });
    expect(row.off).toEqual({ state: "uncertain", copyAt: hoursAgo(30), syncedAt: hoursAgo(20), leftOut: 2 });
    expect(row).toMatchObject({ depth: 1, grade: "unknown", status: "warning", outcome: "Back to yesterday, unless its copy is among the 2 files the last sync left out", next: "send-off" });
    const both = { ...driveSynced(20, 2), ssh: { configured: true, lastSyncAt: hoursAgo(26) } };
    expect(one({ apps: [app("immich", 2, hoursAgo(30))], offBox: both }).row.off).toEqual({ state: "copied", copyAt: hoursAgo(30), syncedAt: hoursAgo(26) });
  });

  it("takes any one destination's sync as enough, and ignores a destination that is not set up", () => {
    const local = { state: "kept" as const, at: hoursAgo(30), count: 4 };
    expect(offCopyOf(local, { cloud: { configured: true, lastSyncAt: hoursAgo(26) }, ssh: { configured: true, lastSyncAt: hoursAgo(200) }, drive: { configured: false, lastSyncAt: null } })).toMatchObject({ state: "copied", syncedAt: hoursAgo(26) });
    // A sync time left over from a drive that is no longer there proves nothing about tonight.
    expect(offCopyOf(local, { ...nowhere, drive: { configured: false, lastSyncAt: hoursAgo(2) } })).toEqual({ state: "none" });
    expect(offCopyOf(local, { ...nowhere, drive: { configured: true, lastSyncAt: "not a date" } })).toEqual({ state: "none" });
  });

  it("never counts a failed rehearsal as proof", () => {
    const failed = { verified: false, backup: "20261101T031400Z.tar.gz", reason: "The archive could not be read all the way through: unexpected end of file", checkedAt: hoursAgo(9 * 24) };
    // The backup that failed is still the newest: take a fresh one.
    const stillNewest = one({ apps: [app("immich", 2, hoursAgo(10 * 24))], offBox: driveSynced(20), schedules: [nightly("immich")], rehearsals: { immich: failed } }).row;
    expect(stillNewest).toMatchObject({ depth: 2, grade: "partly", status: "danger", outcome: "Back to 31 October: 10 days gone, but its last restore rehearsal failed", next: "back-up" });
    expect(stillNewest.proof).toEqual({ state: "failed", at: hoursAgo(9 * 24), reason: failed.reason });
    // A newer backup has been taken since and not tried.
    expect(one({ apps: [app("immich", 3, hoursAgo(30))], offBox: driveSynced(20), schedules: [nightly("immich")], rehearsals: { immich: failed } }).row).toMatchObject({ grade: "partly", status: "danger", next: "rehearse" });
  });

  it("puts the worst first: nothing back, then not known, then partly, then whole", () => {
    const { recovery } = one({
      apps: [app("whole", 5, hoursAgo(30)), app("partly", 5, hoursAgo(30)), app("waiting", 5, hoursAgo(3)), app("local", 1, hoursAgo(3)), app("empty", 0, null)],
      offBox: driveSynced(20),
      schedules: ["whole", "partly", "waiting", "local"].map(nightly),
      rehearsals: { whole: passed(40), partly: null, waiting: null, local: null, empty: null },
    });
    expect(recovery.rows.map((row) => `${row.id} ${row.depth}/3`)).toEqual(["empty 0/3", "local 1/3", "waiting 1/3", "partly 2/3", "whole 3/3"]);
    expect(recovery.counts).toEqual({ full: 1, partly: 1, none: 2, unknown: 1 });
    expect(recoveryVerdict(recovery)).toEqual({ status: "danger", label: "If the disk died tonight, 2 apps come back empty", short: "2 would come back empty" });
  });

  it("does not count a paused nightly backup as keeping an app current", () => {
    const paused = [{ operationId: "app.backup", parameters: { subject: "pihole" }, enabled: false }];
    expect(one({ apps: [app("pihole", 4, hoursAgo(30))], offBox: driveSynced(20), schedules: paused }).row).toMatchObject({ scheduled: false, next: "schedule" });
  });
});

describe("what could not be read", () => {
  it("has no rows and no verdict but not read when the apps could not be read", () => {
    const recovery = recoveryOf({ apps: null, schedules: [], offBox: driveSynced(2), rehearsals: {} }, options);
    expect(recovery).toEqual({ read: false, rows: [], counts: { full: 0, partly: 0, none: 0, unknown: 0 } });
    expect(recoveryVerdict(recovery)).toEqual({ status: "unknown", label: "Not read", short: "not read" });
  });

  it("says not read, never gone and never back, when the destinations could not be read", () => {
    const { row, recovery } = one({ apps: [app("vaultwarden", 3, hoursAgo(30))], offBox: null, rehearsals: { vaultwarden: passed(40) } });
    expect(row).toMatchObject({ depth: 2, grade: "unknown", status: "unknown", outcome: "Not known: whether a copy is off this server was not read", next: null, off: { state: "unread" } });
    expect(recoveryVerdict(recovery).status).toBe("unknown");
    // An app with no backup at all is empty whatever the destinations say.
    expect(one({ apps: [app("vaultwarden", 0, null)], offBox: null }).row).toMatchObject({ grade: "none", outcome: "Comes back installed and empty" });
  });

  it("does not call a copy missing while one destination's state did not come back, and still counts a copy it found", () => {
    const local = { state: "kept" as const, at: hoursAgo(5), count: 1 };
    // The drive last synced before this copy was made; the cloud destination could not be read.
    const cloudUnread = { ...driveSynced(20), cloud: null };
    expect(offCopyOf(local, cloudUnread)).toEqual({ state: "unread" });
    expect(offCopyOf({ ...local, count: 4 }, cloudUnread)).toEqual({ state: "unread" });
    expect(offCopyOf(local, { ...nowhere, ssh: undefined })).toEqual({ state: "unread" });
    expect(offCopyOf({ ...local, at: hoursAgo(30) }, { ...driveSynced(20, 3), cloud: null })).toEqual({ state: "unread" });
    expect(offCopyOf({ ...local, at: hoursAgo(30) }, cloudUnread)).toEqual({ state: "copied", copyAt: hoursAgo(30), syncedAt: hoursAgo(20) });
    expect(one({ apps: [app("webui", 1, hoursAgo(5))], offBox: cloudUnread }).row).toMatchObject({ grade: "unknown", status: "unknown", next: null });
  });

  it("reads an answer in a shape it does not know as not read or not a row, and never throws", () => {
    const odd = [null, "immich", { protectable: true }, { id: 7, protectable: true }, { id: "constructor", protectable: true, backups: "3", newestAt: 1731240000000 }, { id: "immich", name: 12, protectable: true, backups: 2, newestAt: {} }] as unknown as AppProtection[];
    const hostile = { cloud: { configured: true, lastSyncAt: 5, skipped: "2" }, ssh: { configured: "yes", lastSyncAt: "9999999-01-01" }, drive: { configured: true, lastSyncAt: hoursAgo(2), skipped: -1 } } as unknown as OffBoxInputs;
    const recovery = recoveryOf({ apps: odd, schedules: [{ operationId: "app.backup", parameters: null }], offBox: hostile, rehearsals: { immich: [] as never, other: "passed" as never } }, options);
    expect(recovery.rows.map((row) => [row.id, row.name, row.local.state, row.off.state, row.proof.state, row.status])).toEqual([
      // A count that is not a number is no copy; a rehearsal map with no entry of its own is unread.
      ["constructor", "constructor", "never", "none", "unread", "danger"],
      ["immich", "immich", "kept", "unread", "unread", "unknown"],
    ]);
    expect(recoveryVerdict(recovery).status).toBe("danger");
  });

  it("is never whole while the rehearsals are unread: the catalog did not answer, or left this app out", () => {
    const fresh = { apps: [app("vaultwarden", 3, hoursAgo(30))], offBox: driveSynced(20), schedules: [nightly("vaultwarden")] };
    const unread: Array<RecoveryInputs["rehearsals"]> = [null, {}, { vaultwarden: { verified: "yes" } }];
    for (const rehearsals of unread) {
      const { row, recovery } = one({ ...fresh, rehearsals });
      expect(row).toMatchObject({ depth: 2, grade: "unknown", status: "unknown", outcome: "Back to yesterday; whether it restores was not read", proof: { state: "unread" }, next: null });
      expect(recoveryVerdict(recovery)).toMatchObject({ status: "unknown", label: "If the disk died tonight, what 1 app would get back is not known" });
    }
    expect(proofOf({ vaultwarden: null }, "vaultwarden")).toEqual({ state: "never" });
    expect(proofOf({ vaultwarden: { verified: true, checkedAt: "garbled" } }, "vaultwarden")).toEqual({ state: "passed", at: null });
  });

  it("does not place a copy with no readable date before or after a sync", () => {
    const { row } = one({ apps: [app("vaultwarden", 3, null)], offBox: driveSynced(20) });
    expect(row.local).toEqual({ state: "kept", at: null, count: 3 });
    expect(row).toMatchObject({ depth: 1, grade: "unknown", status: "unknown", off: { state: "unread" } });
    // With nowhere to send it, its date does not matter: it is on this disk and nowhere else.
    expect(one({ apps: [app("vaultwarden", 3, null)], offBox: nowhere }).row).toMatchObject({ grade: "none", outcome: "Gone: its only copy is on that disk" });
  });
});

describe("the words", () => {
  it("counts days on the calendar of the zone it is told, and names the year only when it is another one", () => {
    expect(daysBack(Date.parse("2026-11-09T23:30:00Z"), now, "UTC")).toBe(1);
    expect(daysBack(Date.parse("2026-11-10T00:10:00Z"), now, "UTC")).toBe(0);
    // 23:30 UTC on the 9th is already the 10th in Tokyo, where it is now the 11th.
    expect(daysBack(Date.parse("2026-11-09T23:30:00Z"), now, "Asia/Tokyo")).toBe(1);
    expect(daysBack(now + 60_000, now, "UTC")).toBe(0);
    expect(dayWords(Date.parse("2026-09-08T03:00:00Z"), now, "UTC")).toBe("8 September");
    expect(dayWords(Date.parse("2025-12-31T03:00:00Z"), now, "UTC")).toBe("31 December 2025");
  });

  it("says the depth in words, naming what it has", () => {
    const { row } = one({ apps: [app("pihole", 4, hoursAgo(30))], offBox: driveSynced(20) });
    expect(depthWords(row)).toBe("2 of 3: a copy on this server, a copy off this server");
    expect(depthWords(one({ apps: [app("nextcloud", 0, null)] }).row)).toBe("0 of 3");
  });
});

describe("sending off this server", () => {
  it("starts the first sync that is ready and that the role may start", () => {
    const anyone = () => true;
    expect(sendOffOperation({ drive: true, ssh: true, cloud: true }, anyone)).toBe("backup.sync");
    expect(sendOffOperation({ drive: false, ssh: true, cloud: true }, anyone)).toBe("backup.remote.sync");
    expect(sendOffOperation({ drive: false, ssh: false, cloud: true }, anyone)).toBe("backup.cloud.sync");
    expect(sendOffOperation({ drive: false, ssh: false, cloud: true }, (operationId) => operationId !== "backup.cloud.sync")).toBeNull();
    expect(sendOffOperation({ drive: false, ssh: false, cloud: false }, anyone)).toBeNull();
  });
});

describe("the server itself", () => {
  const drilled = { createdAt: hoursAgo(5), restoreDrill: { passed: true } };

  it("says when the newest snapshot, copy and drilled database backup were made", () => {
    const facts = serverFacts({ snapshots: [{ createdAt: daysAgo(8) }, { createdAt: hoursAgo(20) }], offBox: offBoxVerdict(driveSynced(15), { now }), database: [{ createdAt: daysAgo(3), restoreDrill: { passed: false } }, drilled] });
    expect(facts).toEqual([
      { id: "snapshot", label: "Machine snapshot", value: "", at: hoursAgo(20) },
      { id: "offbox", label: "Off this server", value: "", at: hoursAgo(15) },
      { id: "database", label: "BoxPilot's database", value: "drilled, passed,", at: hoursAgo(5) },
    ]);
  });

  it("says what is missing, and what the newest sync left out", () => {
    const facts = serverFacts({ snapshots: [], offBox: offBoxVerdict(nowhere, { now }), database: [] });
    expect(facts.map((fact) => [fact.value, fact.status])).toEqual([["none yet", "warning"], ["nowhere set up", "warning"], ["no backup yet", "warning"]]);
    expect(serverFacts({ snapshots: [{ createdAt: null }], offBox: offBoxVerdict({ ...nowhere, cloud: { configured: true, lastSyncAt: null } }, { now }), database: [{ createdAt: hoursAgo(5), restoreDrill: null }] }).map((fact) => [fact.value, fact.status]))
      .toEqual([["taken, date not recorded", undefined], ["never sent", "warning"], ["not drilled,", "warning"]]);
    expect(serverFacts({ snapshots: [], offBox: offBoxVerdict(driveSynced(15, 1), { now }), database: [] })[1]).toEqual({ id: "offbox", label: "Off this server", value: "1 file left out,", at: hoursAgo(15), status: "warning" });
  });

  it("says not read, with no status but unknown, for each thing that did not come back", () => {
    expect(serverFacts({ snapshots: null, offBox: null, database: null }).map((fact) => [fact.value, fact.at, fact.status])).toEqual([["not read", null, "unknown"], ["not read", null, "unknown"], ["not read", null, "unknown"]]);
  });
});

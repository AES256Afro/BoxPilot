import { describe, expect, it } from "vitest";
import { registry } from "./ops/index.mjs";
import { dnsServerFrom, scanRemediations } from "./remediations-scan.mjs";

/**
 * The scan both `GET /remediations` and the agents' `repair.findings` go through (M52.1). The
 * detectors have their own tests; what is held here is the assembly around them: that the clock it
 * is given is the clock its findings are aged against, which reads an operator's scan makes and a
 * viewer's does not, what it says when a read fails, where each fix's tier comes from, and which
 * clean-up an app's disappearance is laid at.
 */

/** A clock well in the past, so anything aged against the wall clock instead is plainly wrong. */
const fixed = Date.parse("2026-10-05T09:00:00.000Z");
const now = () => fixed;
const days = (count) => new Date(fixed - count * 86_400_000).toISOString();

/** The helper, answering only what a test sets, and recording what was asked of it. */
function fakeHelper(answers = {}) {
  const asked = [];
  return {
    asked,
    request(id) {
      asked.push(id);
      const answer = answers[id];
      if (answer === undefined) return Promise.resolve({ available: true });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
}

function fakeState(settings = {}, schedules = []) {
  return { getSetting: (key, fallback) => settings[key] ?? fallback, listSchedules: () => schedules };
}

/** A scan with nothing wrong, which each test bends in one direction. */
function scan({ helper = null, settings = {}, schedules = [], manifests = [], applications = [], protection = null, jobs = [], operatorReads = false } = {}) {
  const asking = helper ?? fakeHelper({ "app.inspect": { available: true, applications }, "app.backup.protection": protection ?? { available: true, apps: [] } });
  return scanRemediations({
    helper: asking,
    state: fakeState(settings, schedules),
    catalogService: { all: () => Promise.resolve({ manifests }) },
    collect: () => Promise.resolve({ available: true, mounts: [], devices: [], fstab: [] }),
    fileExists: () => Promise.resolve(true),
    readListeners: () => [],
    notifications: { describe: () => ({ configured: true }) },
    inspectNames: () => Promise.resolve({ available: true }),
    hostname: "box",
    operatorReadsWanted: operatorReads,
    visibleJobsGiven: jobs,
    now,
  });
}

/** A backup-protection answer for one app whose newest copy is `age` days old on the fixed clock. */
const protectionAged = (age) => ({ available: true, apps: [{ id: "immich", name: "Immich", protectable: true, backups: 1, newestAt: days(age) }] });

describe("the clock the scan is given", () => {
  it("ages the findings against it, not against the wall clock", async () => {
    // Four days old on the fixed clock, and a month old against the real one. The staleness window
    // is fourteen days: a scan that reached for Date.now() would report this app as overdue.
    const fresh = await scan({ helper: fakeHelper({ "app.inspect": { available: true, applications: [] }, "app.backup.protection": protectionAged(4) }) });
    expect(fresh.findings.map((entry) => entry.id)).not.toContain("backups-due");

    const stale = await scan({ helper: fakeHelper({ "app.inspect": { available: true, applications: [] }, "app.backup.protection": protectionAged(40) }) });
    expect(stale.findings.map((entry) => entry.id)).toContain("backups-due");
  });

  it("stamps the answer with it", async () => {
    const scanned = await scan();
    expect(scanned.checkedAt).toBe(new Date(fixed).toISOString());
  });
});

describe("what an operator's scan reads and a viewer's does not", () => {
  const operatorOnly = ["samba.inspect", "storage.usb.events", "storage.unclean.events", "storage.volumes.state"];

  it("makes none of the operator reads for a viewer, and says which checks that leaves out", async () => {
    const helper = fakeHelper({ "app.inspect": { available: true, applications: [] }, "app.backup.protection": { available: true, apps: [] } });
    const scanned = await scan({ helper });
    for (const read of operatorOnly) expect(helper.asked).not.toContain(read);
    expect(scanned.sourceStatus).toBe("partial");
    expect(scanned.unavailableChecks).toEqual(expect.arrayContaining(["File sharing (needs an operator)", "USB history (needs an operator)", "Unclean unmounts (needs an operator)", "Drive filesystems (needs an operator)"]));
  });

  it("makes them for an operator, and then nothing is missing", async () => {
    const helper = fakeHelper({ "app.inspect": { available: true, applications: [] }, "app.backup.protection": { available: true, apps: [] } });
    const scanned = await scan({ helper, operatorReads: true });
    for (const read of operatorOnly) expect(helper.asked).toContain(read);
    expect(scanned.unavailableChecks).toEqual([]);
    expect(scanned.sourceStatus).toBe("ready");
  });
});

describe("a read that fails", () => {
  it("is named rather than passed off as nothing wrong", async () => {
    const helper = fakeHelper({ "app.inspect": new Error("the helper is not answering"), "app.backup.protection": { available: false } });
    const scanned = await scan({ helper });
    expect(scanned.unavailableChecks).toEqual(expect.arrayContaining(["Applications", "App backups"]));
    expect(scanned.sourceStatus).toBe("partial");
  });

  it("is named when the catalog cannot be read", async () => {
    const scanned = await scanRemediations({
      helper: fakeHelper({ "app.inspect": { available: true, applications: [] }, "app.backup.protection": { available: true, apps: [] } }),
      state: fakeState(),
      catalogService: { all: () => Promise.reject(new Error("no catalog")) },
      collect: () => Promise.resolve({ available: true, mounts: [], devices: [], fstab: [] }),
      fileExists: () => Promise.resolve(true),
      readListeners: () => [],
      inspectNames: () => Promise.resolve({ available: true }),
      hostname: "box",
      now,
    });
    expect(scanned.unavailableChecks).toContain("Application definitions");
  });
});

describe("each fix's risk tier", () => {
  it("comes from the registry, not from the detector", async () => {
    const scanned = await scan({ helper: fakeHelper({ "app.inspect": { available: true, applications: [] }, "app.backup.protection": protectionAged(40) }) });
    const due = scanned.findings.find((entry) => entry.id === "backups-due");
    expect(due.fix.risk).toBe(registry.get(due.fix.operationId).risk);
    for (const fix of due.fixes) expect(fix.risk).toBe(registry.get(fix.operationId)?.risk ?? "high");
  });
});

describe("which clean-up removed an app's container (M52.2)", () => {
  const gone = [{ id: "immich", installed: true, container: { exists: false }, state: { installedAt: days(30) } }];
  const stopped = { appStops: { immich: { at: days(3) } } };
  const prune = (at) => [{ id: "job-1", type: "op:docker.prune", state: "completed", createdAt: at, updatedAt: at }];

  /** A daily clean-up at 23:58 local time, and the job it started two minutes into the next hour. */
  const lateNight = new Date(fixed);
  lateNight.setHours(23, 58, 0, 0);
  const justAfter = new Date(lateNight.getTime() + 3 * 60_000);

  it("is the schedule's when its job started a few minutes late, across the hour", async () => {
    const scanned = await scan({
      helper: fakeHelper({ "app.inspect": { available: true, applications: gone }, "app.backup.protection": { available: true, apps: [] } }),
      settings: stopped,
      schedules: [{ operationId: "docker.prune", frequency: "daily", hour: 23, minute: 58 }],
      jobs: prune(justAfter.toISOString()),
    });
    const finding = scanned.findings.find((entry) => entry.id.startsWith("app-missing:"));
    expect(`${finding.title} ${finding.detail}`).toContain("the nightly clean-up");
  });

  it("is nobody's schedule when a weekly clean-up's time comes round on another day", async () => {
    // The weekly clean-up runs on the weekday after this job's, at the same hour and minute: the
    // clock alone used to match it.
    const ranAt = new Date(fixed);
    ranAt.setHours(4, 30, 0, 0);
    const scanned = await scan({
      helper: fakeHelper({ "app.inspect": { available: true, applications: gone }, "app.backup.protection": { available: true, apps: [] } }),
      settings: stopped,
      schedules: [{ operationId: "docker.prune", frequency: "weekly", weekday: (ranAt.getDay() + 1) % 7, hour: 4, minute: 30 }],
      jobs: prune(ranAt.toISOString()),
    });
    const finding = scanned.findings.find((entry) => entry.id.startsWith("app-missing:"));
    expect(`${finding.title} ${finding.detail}`).toContain("Docker's clean-up");
    expect(`${finding.title} ${finding.detail}`).not.toContain("clean-up that runs");
  });

  it("is the schedule's when the schedule names the job itself", async () => {
    const ranAt = new Date(fixed);
    ranAt.setHours(11, 11, 0, 0);
    const scanned = await scan({
      helper: fakeHelper({ "app.inspect": { available: true, applications: gone }, "app.backup.protection": { available: true, apps: [] } }),
      settings: stopped,
      schedules: [{ operationId: "docker.prune", frequency: "daily", hour: 3, minute: 0, lastJobId: "job-1" }],
      jobs: prune(ranAt.toISOString()),
    });
    const finding = scanned.findings.find((entry) => entry.id.startsWith("app-missing:"));
    expect(`${finding.title} ${finding.detail}`).toContain("the nightly clean-up");
  });
});

describe("the DNS app the rest of the house asks", () => {
  it("is the installed blocker, at the address its port 53 is published on", () => {
    const live = { applications: [{ id: "pi-hole", installed: true, published: [{ host: 53, bind: "192.168.1.10" }], container: { running: true } }] };
    expect(dnsServerFrom(live, [{ id: "pi-hole", name: "Pi-hole" }])).toEqual({ name: "Pi-hole", address: "192.168.1.10", running: true });
  });

  it("falls back to this server when the port is published on every address", () => {
    const live = { applications: [{ id: "pi-hole", installed: true, published: [{ host: 53, bind: "0.0.0.0" }], container: { running: true } }] };
    expect(dnsServerFrom(live)).toMatchObject({ address: "127.0.0.1", name: "pi-hole" });
  });

  it("counts a paused blocker as not running", () => {
    const live = { applications: [{ id: "pi-hole", installed: true, published: [{ host: 53 }], container: { running: true, status: "paused" } }] };
    expect(dnsServerFrom(live)).toMatchObject({ running: false });
  });

  it("is nothing when no blocker is installed", () => {
    expect(dnsServerFrom({ applications: [{ id: "pi-hole", installed: false }] })).toBeNull();
  });
});

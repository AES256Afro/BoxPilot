/**
 * What can be reclaimed, and what must never be.
 *
 * The value of this feature is entirely in what it refuses to remove, so that is what these pin:
 * the release a failed update rolls back to, images something still uses, and the newest backups.
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHousekeepingService } from "./housekeeping.mjs";
import { housekeepingRemoveTrees } from "./tasks/housekeeping.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture({ runUnitFails = false, treeScanLimits = {}, snapshotArchives = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-housekeeping-"));
  directories.push(root);
  const installRoot = path.join(root, "opt");
  const now = Date.parse("2026-08-22T12:00:00.000Z");

  // Leftover trees from past upgrades under every naming scheme, plus the live one. The real host
  // carries all six: `.prev.` is only what today's updater writes, and it prunes nothing else.
  await mkdir(path.join(installRoot, "boxpilot"), { recursive: true });
  await writeFile(path.join(installRoot, "boxpilot", "server.mjs"), "live");
  for (const [name, ageDays] of [
    ["boxpilot.prev.20260822T100000Z", 0],
    ["boxpilot.failed.20260822T090000Z", 1],
    ["boxpilot.rollback-0.50.0-abc", 30],
    ["boxpilot-candidate-0.44.0-20260817T0000Z", 40],
    ["boxpilot-live-before-0.38.0-20260816T080905Z", 50],
    ["boxpilot-prev-0.40.0-20260816T093600Z", 60],
  ]) {
    await mkdir(path.join(installRoot, name), { recursive: true });
    await writeFile(path.join(installRoot, name, "server.mjs"), "x".repeat(1024));
    const when = new Date(now - ageDays * 86_400_000);
    await utimes(path.join(installRoot, name), when, when);
  }

  const applicationBackupRoot = path.join(root, "backups", "catalog");
  await mkdir(path.join(applicationBackupRoot, "jellyfin"), { recursive: true });
  for (const stamp of ["20260801T000000Z", "20260810T000000Z", "20260815T000000Z", "20260820T000000Z", "20260822T000000Z"]) {
    await writeFile(path.join(applicationBackupRoot, "jellyfin", `${stamp}.tar.gz`), "archive");
    await writeFile(path.join(applicationBackupRoot, "jellyfin", `${stamp}.json`), "{}");
  }

  const catalogRoot = path.join(root, "catalog");
  await mkdir(path.join(catalogRoot, "jellyfin", "data.replaced"), { recursive: true });
  await writeFile(path.join(catalogRoot, "jellyfin", "data.replaced", "old"), "leftover");
  await mkdir(path.join(catalogRoot, "jellyfin", "data"), { recursive: true });
  await writeFile(path.join(catalogRoot, "jellyfin", "data", "live"), "in use");
  await mkdir(path.join(catalogRoot, "jellyfin.replaced"), { recursive: true });
  await writeFile(path.join(catalogRoot, "jellyfin.replaced", "original"), "only recoverable original");

  const jobLogDirectory = path.join(root, "job-logs");
  await mkdir(jobLogDirectory, { recursive: true });
  const oldLog = path.join(jobLogDirectory, "11111111-1111-4111-8111-111111111111.log");
  const freshLog = path.join(jobLogDirectory, "22222222-2222-4222-8222-222222222222.log");
  await writeFile(oldLog, "old output");
  await writeFile(freshLog, "recent output");
  await utimes(oldLog, new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));

  // Machine snapshots as `tar -O` reads them: { artifact: { "./manifest.json": {...}, ... } }, or
  // null for an archive that cannot be read.
  const machineSnapshotRoot = path.join(root, "machine-snapshots");
  await mkdir(machineSnapshotRoot, { recursive: true });
  for (const name of Object.keys(snapshotArchives)) await writeFile(path.join(machineSnapshotRoot, name), "snapshot");
  const run = vi.fn(async (binary, args) => {
    if (binary === "/fixture/tar") {
      const members = snapshotArchives[path.basename(args[1])];
      const member = members?.[args.at(-1)];
      return member ? { ok: true, stdout: JSON.stringify(member), stderr: "" } : { ok: false, stdout: "", stderr: "tar: damaged" };
    }
    if (args[0] === "images" && args.includes("dangling=true")) return { ok: true, stdout: "sha9\t300MB\nsha8\t100MB", stderr: "" };
    if (args[0] === "images") return { ok: true, stdout: "jellyfin/jellyfin:10.11.11\tsha1\t1.7GB\njellyfin/jellyfin:10.10.7\tsha2\t1.7GB\nold/removed-app:1.0\tsha3\t500MB", stderr: "" };
    if (args[0] === "ps") return { ok: true, stdout: "jellyfin/jellyfin:10.11.11", stderr: "" };
    if (args[0] === "system" && args[1] === "df") {
      return { ok: true, stdout: [JSON.stringify({ Type: "Images", Size: "5GB", Reclaimable: "2GB (40%)" }), JSON.stringify({ Type: "Build Cache", Size: "600MB", Reclaimable: "600MB" })].join("\n"), stderr: "" };
    }
    return { ok: true, stdout: "Total reclaimed space: 2GB", stderr: "" };
  });

  // The real thing removes /opt trees through the root task runner, because the helper runs with
  // /opt read-only. The fake runs the actual task so the test covers its checks too.
  const runUnit = { runTask: async (name, parameters) => {
    if (runUnitFails) throw new Error("EROFS: read-only file system");
    if (name !== "housekeeping.remove-trees") throw new Error(`unexpected task ${name}`);
    return housekeepingRemoveTrees(parameters);
  } };
  const service = createHousekeepingService({
    run, runUnit, treeScanLimits, installRoot, currentTree: path.join(installRoot, "boxpilot"),
    catalogRoot, applicationBackupRoot, jobLogDirectory, machineSnapshotRoot, tarBinary: "/fixture/tar",
    apps: { inspect: async () => ({ applications: [{ id: "jellyfin", installed: true, installedImage: "jellyfin/jellyfin:10.11.11" }] }) },
    now: () => new Date(now),
  });
  return { service, root, installRoot, catalogRoot, applicationBackupRoot, jobLogDirectory, run };
}

describe("finding what can be reclaimed", () => {
  it("retains useful categories when filesystem work exceeds its shared budget", async () => {
    const { service } = await fixture({ treeScanLimits: { maxEntries: 1 } });
    const report = await service.inspect();
    const releases = report.categories.find((category) => category.id === "boxpilot-versions");
    expect(releases.safe).toBe(false);
    expect(releases.unavailable).toContain("budget");
    expect(report.categories.find((category) => category.id === "docker-unused").safe).toBe(true);
    expect(report.totalBytes).toBe(report.categories.filter((category) => category.safe).reduce((sum, category) => sum + category.bytes, 0));
    const cleanup = await service.reclaim({ targets: ["boxpilot-versions", "docker-unused"] });
    expect(cleanup.failures.map((entry) => entry.category)).toContain("boxpilot-versions");
    expect(cleanup.removed.some((entry) => entry.category === "docker-unused")).toBe(true);
  });

  it("keeps the newest version you could revert to, and the last failure's evidence", async () => {
    const { service } = await fixture();
    const report = await service.inspect();
    const trees = report.categories.find((category) => category.id === "boxpilot-versions");
    expect(trees.keeping).toEqual(["boxpilot.prev.20260822T100000Z", "boxpilot.failed.20260822T090000Z"]);
    expect(trees.items).toBe(4); // six leftovers, two kept
    for (const kept of trees.keeping) expect(trees.detail).not.toContain(kept);
  });

  it("offers the leftovers from updaters BoxPilot no longer ships", async () => {
    const { service } = await fixture();
    const report = await service.inspect();
    const trees = report.categories.find((category) => category.id === "boxpilot-versions");
    // The upgrade script only ever pruned its own `.prev.` trees, so these accumulated unseen.
    expect(trees.detail).toEqual(expect.arrayContaining([
      "boxpilot.rollback-0.50.0-abc",
      "boxpilot-candidate-0.44.0-20260817T0000Z",
      "boxpilot-live-before-0.38.0-20260816T080905Z",
      "boxpilot-prev-0.40.0-20260816T093600Z",
    ]));
    expect(trees.detail).not.toContain("boxpilot");
  });

  // An update stopped during its build left /opt/boxpilot.staging.<stamp>, a whole copy of BoxPilot
  // that nothing listed. It is no one's evidence, so it never takes the failed tree's place as the
  // one kept; and one changed in the last few hours may be an update building right now.
  it("offers a staging tree an update never finished, but not in place of the failure's evidence, nor one still building", async () => {
    const { service, installRoot } = await fixture();
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    for (const [name, ageHours] of [["boxpilot.staging.20260821T230000Z", 13], ["boxpilot.staging.20260822T115000Z", 0.2]]) {
      await mkdir(path.join(installRoot, name, "node_modules"), { recursive: true });
      await writeFile(path.join(installRoot, name, "package.json"), "x".repeat(512));
      const when = new Date(now - ageHours * 3_600_000);
      await utimes(path.join(installRoot, name), when, when);
    }
    const trees = (await service.inspect()).categories.find((category) => category.id === "boxpilot-versions");
    expect(trees.keeping).toEqual(["boxpilot.prev.20260822T100000Z", "boxpilot.failed.20260822T090000Z", "boxpilot.staging.20260822T115000Z"]);
    expect(trees.detail).toContain("boxpilot.staging.20260821T230000Z");
    expect(trees.items).toBe(5);

    await service.reclaim({ targets: ["boxpilot-versions"] });
    await expect(stat(path.join(installRoot, "boxpilot.staging.20260821T230000Z"))).rejects.toThrow();
    await expect(stat(path.join(installRoot, "boxpilot.staging.20260822T115000Z"))).resolves.toBeTruthy();
    await expect(stat(path.join(installRoot, "boxpilot.failed.20260822T090000Z"))).resolves.toBeTruthy();
  });

  it("counts an image nothing uses, and never one an app is running", async () => {
    const { service } = await fixture();
    const images = (await service.inspect()).categories.find((category) => category.id === "docker-unreferenced-images");
    expect(images.detail.join(" ")).toContain("jellyfin/jellyfin:10.10.7"); // superseded by an update
    expect(images.detail.join(" ")).toContain("old/removed-app:1.0");
    expect(images.detail.join(" ")).not.toContain("10.11.11"); // the version actually installed
  });

  it("keeps the newest backups of each app and only offers what is behind them", async () => {
    const { service } = await fixture();
    const backups = (await service.inspect()).categories.find((category) => category.id === "app-backups");
    expect(backups.items).toBe(2); // five archives, three kept
  });

  it("keeps an older backup a retained machine snapshot would restore from", async () => {
    // A machine snapshot restores each app from the newest backup that existed when it was taken.
    const { service, applicationBackupRoot } = await fixture({ snapshotArchives: {
      "machine-snapshot-20260811T000000Z-abcdef01.tar.gz": {
        "./manifest.json": { contents: { apps: [{ id: "jellyfin", installed: true }] } },
        "./apps/jellyfin/backups.json": { id: "jellyfin", backups: [{ artifact: "20260810T000000Z.tar.gz" }, { artifact: "20260801T000000Z.tar.gz" }] },
      },
    } });
    const backups = (await service.inspect()).categories.find((category) => category.id === "app-backups");
    expect(backups.items).toBe(1);
    const result = await service.reclaim({ targets: ["app-backups"] });
    expect(result.removed.map((entry) => entry.what)).toEqual(["jellyfin/20260801T000000Z.tar.gz"]);
    await expect(stat(path.join(applicationBackupRoot, "jellyfin", "20260810T000000Z.tar.gz"))).resolves.toBeTruthy();
  });

  it("offers no application backup when a machine snapshot's references cannot be read", async () => {
    const { service, applicationBackupRoot } = await fixture({ snapshotArchives: { "machine-snapshot-20260811T000000Z-abcdef01.tar.gz": null } });
    const result = await service.reclaim({ targets: ["app-backups"] });
    expect(result.failures.map((entry) => entry.category)).toContain("app-backups");
    await expect(stat(path.join(applicationBackupRoot, "jellyfin", "20260801T000000Z.tar.gz"))).resolves.toBeTruthy();
  });

  it("does not let pre-change checkpoints push the owner's own backups out", async () => {
    const { service, applicationBackupRoot } = await fixture();
    // The three newest are checkpoints taken before settings changes; the two older are the owner's.
    for (const stamp of ["20260815T000000Z", "20260820T000000Z", "20260822T000000Z"]) {
      await writeFile(path.join(applicationBackupRoot, "jellyfin", `${stamp}.json`), JSON.stringify({ checkpoint: { reason: "settings change" } }));
    }
    const backups = (await service.inspect()).categories.find((category) => category.id === "app-backups");
    expect(backups.items).toBe(0);
  });

  // R3B3-7: what a machine snapshot or a restore of one leaves when it is cut off holds the
  // controller database and every app's .env in the clear. The helper sweeps it when it starts;
  // anything still there is listed here, and can be cleared.
  it("lists what a cut-off machine snapshot or restore left, and clears only that", async () => {
    const { service, root } = await fixture();
    const snapshots = path.join(root, "machine-snapshots");
    const staging = ".staging-11111111-1111-4111-8111-111111111111";
    await mkdir(path.join(snapshots, staging, "apps", "jellyfin"), { recursive: true });
    await writeFile(path.join(snapshots, staging, "apps", "jellyfin", ".env"), "API_KEY=secret\n");
    await writeFile(path.join(snapshots, "machine-snapshot-20260821T020000Z-11111111.tar.gz.partial"), "half an archive");
    await mkdir(path.join(snapshots, "restored", "20260821T030000Z"), { recursive: true });
    await writeFile(path.join(snapshots, "restored", "20260821T030000Z", "fstab"), "# fstab\n");
    const category = (await service.inspect()).categories.find((entry) => entry.id === "snapshot-leftovers");
    expect(category).toMatchObject({ items: 2, safe: true, bytes: "API_KEY=secret\n".length + "half an archive".length });
    expect([...category.detail].sort()).toEqual([staging, "machine-snapshot-20260821T020000Z-11111111.tar.gz.partial"].sort());
    const result = await service.reclaim({ targets: ["snapshot-leftovers"] });
    expect(result.failures).toEqual([]);
    expect(result.removed.filter((entry) => entry.category === "snapshot-leftovers")).toHaveLength(2);
    // What a finished restore staged for review is not a leftover.
    expect(await readdir(snapshots)).toEqual(["restored"]);
  });

  it("offers a log older than the history but not a recent one", async () => {
    const { service } = await fixture();
    const logs = (await service.inspect()).categories.find((category) => category.id === "job-logs");
    expect(logs.items).toBe(1);
  });
});

describe("reclaiming", () => {
  it("prunes only what nothing can be holding, never containers or networks", async () => {
    // `docker system prune` removes exited containers and the networks nothing running is joined
    // to. An app stopped from BoxPilot's own interface is both, and after a system prune Docker
    // refuses to start it again: the container is pinned to a network ID that is gone, which not
    // even `compose up` recovers from. Verified against Docker 29 on a real host.
    const { service, run } = await fixture();
    await service.reclaim({ targets: ["docker-unused"] });
    const pruned = run.mock.calls.map(([, args]) => args.join(" ")).filter((line) => line.includes("prune"));
    expect(pruned).toEqual(["image prune --force", "builder prune --force"]);
    expect(pruned.some((line) => /system|container|network|volume/.test(line))).toBe(false);
  });

  it("refuses a category it does not know rather than silently doing nothing", async () => {
    // The parameter arrives from the browser. Ignoring an id it does not recognise would report a
    // successful cleanup that removed nothing, which is the one answer worse than an error.
    const { service } = await fixture();
    await expect(service.reclaim({ targets: ["boxpilot-versions", "everything"] })).rejects.toThrow("everything");
  });

  it("says what it is removing as it goes", async () => {
    const { service } = await fixture();
    const lines = [];
    await service.reclaim({ targets: ["boxpilot-versions"], progress: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("keeping boxpilot.prev.20260822T100000Z and boxpilot.failed.20260822T090000Z");
    // The trees go in one task-runner call now, so the commentary is a summary rather than a
    // line each: the helper cannot write /opt itself.
    expect(lines.join("\n")).toContain("removed 4 of 4.");
  });

  it("clears what it can when one category fails, instead of stopping at the first error", async () => {
    // An /opt permission problem used to abort the whole run, leaving gigabytes of unused images
    // in place for a reason that had nothing to do with them.
    const { service } = await fixture({ runUnitFails: true });
    const result = await service.reclaim({ targets: ["boxpilot-versions", "docker-unused"] });
    expect(result.reclaimed).toBe(false);
    expect(result.failures.map((entry) => entry.category)).toEqual(["boxpilot-versions"]);
    // The Docker half still ran.
    expect(result.removed.some((entry) => entry.category === "docker-unused")).toBe(true);
  });

  it("removes only the categories named, and leaves live data alone", async () => {
    const { service, installRoot, catalogRoot, applicationBackupRoot } = await fixture();
    const result = await service.reclaim({ targets: ["boxpilot-versions", "restore-leftovers"] });
    expect(result.removed.map((entry) => entry.category)).toEqual(expect.arrayContaining(["boxpilot-versions"]));
    expect(result.failures.map((entry) => entry.category)).toContain("restore-leftovers");

    // Gone: the older trees and the unfinished restore.
    await expect(stat(path.join(installRoot, "boxpilot.rollback-0.50.0-abc"))).rejects.toThrow();
    await expect(stat(path.join(catalogRoot, "jellyfin", "data.replaced"))).resolves.toBeTruthy();
    await expect(stat(path.join(catalogRoot, "jellyfin.replaced", "original"))).resolves.toBeTruthy();
    // Kept: the live install, the rollback target, the app's real data, and every backup, because
    // those categories were not chosen.
    await expect(stat(path.join(installRoot, "boxpilot", "server.mjs"))).resolves.toBeTruthy();
    await expect(stat(path.join(installRoot, "boxpilot.prev.20260822T100000Z"))).resolves.toBeTruthy();
    await expect(stat(path.join(installRoot, "boxpilot.failed.20260822T090000Z"))).resolves.toBeTruthy();
    await expect(stat(path.join(catalogRoot, "jellyfin", "data", "live"))).resolves.toBeTruthy();
    await expect(stat(path.join(applicationBackupRoot, "jellyfin", "20260801T000000Z.tar.gz"))).resolves.toBeTruthy();
  });

  it("counts orphaned layers and the build cache, and not the images the other category offers", async () => {
    const { service } = await fixture();
    const report = await service.inspect();
    const docker = report.categories.find((category) => category.id === "docker-unused");
    // 300MB + 100MB dangling, plus a 600MB build cache. Docker's own "Images reclaimable" figure
    // of 2GB is every image no running container holds — which is what "Images no app uses"
    // offers separately, so counting it here would promise the same gigabytes twice.
    expect(docker.bytes).toBe(400 * 1000 ** 2 + 600 * 1000 ** 2);
  });

  it("never removes an image a container is using", async () => {
    const { service, run } = await fixture();
    await service.reclaim({ targets: ["docker-unreferenced-images"] });
    const removed = run.mock.calls.filter(([, args]) => args[0] === "rmi").map(([, args]) => args[1]);
    expect(removed).toEqual(expect.arrayContaining(["jellyfin/jellyfin:10.10.7", "old/removed-app:1.0"]));
    expect(removed).not.toContain("jellyfin/jellyfin:10.11.11");
  });

  it("reports actual restore siblings as protected and excludes them from reclaimable totals", async () => {
    const { service } = await fixture();
    const report = await service.inspect();
    const restores = report.categories.find((category) => category.id === "restore-leftovers");
    expect(restores.safe).toBe(false);
    expect(restores.detail).toEqual(["jellyfin: jellyfin.replaced"]);
    expect(report.totalBytes).toBe(report.categories.filter((category) => category.safe).reduce((sum, category) => sum + category.bytes, 0));
  });

  it("keeps all image aliases when a container names their image id", async () => {
    const { service, run } = await fixture();
    const original = run.getMockImplementation();
    run.mockImplementation(async (binary, args) => args[0] === "ps" ? { ok: true, stdout: "sha2", stderr: "" } : original(binary, args));
    await service.reclaim({ targets: ["docker-unreferenced-images"] });
    expect(run.mock.calls.filter(([, args]) => args[0] === "rmi").map(([, args]) => args[1])).toEqual(["old/removed-app:1.0"]);
  });

  it("refuses image cleanup when container inventory fails and reports uncertainty", async () => {
    const { service, run } = await fixture();
    const original = run.getMockImplementation();
    run.mockImplementation(async (binary, args) => args[0] === "ps" ? { ok: false, stdout: "", stderr: "unavailable" } : original(binary, args));
    const report = await service.inspect();
    expect(report.categories.find((category) => category.id === "docker-unreferenced-images").safe).toBe(false);
    const result = await service.reclaim({ targets: ["docker-unreferenced-images"] });
    expect(result.reclaimed).toBe(false);
    expect(run.mock.calls.some(([, args]) => args[0] === "rmi")).toBe(false);
  });
});


describe("where housekeeping looks for job logs", () => {
  it("is the directory the writer actually uses, not a second copy of the path", async () => {
    const { defaultJobLogDirectory } = await import("./job-log.mjs");
    const source = await import("node:fs/promises").then((fs) => fs.readFile("server/housekeeping.mjs", "utf8"));   // vitest runs from the repo root
    expect(source).toContain("defaultJobLogDirectory");
    expect(source).not.toContain("/var/lib/boxpilot/job-logs");
    expect(defaultJobLogDirectory).toBe("/run/boxpilot/logs");
  });
});

/**
 * The database copies updates take (M36). Nothing removes them on its own; the owner sets a rule,
 * reads the list and approves it, and the removal takes exactly that list, re-checked against the
 * same rule when it runs.
 */
describe("the database copies updates take", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  async function copiesFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-db-copies-"));
    directories.push(root);
    const state = path.join(root, "var-lib-boxpilot");
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, "boxpilot.sqlite3"), "live");
    await writeFile(path.join(state, "boxpilot.sqlite3-wal"), "live wal");
    await writeFile(path.join(state, "storage-health.json"), "{}");
    const names = [
      "boxpilot-rollback-1.121.0-20260816T101500Z.sqlite3",
      "boxpilot-rollback-1.121.0-20260816T101700Z.sqlite3",
      "boxpilot-rollback-1.126.0-20260901T101500Z.sqlite3",
      "boxpilot-rollback-1.131.0-20260928T101500Z.sqlite3",
      "boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3",
    ];
    for (const name of names) await writeFile(path.join(state, name), "x".repeat(1000));
    // One left open by something, with its WAL beside it; and one made by hand, dated by its file.
    await writeFile(path.join(state, `${names[0]}-wal`), "y".repeat(500));
    await writeFile(path.join(state, "boxpilot-rollback-by-hand.sqlite3"), "z".repeat(200));
    const handMade = new Date(now - 60 * 86_400_000);
    await utimes(path.join(state, "boxpilot-rollback-by-hand.sqlite3"), handMade, handMade);
    const service = createHousekeepingService({ run: vi.fn(), liveDatabase: path.join(state, "boxpilot.sqlite3"), now: () => new Date(now) });
    return { state, names, service };
  }

  it("lists every copy newest first, and says which a rule lets go of and why the rest stay", async () => {
    const { names, service } = await copiesFixture();
    const report = await service.databaseCopies({ keep: 2, keepDays: 30 });
    expect(report.copies.map((copy) => [copy.name, copy.goes, copy.keptBecause])).toEqual([
      [names[4], false, "newest"],
      [names[3], false, "newest"],
      [names[2], false, "recent"],
      [names[1], true, null],
      [names[0], true, null],
      ["boxpilot-rollback-by-hand.sqlite3", true, null],
    ]);
    expect(report.goes).toEqual([names[1], names[0], "boxpilot-rollback-by-hand.sqlite3"]);
    // Its WAL is part of the copy's size; the live database and other files are not copies at all.
    expect(report.copies.find((copy) => copy.name === names[0]).bytes).toBe(1500);
    expect(report.copies.some((copy) => copy.name.startsWith("boxpilot.sqlite3"))).toBe(false);
    expect(report.goesBytes).toBe(1000 + 1500 + 200);
  });

  it("marks the copies taken before the secret scrub, which may still hold passwords", async () => {
    const { service } = await copiesFixture();
    const report = await service.databaseCopies();
    const held = Object.fromEntries(report.copies.map((copy) => [copy.version, copy.heldSecrets]));
    expect(held).toMatchObject({ "1.121.0": true, "1.126.0": true, "1.131.0": false, "1.138.0": false, "by-hand": true });
    expect(report.rule).toEqual({ keep: 3, keepDays: 30 });
  });

  it("refuses a rule that would keep nothing, or a fraction", async () => {
    const { service } = await copiesFixture();
    await expect(service.databaseCopies({ keep: 0 })).rejects.toThrow(/keep must be a whole number from 1/);
    await expect(service.databaseCopies({ keepDays: 1.5 })).rejects.toThrow(/keepDays/);
  });

  it("removes exactly the listed copies the rule still lets go of, with anything beside them", async () => {
    const { state, names, service } = await copiesFixture();
    const said = [];
    const result = await service.removeDatabaseCopies({ keep: 2, keepDays: 20, names: [names[0], names[1]], progress: (line) => said.push(line) });
    expect(result.removed.sort()).toEqual([names[0], names[1]]);
    await expect(stat(path.join(state, names[0]))).rejects.toThrow();
    await expect(stat(path.join(state, `${names[0]}-wal`))).rejects.toThrow();
    // Not listed, so kept even though the rule would let it go; and the live database untouched.
    expect((await stat(path.join(state, "boxpilot-rollback-by-hand.sqlite3"))).isFile()).toBe(true);
    expect((await stat(path.join(state, "boxpilot.sqlite3"))).isFile()).toBe(true);
    expect((await stat(path.join(state, "boxpilot.sqlite3-wal"))).isFile()).toBe(true);
    expect(said.at(-1)).toMatch(/Removed 2 of 2/);
  });

  it("keeps a listed copy that the rule, applied again, now keeps", async () => {
    const { state, names, service } = await copiesFixture();
    // Listed under keep 2; by the time it runs the rule says keep 4, so names[1] is one of those.
    const result = await service.removeDatabaseCopies({ keep: 4, keepDays: 20, names: [names[1], names[0]] });
    expect(result.removed).toEqual([names[0]]);
    expect(result.kept).toEqual([{ name: names[1], reason: "now one of the newest 4" }]);
    expect((await stat(path.join(state, names[1]))).isFile()).toBe(true);
  });

  it("never touches a name that is not a copy, even if it is listed", async () => {
    const { state, service } = await copiesFixture();
    const result = await service.removeDatabaseCopies({ keep: 1, keepDays: 0, names: ["boxpilot.sqlite3", "../boxpilot.sqlite3", "storage-health.json"] });
    expect(result.removed).toEqual([]);
    expect(result.kept.every((entry) => entry.reason === "not among the copies")).toBe(true);
    expect((await stat(path.join(state, "boxpilot.sqlite3"))).isFile()).toBe(true);
    await expect(service.removeDatabaseCopies({ keep: 1, keepDays: 0, names: [] })).rejects.toThrow(/Name the copies/);
  });

  it("offers the removal to the owner only, as a medium-risk job that names each copy", async () => {
    const { registry } = await import("./ops/index.mjs");
    expect(registry.get("housekeeping.database-copies.remove")).toMatchObject({ risk: "medium", minimumRole: "owner", readOnly: false });
    expect(registry.validate("housekeeping.database-copies.remove", { keep: 3, keepDays: 30, names: ["boxpilot-rollback-1.121.0-20260816T101500Z.sqlite3"] })).toBeNull();
    expect(registry.validate("housekeeping.database-copies.remove", { keep: 3, keepDays: 30, names: ["boxpilot.sqlite3"] })).toMatch(/boxpilot-rollback/);
    expect(registry.validate("housekeeping.database-copies.remove", { keep: 0, keepDays: 30, names: ["boxpilot-rollback-x.sqlite3"] })).toMatch(/keep/);
    expect(registry.get("housekeeping.database-copies.inspect")).toMatchObject({ readOnly: true, minimumRole: "operator" });
  });
});

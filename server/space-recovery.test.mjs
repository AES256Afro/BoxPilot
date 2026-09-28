/**
 * Low-space recovery (M30.8): what the tools print, what a cleanup would take, and what it never may.
 *
 * The parsers read captured output (test/fixtures/space, placeholders only). The plan and the
 * cleanup run against a throwaway tree laid out like the host: journal folders, the job-log folder
 * and its database, APT's cache, with Docker and the root task runner stood in for.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows } from "../test/platform.mjs";
import {
  activeLogGraceMs, cleanupBounds, cleanupCategoryIds, createSpaceRecovery, journalVacuumArgs, parseDockerSystemDf, parseDuSummary,
  parseJournalDiskUsage, parseJournalFileName, parseJournalVacuum, planJournalFolder, spacePassMs,
} from "./space-recovery.mjs";
import { aptClean, journalVacuum } from "./tasks/space.mjs";
import { registry } from "./ops/index.mjs";
import { lowPriorityCommand } from "./scan-resources.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "space");
const fixture = (name) => readFile(path.join(fixtures, name), "utf8");
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const day = 86_400_000;
const now = Date.parse("2026-09-28T12:00:00.000Z");
const hex16 = (value) => value.toString(16).padStart(16, "0");
const sequence = "4a3b2c1d0e0f4a5b8c7d6e5f4a3b2c1d";
const machine = "0123456789abcdef0123456789abcdef";
/** An archived journal file as journald names it: sequence id, first sequence number, first entry's time. */
const archivedName = (seqnum, daysAgo, prefix = "system") => `${prefix}@${sequence}-${hex16(seqnum)}-${hex16((now - daysAgo * day) * 1000)}.journal`;
const corruptedName = (daysAgo) => `system@${hex16((now - daysAgo * day) * 1000)}-${hex16(7)}.journal~`;

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

describe("reading what the tools print", () => {
  it("reads journald's own total, in its current and older wording, in powers of 1024", async () => {
    expect(parseJournalDiskUsage(await fixture("journalctl-disk-usage.txt"))).toBe(Math.round(1.2 * GiB));
    expect(parseJournalDiskUsage(await fixture("journalctl-disk-usage-older.txt"))).toBe(Math.round(3.9 * GiB));
    expect(parseJournalDiskUsage("Archived and active journals take up 1016B in the file system.")).toBe(1016);
    expect(parseJournalDiskUsage("Archived and active journals take up 24.0M in the file system.")).toBe(24 * MiB);
    // Could not tell is not zero.
    expect(parseJournalDiskUsage("No journal files were found.")).toBeNull();
    expect(parseJournalDiskUsage("")).toBeNull();
  });

  it("reads which archived files a vacuum deleted and what it says it freed", async () => {
    const vacuum = parseJournalVacuum(await fixture("journalctl-vacuum.txt"));
    expect(vacuum.deleted.map((file) => path.posix.basename(file.path))).toEqual([
      `system@${sequence}-0000000000000001-00063f0a1b2c3d4e.journal`,
      `user-1000@${sequence}-0000000000000100-00063f0b1b2c3d4e.journal`,
      `system@${sequence}-0000000000000200-00063f0c1b2c3d4e.journal`,
    ]);
    expect(vacuum.deleted.map((file) => file.bytes)).toEqual([8 * MiB, 16 * MiB, 4 * 1024]);
    expect(vacuum.freedBytes).toBe(24 * MiB);
    expect(parseJournalVacuum("journalctl: permission denied").freedBytes).toBeNull();
  });

  it("reads docker system df in Docker's powers of 1000, volumes included", async () => {
    expect(parseDockerSystemDf(await fixture("docker-system-df.jsonl"))).toEqual([
      { type: "Images", total: 9, active: 4, bytes: 3_216_000_000, reclaimableBytes: 1_234_000_000, reclaimablePercent: 38 },
      { type: "Containers", total: 5, active: 4, bytes: 48_200_000, reclaimableBytes: 0, reclaimablePercent: 0 },
      { type: "Local Volumes", total: 6, active: 3, bytes: 4_100_000_000, reclaimableBytes: 512_500_000, reclaimablePercent: 12 },
      { type: "Build Cache", total: 7, active: 0, bytes: 221_300, reclaimableBytes: 221_300, reclaimablePercent: null },
    ]);
    expect(parseDockerSystemDf("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.")).toBeNull();
  });

  it("reads du's byte and inode totals for the APT cache", async () => {
    expect(parseDuSummary(await fixture("du-apt-bytes.txt")).get("/var/cache/apt")).toBe(187_404_288);
    expect(parseDuSummary(await fixture("du-apt-inodes.txt")).get("/var/cache/apt")).toBe(142);
    expect(parseDuSummary("du: cannot access '/var/cache/apt': No such file or directory").size).toBe(0);
  });
});

describe("the journal's own vacuum, modelled so the preview can name the files", () => {
  it("tells archived, corrupted and active journal files apart by name", () => {
    expect(parseJournalFileName(archivedName(3, 10))).toMatchObject({ kind: "archived", seqnumId: sequence, seqnum: 3n, realtimeUs: (now - 10 * day) * 1000 });
    expect(parseJournalFileName(corruptedName(60))).toMatchObject({ kind: "corrupted", realtimeUs: (now - 60 * day) * 1000 });
    expect(parseJournalFileName("system.journal")).toEqual({ kind: "active" });
    expect(parseJournalFileName("user-1000.journal")).toEqual({ kind: "active" });
    expect(parseJournalFileName("notes.txt")).toBeNull();
  });

  const folder = [
    { name: "system.journal", bytes: 64 * MiB },
    { name: "user-1000.journal", bytes: 8 * MiB },
    { name: archivedName(3, 10), bytes: 128 * MiB },
    { name: archivedName(1, 40), bytes: 128 * MiB },
    { name: archivedName(2, 20), bytes: 128 * MiB },
    { name: corruptedName(60), bytes: 16 * MiB },
    // Not a journal file: journald neither counts nor deletes it.
    { name: "notes.txt", bytes: 1 * GiB },
  ];
  const removed = (plan) => plan.remove.map((file) => file.name);

  it("takes archived files oldest first until the folder is within the size bound", () => {
    const plan = planJournalFolder(folder, { maxBytes: 256 * MiB, now });
    expect(removed(plan)).toEqual([corruptedName(60), archivedName(1, 40), archivedName(2, 20)]);
    expect(plan.remainingBytes).toBe(200 * MiB);
    expect(plan.kept.map((file) => file.name)).toEqual([archivedName(3, 10)]);
  });

  it("takes only files whose first entry is past the age bound, and meets both bounds when given both", () => {
    expect(removed(planJournalFolder(folder, { maxAgeDays: 30, now }))).toEqual([corruptedName(60), archivedName(1, 40)]);
    expect(removed(planJournalFolder(folder, { maxBytes: 400 * MiB, maxAgeDays: 30, now }))).toEqual([corruptedName(60), archivedName(1, 40)]);
    expect(removed(planJournalFolder(folder, { maxBytes: 300 * MiB, maxAgeDays: 30, now }))).toEqual([corruptedName(60), archivedName(1, 40), archivedName(2, 20)]);
    expect(removed(planJournalFolder(folder, { maxBytes: 4 * GiB, now }))).toEqual([]);
  });

  it("never takes an active file, even when the bound is below what the active files hold", () => {
    const plan = planJournalFolder(folder, { maxBytes: 64 * MiB, now });
    expect(plan.remove).toHaveLength(4);
    expect(plan.activeFiles).toBe(2);
    expect(plan.remainingBytes).toBe(72 * MiB);
  });

  it("orders one sequence by sequence number, as journald does, even when the clock disagrees", () => {
    const skewed = [{ name: archivedName(5, 10), bytes: 100 * MiB }, { name: archivedName(6, 50), bytes: 100 * MiB }];
    expect(removed(planJournalFolder(skewed, { maxBytes: 150 * MiB, now }))).toEqual([archivedName(5, 10)]);
  });

  it("gives the root task the exact arguments the preview names", () => {
    expect(journalVacuumArgs({ maxBytes: 512 * MiB, maxAgeDays: 30 })).toEqual([`--vacuum-size=${512 * MiB}`, "--vacuum-time=30d"]);
    expect(journalVacuumArgs({ maxAgeDays: 7 })).toEqual(["--vacuum-time=7d"]);
  });
});

describe("the bounds a cleanup accepts, and the refusals", () => {
  const problem = (parameters) => registry.validate("space.cleanup", parameters);

  it("is a medium-risk job behind a preview that takes the same parameters, and both reads need an operator", () => {
    expect(registry.get("space.cleanup")).toMatchObject({ risk: "medium", readOnly: false });
    expect(registry.get("space.cleanup.preview")).toMatchObject({ risk: "low", readOnly: true, minimumRole: "operator" });
    expect(registry.get("space.inspect")).toMatchObject({ risk: "low", readOnly: true, minimumRole: "operator" });
    expect(registry.get("space.cleanup.preview").parameters).toBe(registry.get("space.cleanup").parameters);
  });

  it("accepts bounded categories", () => {
    expect(problem({ categories: ["journal", "apt-cache", "docker-dangling", "job-logs"], journalMaxBytes: 512 * MiB, jobLogRetentionDays: 30 })).toBeNull();
    expect(problem({ categories: ["journal"], journalMaxAgeDays: 7 })).toBeNull();
    expect(problem({ categories: ["job-logs"] })).toBeNull();
  });

  it.each([
    [{ categories: ["backups"] }, "must name only"],
    [{ categories: ["docker-volumes"] }, "must name only"],
    [{ categories: [] }, "at least one"],
    [{ categories: ["apt-cache", "apt-cache"] }, "twice"],
    [{ categories: ["journal"] }, "size bound, an age bound, or both"],
    [{ categories: ["journal"], journalMaxBytes: null, journalMaxAgeDays: null }, "size bound, an age bound, or both"],
    [{ categories: ["journal"], journalMaxBytes: MiB }, `from ${cleanupBounds.journalMinBytes}`],
    [{ categories: ["journal"], journalMaxBytes: 1.5 * GiB + 0.5 }, "whole number"],
    [{ categories: ["journal"], journalMaxAgeDays: 0 }, "from 1"],
    [{ categories: ["job-logs"], jobLogRetentionDays: 0 }, "from 1"],
    [{ categories: ["apt-cache"], all: true }, "does not accept"],
  ])("refuses %j", (parameters, message) => {
    expect(problem(parameters)).toContain(message);
  });

  it("offers nothing that could take a volume, a tagged image or a backup", () => {
    expect(cleanupCategoryIds).toEqual(["journal", "job-logs", "apt-cache", "docker-dangling"]);
  });

  it("checks the bounds again in the root tasks, and runs journalctl and apt-get with exactly these arguments", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "Vacuuming done, freed 24.0M of archived journals from /var/log/journal/x." }));
    await expect(journalVacuum({}, { run })).rejects.toThrow("size bound, an age bound, or both");
    await expect(journalVacuum({ maxBytes: MiB }, { run })).rejects.toThrow("size bound");
    await expect(journalVacuum({ maxAgeDays: 0 }, { run })).rejects.toThrow("age bound");
    await expect(journalVacuum({ maxBytes: 512 * MiB, rotate: true }, { run })).rejects.toThrow("only maxBytes and maxAgeDays");
    await expect(aptClean({ purge: true }, { run })).rejects.toThrow("no parameters");
    expect(run).not.toHaveBeenCalled();
    expect(await journalVacuum({ maxBytes: 512 * MiB, maxAgeDays: 30 }, { run })).toMatchObject({ vacuumed: true, freedBytes: 24 * MiB });
    expect(run).toHaveBeenLastCalledWith("/usr/bin/journalctl", [`--vacuum-size=${512 * MiB}`, "--vacuum-time=30d"], expect.any(Object));
    expect(await aptClean({}, { run })).toEqual({ cleaned: true });
    expect(run).toHaveBeenLastCalledWith("/usr/bin/apt-get", ["clean"], expect.any(Object));
    await expect(aptClean({}, { run: async () => ({ ok: false, stdout: "", stderr: "E: Could not get lock /var/cache/apt/archives/lock." }) })).rejects.toThrow("Could not get lock");
  });
});

/**
 * A host in a temporary folder. Journal, job logs and APT cache are real files; Docker answers from
 * the captured fixtures; the root task runner deletes what journald and apt-get would.
 */
async function host({ docker = true, database = true, vacuumDeletes = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-space-"));
  directories.push(root);
  const write = async (file, bytes, ageDays = 0) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(bytes, 1));
    const when = new Date(now - ageDays * day);
    await utimes(file, when, when);
  };

  const journalRoot = path.join(root, "log-journal");
  const journal = path.join(journalRoot, machine);
  await write(path.join(journal, "system.journal"), 64 * 1024);
  await write(path.join(journal, archivedName(1, 40)), 128 * 1024);
  await write(path.join(journal, archivedName(2, 20)), 128 * 1024);
  await write(path.join(journal, archivedName(3, 2)), 128 * 1024);
  await write(path.join(journal, "notes.txt"), 999);

  const logs = path.join(root, "logs");
  const jobs = {
    oldCompleted: ["11111111-1111-4111-8111-111111111111", "completed", 30, 2000],
    recentCompleted: ["22222222-2222-4222-8222-222222222222", "completed", 3, 2000],
    oldFailed: ["33333333-3333-4333-8333-333333333333", "failed", 30, 3000],
    stuck: ["44444444-4444-4444-8444-444444444444", "applying", 30, 4000],
    unlisted: ["55555555-5555-4555-8555-555555555555", null, 200, 5000],
    // A completed job's log that something wrote to minutes ago: never a candidate.
    justWritten: ["66666666-6666-4666-8666-666666666666", "completed", 10 / (24 * 60), 6000],
  };
  for (const [id, , ageDays, bytes] of Object.values(jobs)) await write(path.join(logs, `${id}.log`), bytes, ageDays);
  // The helper's folder is 0750 and its files 0640, root's; here they are this account's.
  await chmod(logs, 0o750);
  for (const name of await readdir(logs)) await chmod(path.join(logs, name), 0o640);
  const databasePath = path.join(root, "state.sqlite3");
  if (database) {
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, state TEXT); CREATE TABLE job_output(job_id TEXT PRIMARY KEY, output TEXT)");
    for (const [id, state, , bytes] of Object.values(jobs)) {
      if (!state) continue;
      db.prepare("INSERT INTO jobs VALUES (?, ?)").run(id, state);
      db.prepare("INSERT INTO job_output VALUES (?, ?)").run(id, "x".repeat(bytes));
    }
    db.close();
  }

  const apt = path.join(root, "cache-apt");
  await write(path.join(apt, "archives", "openssl_3.0.13-0ubuntu3_amd64.deb"), 1500);
  await write(path.join(apt, "archives", "curl_8.5.0-2ubuntu10_amd64.deb"), 400);
  await write(path.join(apt, "archives", "lock"), 0);
  await write(path.join(apt, "archives", "partial", "vim_9.1_amd64.deb.FAILED"), 50);
  await write(path.join(apt, "pkgcache.bin"), 300);
  await write(path.join(apt, "srcpkgcache.bin"), 200);
  const listsPartial = path.join(root, "lists-partial");

  const dockerRoot = path.join(root, "docker");
  await mkdir(dockerRoot);
  let pruned = false;
  const df = await fixture("docker-system-df.jsonl");
  const run = vi.fn(async (program, programArgs) => {
    // du runs behind ionice and nice (scan-resources.mjs): answer for the command they run.
    const [binary, args] = program.endsWith("/ionice") ? [programArgs[6], programArgs.slice(7)] : [program, programArgs];
    const ok = (stdout) => ({ ok: true, code: 0, stdout, stderr: "" });
    if (binary.endsWith("du")) return ok(args.includes("--inodes") ? `9\t${apt}` : `2560\t${apt}`);
    if (binary.endsWith("journalctl")) return ok((await fixture("journalctl-disk-usage.txt")).trim());
    if (!docker) return { ok: false, code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    const command = args.join(" ");
    if (command.startsWith("images --filter dangling=true")) return ok(pruned ? "cccccccccccc\t10MB" : "aaaaaaaaaaaa\t120MB\nbbbbbbbbbbbb\t80MB\ncccccccccccc\t10MB");
    if (command.startsWith("ps --all --no-trunc")) return ok(`example/web:1.2\nsha256:cccccccccccc${"d".repeat(52)}`);
    if (command.startsWith("system df")) return ok(pruned ? df.replace('"Size":"3.216GB"', '"Size":"3.016GB"') : df);
    if (command.startsWith("info --format")) return ok(dockerRoot);
    if (command === "image prune --force") { pruned = true; return ok("Deleted Images:\ndeleted: sha256:aaaaaaaaaaaa\ndeleted: sha256:bbbbbbbbbbbb\n\nTotal reclaimed space: 200MB"); }
    return { ok: false, code: 1, stdout: "", stderr: `unexpected docker ${command}` };
  });
  const runUnit = { runTask: vi.fn(async (task) => {
    if (task === "journal.vacuum") {
      const names = vacuumDeletes ?? [archivedName(1, 40), archivedName(2, 20)];
      for (const name of names) await rm(path.join(journal, name));
      return { vacuumed: true, deleted: names.length, freedBytes: names.length * 128 * 1024 };
    }
    if (task === "apt.clean") {
      for (const file of ["archives/openssl_3.0.13-0ubuntu3_amd64.deb", "archives/curl_8.5.0-2ubuntu10_amd64.deb", "archives/partial/vim_9.1_amd64.deb.FAILED", "pkgcache.bin", "srcpkgcache.bin"]) await rm(path.join(apt, file));
      return { cleaned: true };
    }
    throw new Error(`unexpected task ${task}`);
  }) };

  const backups = path.join(root, "backups");
  for (const [index, stamp] of ["20260901T000000Z", "20260908T000000Z", "20260915T000000Z", "20260922T000000Z", "20260927T000000Z"].entries()) {
    await write(path.join(backups, "catalog", "jellyfin", `${stamp}.tar.gz`), 1000 + index);
    await writeFile(path.join(backups, "catalog", "jellyfin", `${stamp}.json`), "{}");
  }
  const space = createSpaceRecovery({
    run, runUnit,
    journalRoots: [journalRoot, path.join(root, "run-log-journal")],
    aptCacheRoot: apt, aptListsPartial: listsPartial,
    jobLogDirectory: logs, databasePath,
    backupRoots: [
      { id: "application", title: "Application backups", path: path.join(backups, "catalog"), retention: "newest 3 of each kind" },
      { id: "machine-snapshots", title: "Machine snapshots", path: path.join(root, "not-created"), retention: "newest 3" },
    ],
    expectedUid: process.getuid?.() ?? 0,
    usageOf: (info) => info.size,
    now: () => new Date(now),
    // As on an Ubuntu host with both tools, whatever machine runs the test.
    scanCommand: (binary, args) => lowPriorityCommand(binary, args, { platform: "linux", executable: async () => true }),
  });
  return { root, journal, logs, jobs, apt, run, runUnit, space };
}

const byId = (list) => Object.fromEntries(list.map((entry) => [entry.id, entry]));

describe("where the space went", () => {
  it("attributes bytes and inodes to the journal, job logs, the APT cache, Docker and local backups", async () => {
    const { space, run, apt } = await host();
    const report = await space.inspect();
    // du walks at idle IO priority and nice 10, as the app-data scan does.
    for (const measure of ["--block-size=1", "--inodes"]) {
      expect(run).toHaveBeenCalledWith("/usr/bin/ionice", ["-c", "3", "-t", "/usr/bin/nice", "-n", "10", "/usr/bin/du", "--summarize", "--one-file-system", measure, apt], expect.any(Object));
    }
    const categories = byId(report.categories);
    expect(categories.journal).toMatchObject({ available: true, bytes: 64 * 1024 + 3 * 128 * 1024, inodes: 5, detail: { journaldReportedBytes: Math.round(1.2 * GiB), activeFiles: 1, archivedFiles: 3 } });
    expect(categories["job-logs"]).toMatchObject({ available: true, bytes: 22_000, inodes: 6 });
    expect(categories["job-logs"].detail).toMatchObject({ retentionDays: 14, "past-retention": { count: 1, bytes: 2000 }, completed: { count: 1 }, failed: { count: 1 }, active: { count: 2 }, unlisted: { count: 1 } });
    expect(categories["apt-cache"]).toMatchObject({ available: true, bytes: 2560, inodes: 9, detail: { cleanableFiles: 5, cleanableBytes: 2450, packages: 2 } });
    expect(categories.docker).toMatchObject({ available: true, inodes: null, detail: { danglingImages: { count: 2, bytes: 200_000_000, usedByContainers: 1 } } });
    expect(categories.docker.detail.rows.find((row) => row.type === "Local Volumes").bytes).toBe(4_100_000_000);
    const [application, snapshots] = categories.backups.detail.roots;
    // Five archives of 1000-1004 bytes and their five two-byte records; the folder and the app's are inodes too.
    expect(application).toMatchObject({ bytes: 5020, files: 10, inodes: 12, beyondNewest: { count: 2, bytes: 2001, keepsPerKind: 3 } });
    expect(snapshots).toMatchObject({ bytes: null, unavailable: "Not created yet" });
    expect(report.filesystems.length).toBeGreaterThan(0);
    expect(report.filesystems[0]).toEqual(expect.objectContaining({ freeBytes: expect.any(Number), freeInodes: expect.any(Number), categories: expect.any(Array) }));
  });

  it("says a category it could not read is unavailable, never zero", async () => {
    const { space } = await host({ docker: false, database: false });
    const categories = byId((await space.inspect()).categories);
    expect(categories.docker).toMatchObject({ available: false, bytes: null, unavailable: "Docker did not answer" });
    expect(categories["job-logs"]).toMatchObject({ available: false, bytes: null, unavailable: "BoxPilot's job records could not be read" });
    expect(categories.journal.available).toBe(true);
  });

  it("walks folders for one deadline in all, not a fresh minute per folder, and ends inside the operation's budget", async () => {
    expect(spacePassMs).toBeLessThan(registry.get("space.inspect").timeoutMs);
    expect(spacePassMs).toBeLessThan(registry.get("space.cleanup.preview").timeoutMs);
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-space-pass-"));
    directories.push(root);
    const backupRoots = [];
    for (const id of ["database", "machine-snapshots", "vm-exports", "elsewhere"]) {
      await mkdir(path.join(root, id), { recursive: true });
      await writeFile(path.join(root, id, "archive.tar.gz"), Buffer.alloc(100, 1));
      backupRoots.push({ id, title: id, path: path.join(root, id), retention: "kept" });
    }
    // Measuring a file takes 40 seconds on this clock. Each folder alone is well within a walk's
    // own minute, but the four together are 160 seconds, past a pass of 100.
    let clock = 0;
    const missing = path.join(root, "missing");
    const space = createSpaceRecovery({
      run: async () => ({ ok: false, code: 1, stdout: "", stderr: "not here" }),
      journalRoots: [missing], aptCacheRoot: missing, aptListsPartial: missing, jobLogDirectory: missing, lookupJobs: async () => new Map(),
      backupRoots, usageOf: (info) => { clock += 40_000; return info.size; },
      treeScanLimits: { now: () => clock }, passMs: 100_000,
      scanCommand: async (binary, args) => ({ binary, args, priority: "default" }),
    });
    const roots = byId((await space.inspect()).categories).backups.detail.roots;
    expect(roots.map((entry) => entry.unavailable ?? entry.bytes)).toEqual([100, 100, 100, "Too large to measure in one pass"]);
    expect(clock).toBe(120_000);
  });
});

describe("the cleanup preview", () => {
  it("lists exactly what goes and what it frees, within the bounds, and says what stays", async () => {
    const { space, journal, jobs } = await host();
    const plan = await space.plan({ categories: ["journal", "job-logs", "apt-cache", "docker-dangling"], journalMaxAgeDays: 14, jobLogRetentionDays: 14 });
    const categories = byId(plan.categories);
    expect(categories.journal.items.map((item) => item.what)).toEqual([path.join(journal, archivedName(1, 40)), path.join(journal, archivedName(2, 20))]);
    expect(categories.journal).toMatchObject({ bytes: 2 * 128 * 1024, inodes: 2 });
    expect(categories.journal.bound).toContain("journalctl --vacuum-time=14d");
    expect(categories.journal.keeping[0]).toContain("1 active journal file");
    expect(categories["job-logs"].items.map((item) => item.what)).toEqual([`${jobs.oldCompleted[0]}.log`]);
    expect(categories["job-logs"].items[0].detail).toBe("Activity keeps its output");
    expect(categories["job-logs"].keeping.join(" ")).toMatch(/failed or cancelled/);
    expect(categories["apt-cache"].items.map((item) => path.basename(item.what)).sort()).toEqual(["curl_8.5.0-2ubuntu10_amd64.deb", "openssl_3.0.13-0ubuntu3_amd64.deb", "pkgcache.bin", "srcpkgcache.bin", "vim_9.1_amd64.deb.FAILED"]);
    expect(categories["apt-cache"].bytes).toBe(2450);
    expect(categories["docker-dangling"]).toMatchObject({ bytes: 200_000_000, inodes: null, items: [{ what: "aaaaaaaaaaaa", bytes: 120_000_000 }, { what: "bbbbbbbbbbbb", bytes: 80_000_000 }] });
    expect(categories["docker-dangling"].keeping.join(" ")).toContain("1 dangling image a container still uses");
    expect(plan.totalBytes).toBe(2 * 128 * 1024 + 2000 + 2450 + 200_000_000);
  });

  it("follows the bounds: a larger retention and a looser journal bound take less", async () => {
    const { space } = await host();
    const plan = byId((await space.plan({ categories: ["journal", "job-logs"], journalMaxBytes: 64 * MiB, jobLogRetentionDays: 60 })).categories);
    expect(plan.journal.items).toEqual([]);
    expect(plan["job-logs"].items).toEqual([]);
  });

  it("changes nothing", async () => {
    const { space, runUnit, run, journal, logs } = await host();
    const before = [await readdir(journal), await readdir(logs)];
    await space.plan({ categories: ["journal", "job-logs", "apt-cache", "docker-dangling"], journalMaxAgeDays: 1, jobLogRetentionDays: 1 });
    expect([await readdir(journal), await readdir(logs)]).toEqual(before);
    expect(runUnit.runTask).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([, args]) => args.includes("prune"))).toBe(false);
  });
});

describe("the cleanup", () => {
  // Linux only: the job logs are removed only when they are this account's and nobody else can write them.
  it.skipIf(onWindows)("removes what the preview listed, never an active or failed job's log, and measures what it freed", async () => {
    const { space, runUnit, run, logs, jobs } = await host();
    const say = vi.fn();
    const result = await space.cleanup({ categories: ["journal", "job-logs", "apt-cache", "docker-dangling"], journalMaxAgeDays: 14, jobLogRetentionDays: 14 }, { progress: say, jobLog: { path: "/run/boxpilot/logs/job.log" } });
    expect(result).toMatchObject({ cleaned: true, verified: true });
    const categories = byId(result.categories);
    expect(runUnit.runTask).toHaveBeenCalledWith("journal.vacuum", { maxBytes: null, maxAgeDays: 14 }, { timeoutMs: 600_000, logPath: "/run/boxpilot/logs/job.log" });
    expect(categories.journal).toMatchObject({ verified: true, freedBytes: 2 * 128 * 1024, stillThere: [] });
    expect(categories["apt-cache"]).toMatchObject({ verified: true, freedBytes: 2450 });
    expect(categories["job-logs"]).toMatchObject({ verified: true, removed: 1, freedBytes: 2000 });
    // Docker's own figure, and the Images total before and after.
    expect(categories["docker-dangling"]).toMatchObject({ verified: true, reportedFreedBytes: 200_000_000, freedBytes: 200_000_000 });
    expect(categories.journal.filesystem).toEqual(expect.objectContaining({ freeBytesBefore: expect.any(Number), freeBytesAfter: expect.any(Number) }));
    // Dangling images only: never --all, never a volume, never a system prune.
    const dockerCalls = run.mock.calls.filter(([binary]) => binary.endsWith("docker")).map(([, args]) => args.join(" "));
    expect(dockerCalls.filter((call) => call.includes("prune"))).toEqual(["image prune --force"]);
    const left = await readdir(logs);
    expect(left).not.toContain(`${jobs.oldCompleted[0]}.log`);
    for (const kept of [jobs.recentCompleted, jobs.oldFailed, jobs.stuck, jobs.unlisted, jobs.justWritten]) expect(left).toContain(`${kept[0]}.log`);
    expect(result.freedBytes).toBe(2 * 128 * 1024 + 2450 + 2000 + 200_000_000);
    expect(say).toHaveBeenCalledWith(expect.stringContaining("Done. Freed"), "stdout");
  });

  // Linux only: POSIX ownership and file modes.
  it.skipIf(onWindows)("checks each job log again at the moment it goes", async () => {
    const { space, logs, jobs } = await host();
    const [candidate] = (await space.internals.jobLogs()).filter((log) => log.jobId === jobs.oldCompleted[0]);
    const cutoffMs = now - 14 * day;
    // Written to since it was listed.
    const touched = new Date(now - 29 * day);
    await utimes(candidate.path, touched, touched);
    expect(await space.internals.removeJobLog(candidate, { cutoffMs })).toEqual({ removed: false, reason: "written to since it was listed" });
    // Only ever a log in the job log folder, under its own job's name.
    expect((await space.internals.removeJobLog({ ...candidate, path: path.join(logs, "..", "state.sqlite3") }, { cutoffMs })).reason).toBe("not in the job log folder");
    // Another account could have put it there.
    const [fresh] = (await space.internals.jobLogs()).filter((log) => log.jobId === jobs.oldCompleted[0]);
    await chmod(fresh.path, 0o666);
    expect((await space.internals.removeJobLog(fresh, { cutoffMs })).reason).toBe("not a file only root can write");
    await chmod(fresh.path, 0o640);
    await chmod(logs, 0o777);
    expect((await space.internals.removeJobLog(fresh, { cutoffMs })).reason).toBe("the log folder is not root's alone");
    await chmod(logs, 0o750);
    expect(await space.internals.removeJobLog(fresh, { cutoffMs })).toEqual({ removed: true, bytes: 2000 });
  });

  // Linux only: POSIX ownership and file modes.
  it.skipIf(onWindows)("keeps a log whose job is no longer recorded as completed when it comes to remove it", async () => {
    const { root, space: planned, jobs, logs } = await host();
    const [candidate] = (await planned.internals.jobLogs()).filter((log) => log.jobId === jobs.oldCompleted[0]);
    const space = createSpaceRecovery({ jobLogDirectory: logs, lookupJobs: () => new Map([[candidate.jobId, { state: "failed", savedBytes: 2000 }]]), expectedUid: process.getuid(), now: () => new Date(now), databasePath: path.join(root, "state.sqlite3") });
    expect(await space.internals.removeJobLog(candidate, { cutoffMs: now - 14 * day })).toEqual({ removed: false, reason: "its job is no longer recorded as completed" });
  });

  it("reports a planned file journald did not delete instead of claiming it", async () => {
    const { space } = await host({ vacuumDeletes: [archivedName(1, 40)] });
    const result = await space.cleanup({ categories: ["journal"], journalMaxAgeDays: 14 });
    const [journal] = result.categories;
    expect(journal).toMatchObject({ done: true, verified: false, freedBytes: 128 * 1024 });
    expect(journal.stillThere).toHaveLength(1);
    expect(result.verified).toBe(false);
  });

  it("does the rest and then fails, naming what it could not do, when a chosen category cannot be read", async () => {
    const { space, runUnit } = await host({ docker: false });
    await expect(space.cleanup({ categories: ["apt-cache", "docker-dangling"] })).rejects.toThrow(/Freed 2\.4 KiB, but not everything chosen was cleaned\. Dangling Docker images: Docker did not answer/);
    expect(runUnit.runTask).toHaveBeenCalledWith("apt.clean", {}, expect.any(Object));
  });

  it("removes no job log when the job records cannot be read", async () => {
    const { space, logs } = await host({ database: false });
    const before = await readdir(logs);
    await expect(space.cleanup({ categories: ["job-logs"], jobLogRetentionDays: 1 })).rejects.toThrow("BoxPilot's job records could not be read");
    expect(await readdir(logs)).toEqual(before);
  });

  it("refuses bounds the preview would refuse, before touching anything", async () => {
    const { space, runUnit } = await host();
    await expect(space.cleanup({ categories: ["journal"] })).rejects.toThrow("size bound, an age bound, or both");
    await expect(space.cleanup({ categories: ["backups"] })).rejects.toThrow("must name only");
    await expect(space.plan({ categories: ["job-logs"], jobLogRetentionDays: 0 })).rejects.toThrow("from 1");
    expect(runUnit.runTask).not.toHaveBeenCalled();
  });

  it("treats a log written in the last hour as active whatever its record says", () => {
    expect(activeLogGraceMs).toBe(60 * 60_000);
  });
});

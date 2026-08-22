/**
 * What can be reclaimed, and what must never be.
 *
 * The value of this feature is entirely in what it refuses to remove, so that is what these pin:
 * the release a failed update rolls back to, images something still uses, and the newest backups.
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHousekeepingService } from "./housekeeping.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-housekeeping-"));
  directories.push(root);
  const installRoot = path.join(root, "opt");
  const now = Date.parse("2026-08-22T12:00:00.000Z");

  // Three leftover trees from past upgrades, plus the live one.
  await mkdir(path.join(installRoot, "boxpilot"), { recursive: true });
  await writeFile(path.join(installRoot, "boxpilot", "server.mjs"), "live");
  for (const [name, ageDays] of [["boxpilot.prev.20260822T100000Z", 0], ["boxpilot.rollback-0.50.0-abc", 30], ["boxpilot-prev-0.40.0-20260816T093600Z", 60]]) {
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

  const jobLogDirectory = path.join(root, "job-logs");
  await mkdir(jobLogDirectory, { recursive: true });
  const oldLog = path.join(jobLogDirectory, "11111111-1111-4111-8111-111111111111.log");
  const freshLog = path.join(jobLogDirectory, "22222222-2222-4222-8222-222222222222.log");
  await writeFile(oldLog, "old output");
  await writeFile(freshLog, "recent output");
  await utimes(oldLog, new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));

  const run = vi.fn(async (_binary, args) => {
    if (args[0] === "images") return { ok: true, stdout: "jellyfin/jellyfin:10.11.11\tsha1\t1.7GB\njellyfin/jellyfin:10.10.7\tsha2\t1.7GB\nold/removed-app:1.0\tsha3\t500MB", stderr: "" };
    if (args[0] === "ps") return { ok: true, stdout: "jellyfin/jellyfin:10.11.11", stderr: "" };
    if (args[0] === "system" && args[1] === "df") return { ok: true, stdout: JSON.stringify({ Type: "Images", Size: "5GB", Reclaimable: "2GB" }), stderr: "" };
    return { ok: true, stdout: "Total reclaimed space: 2GB", stderr: "" };
  });

  const service = createHousekeepingService({
    run, installRoot, currentTree: path.join(installRoot, "boxpilot"),
    catalogRoot, applicationBackupRoot, jobLogDirectory,
    apps: { inspect: async () => ({ applications: [{ id: "jellyfin", installed: true, installedImage: "jellyfin/jellyfin:10.11.11" }] }) },
    now: () => new Date(now),
  });
  return { service, root, installRoot, catalogRoot, applicationBackupRoot, jobLogDirectory, run };
}

describe("finding what can be reclaimed", () => {
  it("keeps the release a failed update would roll back to", async () => {
    const { service } = await fixture();
    const report = await service.inspect();
    const trees = report.categories.find((category) => category.id === "boxpilot-versions");
    expect(trees.items).toBe(2); // three leftovers, newest kept
    expect(trees.keeping).toEqual(["boxpilot.prev.20260822T100000Z"]);
    expect(trees.detail).not.toContain("boxpilot.prev.20260822T100000Z");
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

  it("offers a log older than the history but not a recent one", async () => {
    const { service } = await fixture();
    const logs = (await service.inspect()).categories.find((category) => category.id === "job-logs");
    expect(logs.items).toBe(1);
  });
});

describe("reclaiming", () => {
  it("removes only the categories named, and leaves live data alone", async () => {
    const { service, installRoot, catalogRoot, applicationBackupRoot } = await fixture();
    const result = await service.reclaim({ targets: ["boxpilot-versions", "restore-leftovers"] });
    expect(result.removed.map((entry) => entry.category)).toEqual(expect.arrayContaining(["boxpilot-versions", "restore-leftovers"]));

    // Gone: the older trees and the unfinished restore.
    await expect(stat(path.join(installRoot, "boxpilot.rollback-0.50.0-abc"))).rejects.toThrow();
    await expect(stat(path.join(catalogRoot, "jellyfin", "data.replaced"))).rejects.toThrow();
    // Kept: the live install, the rollback target, the app's real data, and every backup, because
    // those categories were not chosen.
    await expect(stat(path.join(installRoot, "boxpilot", "server.mjs"))).resolves.toBeTruthy();
    await expect(stat(path.join(installRoot, "boxpilot.prev.20260822T100000Z"))).resolves.toBeTruthy();
    await expect(stat(path.join(catalogRoot, "jellyfin", "data", "live"))).resolves.toBeTruthy();
    await expect(stat(path.join(applicationBackupRoot, "jellyfin", "20260801T000000Z.tar.gz"))).resolves.toBeTruthy();
  });

  it("never removes an image a container is using", async () => {
    const { service, run } = await fixture();
    await service.reclaim({ targets: ["docker-unreferenced-images"] });
    const removed = run.mock.calls.filter(([, args]) => args[0] === "rmi").map(([, args]) => args[1]);
    expect(removed).toEqual(expect.arrayContaining(["jellyfin/jellyfin:10.10.7", "old/removed-app:1.0"]));
    expect(removed).not.toContain("jellyfin/jellyfin:10.11.11");
  });
});

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

  const jobLogDirectory = path.join(root, "job-logs");
  await mkdir(jobLogDirectory, { recursive: true });
  const oldLog = path.join(jobLogDirectory, "11111111-1111-4111-8111-111111111111.log");
  const freshLog = path.join(jobLogDirectory, "22222222-2222-4222-8222-222222222222.log");
  await writeFile(oldLog, "old output");
  await writeFile(freshLog, "recent output");
  await utimes(oldLog, new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));

  const run = vi.fn(async (_binary, args) => {
    if (args[0] === "images" && args.includes("dangling=true")) return { ok: true, stdout: "sha9\t300MB\nsha8\t100MB", stderr: "" };
    if (args[0] === "images") return { ok: true, stdout: "jellyfin/jellyfin:10.11.11\tsha1\t1.7GB\njellyfin/jellyfin:10.10.7\tsha2\t1.7GB\nold/removed-app:1.0\tsha3\t500MB", stderr: "" };
    if (args[0] === "ps") return { ok: true, stdout: "jellyfin/jellyfin:10.11.11", stderr: "" };
    if (args[0] === "system" && args[1] === "df") {
      return { ok: true, stdout: [JSON.stringify({ Type: "Images", Size: "5GB", Reclaimable: "2GB (40%)" }), JSON.stringify({ Type: "Build Cache", Size: "600MB", Reclaimable: "600MB" })].join("\n"), stderr: "" };
    }
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
});

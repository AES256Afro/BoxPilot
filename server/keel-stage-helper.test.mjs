import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelStageHelper } from "./keel-stage-helper.mjs";

const directories = [];

async function setup({ archiveSafe = true, completeTree = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-stage-"));
  directories.push(directory);
  const artifact = path.join(directory, "artifact.tar.gz");
  await writeFile(artifact, "fixed artifact", { mode: 0o600 });
  const paths = {
    root: path.join(directory, "apps", "keel"),
    releases: path.join(directory, "apps", "keel", "releases"),
    release: path.join(directory, "apps", "keel", "releases", "1.2.6"),
    evidence: path.join(directory, "apps", "keel", "releases", "1.2.6", ".boxpilot-stage.json"),
  };
  const spec = {
    releaseTag: "v1.2.6",
    releaseCommitSha: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    archiveRoot: "keel-1.2.6-linux-x64",
    archiveMembersObservedDuringAdapterReview: 9,
    archiveRegularFilesObservedDuringAdapterReview: 5,
    archiveDirectoriesObservedDuringAdapterReview: 4,
  };
  const extractArchive = vi.fn(async ({ archive, destination }) => {
    expect(archive).toBe(artifact);
    const root = destination;
    await mkdir(path.join(root, "bin"), { recursive: true });
    await mkdir(path.join(root, "server", "prisma"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "keel-notes", version: "1.2.6" }));
    await writeFile(path.join(root, "bin", "keel.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(path.join(root, "server", "server.js"), "server\n");
    await writeFile(path.join(root, "server", "package.json"), "{}\n");
    if (completeTree) await writeFile(path.join(root, "server", "prisma", "schema.sql"), "schema\n");
  });
  const artifactHelper = { inspect: vi.fn(async () => ({ state: "verified", locallyVerified: true, sha256: spec.digest })) };
  const archiveHelper = { inspect: vi.fn(async () => archiveSafe
    ? { state: "safe", safeToExtract: true, memberCount: spec.archiveMembersObservedDuringAdapterReview, risks: [] }
    : { state: "blocked", safeToExtract: false, memberCount: spec.archiveMembersObservedDuringAdapterReview, risks: ["symbolic-link-member"] }) };
  const helper = createKeelStageHelper({
    paths,
    artifactPaths: { archive: artifact },
    spec,
    now: () => new Date("2026-08-16T13:00:00.000Z"),
    artifactHelper,
    archiveHelper,
    extractArchive,
  });
  return { directory, paths, spec, helper, extractArchive, archiveHelper };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Keel inert staging helper", () => {
  it("publishes one exact root-only tree without installing or starting Keel", async () => {
    const value = await setup();
    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "absent", staged: false, readyToStage: true, boundary: { mutationPerformed: false } });
    const stageId = randomUUID();
    await expect(value.helper.stage({ stageId })).resolves.toMatchObject({
      staged: true,
      stageId,
      version: "1.2.6",
      sourceMemberCount: 9,
      regularFiles: 5,
      directories: 4,
      managedMetadataFiles: 1,
      boundary: {
        mutationPerformed: true,
        networkAccess: false,
        extractionPerformed: true,
        archiveExecuted: false,
        applicationInstalled: false,
        applicationStateCreated: false,
        serviceChanged: false,
        registrationChanged: false,
        listenerChanged: false,
        arbitraryPathAccepted: false,
      },
    });
    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "staged", staged: true, readyToStage: false, stageId, sourceMemberCount: 9, partialCount: 0 });
    expect(value.extractArchive).toHaveBeenCalledOnce();
    expect(value.archiveHelper.inspect).toHaveBeenCalledTimes(2);
  });

  it("rejects browser-shaped input and an archive that did not pass the link gate", async () => {
    const value = await setup({ archiveSafe: false });
    await expect(value.helper.stage({ stageId: randomUUID(), path: "/tmp/keel" })).rejects.toThrow("only one stageId UUID");
    await expect(value.helper.stage({ stageId: randomUUID() })).rejects.toThrow("runtime membership gate");
    expect(value.extractArchive).not.toHaveBeenCalled();
  });

  it("removes its generated partial tree when required membership is missing", async () => {
    const value = await setup({ completeTree: false });
    await expect(value.helper.stage({ stageId: randomUUID() })).rejects.toThrow("required regular file");
    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "absent", staged: false, partialCount: 0 });
  });

  it("reports unsafe staged permissions without mutating them during inspection", async () => {
    const value = await setup();
    await value.helper.stage({ stageId: randomUUID() });
    const manifest = path.join(value.paths.release, "package.json");
    await chmod(manifest, 0o644);

    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "invalid", staged: false, boundary: { mutationPerformed: false } });
    expect((await stat(manifest)).mode & 0o777).toBe(0o644);
  });

  it("rejects an intermediate staging-root symlink without writing through it", async () => {
    const value = await setup();
    const outside = path.join(value.directory, "outside");
    await mkdir(path.dirname(value.paths.root), { recursive: true });
    await mkdir(outside);
    await symlink(outside, value.paths.root);

    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "invalid", readyToStage: false, boundary: { mutationPerformed: false } });
    await expect(value.helper.stage({ stageId: randomUUID() })).rejects.toThrow("not safely stageable");
    expect(await readdir(outside)).toEqual([]);
  });

  it("fails closed on unrelated entries in the fixed staging roots", async () => {
    const value = await setup();
    await mkdir(value.paths.root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(value.paths.root, "unexpected"), "do not replace\n");
    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "invalid", readyToStage: false });
    await expect(value.helper.stage({ stageId: randomUUID() })).rejects.toThrow("not safely stageable");

    await rm(path.join(value.paths.root, "unexpected"));
    await mkdir(value.paths.releases, { mode: 0o700 });
    await mkdir(path.join(value.paths.releases, "other-release"), { mode: 0o700 });
    await expect(value.helper.inspect()).resolves.toMatchObject({ state: "invalid", readyToStage: false });
  });
});

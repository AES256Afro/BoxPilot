import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelArtifactHelper } from "./keel-artifact-helper.mjs";

const directories = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-helper-"));
  directories.push(directory);
  const root = path.join(directory, "keel");
  const paths = { root, archive: path.join(root, "keel.tar.gz"), partial: path.join(root, "keel.tar.gz.partial"), evidence: path.join(root, "evidence.json"), evidencePartial: path.join(root, "evidence.json.partial"), approval: path.join(directory, "approval.json") };
  const contents = Buffer.from("verified-keel-archive");
  const spec = { repository: "AES256Afro/Keel", releaseTag: "v-test", releaseCommitSha: "b".repeat(40), name: "keel.tar.gz", platform: "linux", architecture: "x64", sizeBytes: contents.length, digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`, sourceUrl: "https://github.com/AES256Afro/Keel/releases/download/v-test/keel.tar.gz" };
  return { directory, root, paths, contents, spec };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Keel artifact helper", () => {
  it("reports absent, partial, invalid, and exact verified states without mutation", async () => {
    const value = await fixture();
    const helper = createKeelArtifactHelper({ paths: value.paths, spec: value.spec, loadEvidence: async () => JSON.parse(await readFile(value.paths.evidence, "utf8")) });
    await expect(helper.inspect()).resolves.toMatchObject({ state: "absent", readyToAcquire: true, locallyVerified: false, boundary: { mutationPerformed: false, extractionPerformed: false } });
    await mkdir(value.root, { recursive: true });
    await writeFile(value.paths.partial, "partial", { mode: 0o600 });
    await expect(helper.inspect()).resolves.toMatchObject({ state: "partial", readyToAcquire: true, partialPresent: true });
    await rm(value.paths.partial);
    await writeFile(value.paths.archive, "changed", { mode: 0o600 });
    await expect(helper.inspect()).resolves.toMatchObject({ state: "invalid", readyToAcquire: false, locallyVerified: false });
    await rm(value.paths.archive);
    const acquisitionId = randomUUID();
    await writeFile(value.paths.archive, value.contents, { mode: 0o600 });
    await writeFile(value.paths.evidence, JSON.stringify({ schemaVersion: 1, acquisitionId, releaseTag: value.spec.releaseTag, releaseCommitSha: value.spec.releaseCommitSha, name: value.spec.name, sizeBytes: value.spec.sizeBytes, sha256: value.spec.digest.slice(7), downloadedAt: "2026-08-16T10:00:00.000Z" }), { mode: 0o600 });
    await expect(helper.inspect()).resolves.toMatchObject({ state: "verified", locallyVerified: true, evidenceRecorded: true, acquisitionId, sha256: value.spec.digest });
  });

  it("writes a fixed approval marker, starts only the static service, and verifies matching evidence", async () => {
    const value = await fixture();
    const acquisitionId = randomUUID();
    let approval = null;
    const run = vi.fn(async (binary, args) => {
      expect(binary).toBe("/usr/bin/systemctl");
      expect(args).toEqual(["start", "boxpilot-keel-artifact.service"]);
      await writeFile(value.paths.archive, value.contents, { mode: 0o600 });
      await writeFile(value.paths.evidence, JSON.stringify({ schemaVersion: 1, acquisitionId, releaseTag: value.spec.releaseTag, releaseCommitSha: value.spec.releaseCommitSha, name: value.spec.name, sizeBytes: value.spec.sizeBytes, sha256: value.spec.digest.slice(7), downloadedAt: "2026-08-16T10:01:00.000Z" }), { mode: 0o600 });
      return { ok: true };
    });
    const helper = createKeelArtifactHelper({
      paths: value.paths, spec: value.spec, now: () => new Date("2026-08-16T10:01:00.000Z"), run,
      writeApproval: async (value) => { approval = value; }, clearApproval: async () => { approval = null; },
      loadEvidence: async () => JSON.parse(await readFile(value.paths.evidence, "utf8")),
    });
    const result = await helper.acquire({ acquisitionId });
    expect(result).toMatchObject({ acquisitionId, acquired: true, locallyVerified: true, boundary: { networkAccess: true, extractionPerformed: false, applicationInstalled: false, arbitraryUrlAccepted: false } });
    expect(run).toHaveBeenCalledOnce();
    expect(approval).toBeNull();
  });

  it("rejects browser-shaped acquisition input and refuses an existing mismatched archive", async () => {
    const value = await fixture();
    const helper = createKeelArtifactHelper({ paths: value.paths, spec: value.spec });
    await expect(helper.acquire({ acquisitionId: randomUUID(), url: "https://example.invalid" })).rejects.toThrow("only one acquisitionId");
    await mkdir(value.root, { recursive: true });
    await writeFile(value.paths.archive, "mismatch");
    await expect(helper.acquire({ acquisitionId: randomUUID() })).rejects.toThrow("not safely acquirable");
  });
});

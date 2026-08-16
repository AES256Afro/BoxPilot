import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireApprovedKeelArtifact, keelArtifactScriptInternals } from "./boxpilot-keel-artifact.mjs";

const directories = [];

function response(statusCode, headers, chunks = []) {
  const stream = Readable.from(chunks);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

async function fixture(contents = Buffer.from("reviewed-keel-archive")) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-artifact-"));
  directories.push(directory);
  const root = path.join(directory, "artifacts", "keel");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const paths = {
    root,
    archive: path.join(root, "keel.tar.gz"),
    partial: path.join(root, "keel.tar.gz.partial"),
    evidence: path.join(root, "evidence.json"),
    evidencePartial: path.join(root, "evidence.json.partial"),
    approval: path.join(directory, "approval.json"),
  };
  const spec = {
    repository: "AES256Afro/Keel", releaseTag: "v-test", releaseCommitSha: "a".repeat(40), name: "keel.tar.gz", platform: "linux", architecture: "x64",
    sizeBytes: contents.length, digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    sourceUrl: "https://github.com/AES256Afro/Keel/releases/download/v-test/keel.tar.gz",
  };
  const acquisitionId = randomUUID();
  const approval = JSON.stringify({ acquisitionId, approvedAt: "2026-08-16T10:00:00.000Z", digest: spec.digest, name: spec.name, releaseCommitSha: spec.releaseCommitSha, releaseTag: spec.releaseTag, sizeBytes: spec.sizeBytes, sourceUrl: spec.sourceUrl });
  return { contents, paths, spec, acquisitionId, approval };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixed Keel artifact acquisition script", () => {
  it("publishes only exact locally hashed bytes after the reviewed GitHub redirect", async () => {
    const value = await fixture();
    const request = vi.fn(async (url) => url.hostname === "github.com"
      ? response(302, { location: "https://release-assets.githubusercontent.com/github-production-release-asset/test/token" })
      : response(200, { "content-length": String(value.contents.length) }, [value.contents.subarray(0, 5), value.contents.subarray(5)]));
    const result = await acquireApprovedKeelArtifact({ ...value, loadApproval: async () => value.approval, request, now: () => new Date("2026-08-16T10:01:00.000Z") });
    expect(result).toMatchObject({ acquisitionId: value.acquisitionId, sizeBytes: value.contents.length, stalePartialRemoved: false });
    expect(await readFile(value.paths.archive)).toEqual(value.contents);
    expect(JSON.parse(await readFile(value.paths.evidence, "utf8"))).toMatchObject({ acquisitionId: value.acquisitionId, extractionPerformed: false, archiveExecuted: false, applicationInstalled: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("removes fixed partial output when length or digest verification fails", async () => {
    const value = await fixture();
    const changed = Buffer.from(value.contents);
    changed[0] ^= 1;
    const request = vi.fn(async (url) => url.hostname === "github.com"
      ? response(302, { location: "https://release-assets.githubusercontent.com/github-production-release-asset/test/token" })
      : response(200, { "content-length": String(value.contents.length) }, [changed]));
    await expect(acquireApprovedKeelArtifact({ ...value, loadApproval: async () => value.approval, request, now: () => new Date("2026-08-16T10:01:00.000Z") })).rejects.toThrow("SHA-256");
    await expect(readFile(value.paths.archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(value.paths.partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale approval and any redirect outside the fixed release asset host", async () => {
    const value = await fixture();
    await expect(acquireApprovedKeelArtifact({ ...value, loadApproval: async () => value.approval, request: vi.fn(), now: () => new Date("2026-08-16T10:06:00.001Z") })).rejects.toThrow("stale");
    const request = vi.fn(async () => response(302, { location: "https://example.invalid/archive" }));
    await expect(acquireApprovedKeelArtifact({ ...value, loadApproval: async () => value.approval, request, now: () => new Date("2026-08-16T10:01:00.000Z") })).rejects.toThrow("allowlist");
  });

  it("accepts no command-line-selected target and validates exact approval fields", () => {
    expect(() => keelArtifactScriptInternals.parseApproval("{}", new Date(), { releaseTag: "v", releaseCommitSha: "x", name: "x", sizeBytes: 1, digest: "sha256:x", sourceUrl: "https://github.com/x" })).toThrow("unexpected fields");
  });
});

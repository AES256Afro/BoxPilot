import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { acquireApprovedUbuntuMedia, ubuntuMediaScriptInternals } from "./boxpilot-ubuntu-media.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-ubuntu-media-"));
  const paths = { approval: path.join(root, "approval.json"), inboxRoot: path.join(root, "inbox"), evidenceRoot: path.join(root, "evidence") };
  await Promise.all([mkdir(paths.inboxRoot), mkdir(paths.evidenceRoot)]);
  const bytes = Buffer.from("small fixed Ubuntu ISO fixture");
  const spec = {
    id: "ubuntu-server-test-amd64", label: "Ubuntu Server test", release: "test", architecture: "amd64", name: "ubuntu-test-live-server-amd64.iso",
    sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sourceUrl: "https://releases.ubuntu.com/test/ubuntu-test-live-server-amd64.iso",
    checksumUrl: "https://releases.ubuntu.com/test/SHA256SUMS", signatureUrl: "https://releases.ubuntu.com/test/SHA256SUMS.gpg",
  };
  const acquisitionId = "77777777-7777-4777-8777-777777777777";
  const catalogRevision = "a".repeat(64);
  const approval = JSON.stringify({ acquisitionId, approvedAt: "2026-08-16T21:00:00.000Z", expectedCatalogRevision: catalogRevision, imageId: spec.id });
  return { paths, bytes, spec, acquisitionId, catalogRevision, approval };
}

function responseFor(bytes, size = bytes.length) {
  const response = Readable.from([bytes]);
  response.statusCode = 200;
  response.headers = { "content-length": String(size) };
  response.setTimeout = () => response;
  return response;
}

describe("fixed Ubuntu media acquisition unit", () => {
  it("publishes an exact staging pair and immutable evidence after complete verification", async () => {
    const item = await fixture();
    const result = await acquireApprovedUbuntuMedia({
      paths: item.paths,
      loadApproval: async () => item.approval,
      request: async () => responseFor(item.bytes),
      now: () => new Date("2026-08-16T21:01:00.000Z"),
      resolveSpec: (id) => id === item.spec.id ? item.spec : null,
      catalogRevision: item.catalogRevision,
    });
    expect(result).toMatchObject({ acquisitionId: item.acquisitionId, imageId: item.spec.id, sizeBytes: item.bytes.length, sha256: item.spec.sha256 });
    expect(await readFile(path.join(item.paths.inboxRoot, item.spec.name))).toEqual(item.bytes);
    expect(JSON.parse(await readFile(path.join(item.paths.inboxRoot, `${item.spec.name}.boxpilot.json`), "utf8"))).toMatchObject({ source: "fixed-ubuntu-release", acquisitionId: item.acquisitionId });
    expect(JSON.parse(await readFile(path.join(item.paths.evidenceRoot, `${item.acquisitionId}.json`), "utf8"))).toMatchObject({ catalogRevision: item.catalogRevision, sourceHost: "releases.ubuntu.com", staged: true, imported: false });
  });

  it("removes only generated state after a checksum mismatch", async () => {
    const item = await fixture();
    const changed = Buffer.from(item.bytes);
    changed[0] ^= 1;
    await expect(acquireApprovedUbuntuMedia({
      paths: item.paths,
      loadApproval: async () => item.approval,
      request: async () => responseFor(changed),
      now: () => new Date("2026-08-16T21:01:00.000Z"),
      resolveSpec: () => item.spec,
      catalogRevision: item.catalogRevision,
    })).rejects.toThrow("SHA-256");
    await expect(lstat(path.join(item.paths.inboxRoot, item.spec.name))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(item.paths.evidenceRoot, `${item.acquisitionId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale markers and any non-official URL", async () => {
    const item = await fixture();
    expect(() => ubuntuMediaScriptInternals.parseApproval(item.approval, new Date("2026-08-16T21:10:01.000Z"), { resolveSpec: () => item.spec, catalogRevision: item.catalogRevision })).toThrow("stale");
    expect(() => ubuntuMediaScriptInternals.validateSourceUrl({ ...item.spec, sourceUrl: "https://example.com/ubuntu.iso" })).toThrow("fixed official HTTPS");
  });
});

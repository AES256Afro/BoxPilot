import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeelArchiveHelper, keelArchiveHelperInternals } from "./keel-archive-helper.mjs";

const directories = [];

function writeField(block, value, offset, length) {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "ascii");
}

function header({ name, type = "0", content = Buffer.alloc(0), linkTarget = "", mode = 0o755 }) {
  const block = Buffer.alloc(512);
  writeField(block, name, 0, 100);
  writeField(block, `${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  writeField(block, "0000000\0", 108, 8);
  writeField(block, "0000000\0", 116, 8);
  writeField(block, `${content.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  writeField(block, "00000000000\0", 136, 12);
  block.fill(32, 148, 156);
  writeField(block, type, 156, 1);
  writeField(block, linkTarget, 157, 100);
  writeField(block, "ustar\0", 257, 6);
  writeField(block, "00", 263, 2);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeField(block, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function tar(members, { corruptChecksum = false, endMarker = true } = {}) {
  const parts = [];
  for (const member of members) {
    const content = Buffer.from(member.content ?? "");
    const memberHeader = header({ ...member, content });
    if (corruptChecksum && parts.length === 0) memberHeader[148] = memberHeader[148] === 48 ? 49 : 48;
    parts.push(memberHeader, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  if (endMarker) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function longNameTar(longName) {
  return tar([
    { name: "././@LongLink", type: "L", content: `${longName}\0` },
    { name: longName.slice(0, 100), content: "safe" },
  ]);
}

async function fixture(members, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-archive-"));
  directories.push(directory);
  const archive = path.join(directory, "keel.tar.gz");
  const bytes = gzipSync(tar(members, options));
  await writeFile(archive, bytes, { mode: 0o600 });
  const spec = {
    sizeBytes: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    archiveRoot: "keel-test",
    archiveMembersObservedDuringAdapterReview: members.length,
  };
  return { archive, bytes, spec };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Keel archive helper", () => {
  it("accepts a bounded regular archive without extracting or returning member names", async () => {
    const value = await fixture([
      { name: "keel-test/", type: "5" },
      { name: "keel-test/server.js", content: "console.log('keel')" },
    ]);
    const helper = createKeelArchiveHelper({ paths: { archive: value.archive }, spec: value.spec });
    await expect(helper.inspect()).resolves.toMatchObject({
      state: "safe", safeToExtract: true, artifactLocallyVerified: true, memberCount: 2,
      counts: { regular: 1, directory: 1, symbolicLink: 0 }, risks: [],
      boundary: { mutationPerformed: false, extractionPerformed: false, archiveMemberNamesReturned: false, linkTargetsReturned: false, memberContentsReturned: false },
    });
  });

  it("blocks symbolic and hard links without returning their names or targets", async () => {
    const value = await fixture([
      { name: "keel-test/", type: "5" },
      { name: "keel-test/client", type: "2", linkTarget: "/home/runner/work/Keel/client" },
      { name: "keel-test/other", type: "1", linkTarget: "../../outside" },
    ]);
    const result = await createKeelArchiveHelper({ paths: { archive: value.archive }, spec: value.spec }).inspect();
    expect(result).toMatchObject({ state: "blocked", safeToExtract: false, memberCount: 3, counts: { symbolicLink: 1, hardLink: 1 } });
    expect(result.risks).toEqual(expect.arrayContaining(["symbolic-link-member", "hard-link-member", "absolute-link-target", "parent-traversal-link-target"]));
    expect(JSON.stringify(result)).not.toContain("runner");
    expect(JSON.stringify(result)).not.toContain("outside");
    expect(JSON.stringify(result)).not.toContain("server/client");
  });

  it("blocks traversal, duplicate roots, devices, FIFO, unsupported extensions, and unknown types", async () => {
    const value = await fixture([
      { name: "keel-test/", type: "5" },
      { name: "keel-test/../escape", content: "x" },
      { name: "other/device", type: "3" },
      { name: "other/fifo", type: "6" },
      { name: "other/pax", type: "x" },
      { name: "other/unknown", type: "9" },
    ]);
    const result = await createKeelArchiveHelper({ paths: { archive: value.archive }, spec: value.spec }).inspect();
    expect(result.risks).toEqual(expect.arrayContaining([
      "parent-traversal-member-path", "unexpected-archive-root", "character-device-member", "fifo-member", "pax-extension-member", "unknown-member-type",
    ]));
    expect(result.safeToExtract).toBe(false);
  });

  it("classifies noncanonical and invalid path forms", () => {
    expect(keelArchiveHelperInternals.pathRisks("keel-test//file")).toContain("noncanonical-member-path");
    expect(keelArchiveHelperInternals.pathRisks("keel-test/./file")).toContain("noncanonical-member-path");
    expect(keelArchiveHelperInternals.pathRisks("keel-test/\ufffdfile")).toContain("invalid-member-path");
  });

  it("blocks normalized path collisions, privileged modes, and payloads on non-regular members", async () => {
    const value = await fixture([
      { name: "keel-test/", type: "5" },
      { name: "keel-test/a", content: "one", mode: 0o6755 },
      { name: "keel-test//a", content: "two" },
      { name: "keel-test/bad-directory", type: "5", content: "unexpected" },
    ]);
    const result = await createKeelArchiveHelper({ paths: { archive: value.archive }, spec: value.spec }).inspect();
    expect(result.risks).toEqual(expect.arrayContaining(["duplicate-member-path", "noncanonical-member-path", "privileged-mode-member", "nonregular-member-payload"]));
    expect(result.safeToExtract).toBe(false);
  });

  it("understands a bounded GNU long-name header as metadata for one logical member", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-archive-"));
    directories.push(directory);
    const archive = path.join(directory, "keel.tar.gz");
    const longName = `keel-test/${"nested/".repeat(16)}server.js`;
    const bytes = gzipSync(longNameTar(longName));
    await writeFile(archive, bytes, { mode: 0o600 });
    const spec = { sizeBytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, archiveRoot: "keel-test", archiveMembersObservedDuringAdapterReview: 1 };
    await expect(createKeelArchiveHelper({ paths: { archive }, spec }).inspect()).resolves.toMatchObject({ state: "safe", safeToExtract: true, memberCount: 1, counts: { regular: 1, extension: 1 }, risks: [] });
  });

  it("fails closed for a missing artifact, digest mismatch, checksum mismatch, and truncated tar", async () => {
    const missing = createKeelArchiveHelper({ paths: { archive: "/definitely/missing/keel.tar.gz" }, spec: { sizeBytes: 1, digest: `sha256:${"0".repeat(64)}`, archiveRoot: "keel", archiveMembersObservedDuringAdapterReview: 1 } });
    await expect(missing.inspect()).resolves.toMatchObject({ state: "artifact-required", risks: ["artifact-required"], safeToExtract: false });

    const changed = await fixture([{ name: "keel-test/", type: "5" }]);
    const changedSpec = { ...changed.spec, digest: `sha256:${"f".repeat(64)}` };
    await expect(createKeelArchiveHelper({ paths: { archive: changed.archive }, spec: changedSpec }).inspect()).resolves.toMatchObject({ state: "blocked", risks: ["compressed-digest-mismatch"] });

    const corrupt = await fixture([{ name: "keel-test/", type: "5" }], { corruptChecksum: true });
    await expect(createKeelArchiveHelper({ paths: { archive: corrupt.archive }, spec: corrupt.spec }).inspect()).resolves.toMatchObject({ state: "blocked", risks: ["header-checksum-mismatch"] });

    const truncated = await fixture([{ name: "keel-test/file", content: "data" }], { endMarker: false });
    await expect(createKeelArchiveHelper({ paths: { archive: truncated.archive }, spec: truncated.spec }).inspect()).resolves.toMatchObject({ state: "blocked", risks: expect.arrayContaining(["missing-end-marker"]) });
  });

  it("enforces member and uncompressed-size limits before allocating member contents", async () => {
    const value = await fixture([{ name: "keel-test/a", content: "12345" }, { name: "keel-test/b", content: "6" }]);
    await expect(createKeelArchiveHelper({ paths: { archive: value.archive }, spec: value.spec, limits: { maxMembers: 1, maxUncompressedBytes: 10000 } }).inspect()).resolves.toMatchObject({ state: "blocked", risks: ["member-count-limit-exceeded"] });
    await expect(createKeelArchiveHelper({ paths: { archive: value.archive }, spec: value.spec, limits: { maxMembers: 10, maxUncompressedBytes: 4 } }).inspect()).resolves.toMatchObject({ state: "blocked", risks: ["uncompressed-size-limit-exceeded"] });
  });
});

describe("Keel archive parser primitives", () => {
  it("rejects absolute, Windows, backslash, traversal, and control-character paths", () => {
    expect(keelArchiveHelperInternals.pathRisks("/root/file")).toContain("absolute-member-path");
    expect(keelArchiveHelperInternals.pathRisks("C:/root/file")).toContain("absolute-member-path");
    expect(keelArchiveHelperInternals.pathRisks("root\\file")).toContain("backslash-member-path");
    expect(keelArchiveHelperInternals.pathRisks("root/../file")).toContain("parent-traversal-member-path");
    expect(keelArchiveHelperInternals.pathRisks("root/\nfile")).toContain("invalid-member-path");
  });
});

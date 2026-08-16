import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVmMediaHelper, safeIsoFilename, validateVmMediaImportInput } from "./vm-media-helper.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-media-"));
  const inboxRoot = path.join(root, "inbox");
  const mediaRoot = path.join(root, "media");
  await Promise.all([mkdir(inboxRoot), mkdir(mediaRoot)]);
  const name = "ubuntu-24.04.iso";
  const content = Buffer.from("test ISO bytes");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const uploadedAt = "2026-08-16T20:00:00.000Z";
  await writeFile(path.join(inboxRoot, name), content, { mode: 0o600 });
  await writeFile(path.join(inboxRoot, `${name}.boxpilot.json`), JSON.stringify({ schemaVersion: 1, name, sizeBytes: content.length, sha256, uploadedAt }));
  const helper = createVmMediaHelper({ inboxRoot, mediaRoot, filesystemStats: async () => ({ bavail: 100, bsize: 1024 ** 3 }) });
  return { root, inboxRoot, mediaRoot, name, content, sha256, helper };
}

describe("VM media helper", () => {
  it("lists only complete regular staged pairs and managed ISO files", async () => {
    const item = await fixture();
    await writeFile(path.join(item.mediaRoot, "debian.iso"), "managed");
    await writeFile(path.join(item.inboxRoot, "incomplete.iso"), "incomplete");
    await symlink(path.join(item.inboxRoot, item.name), path.join(item.inboxRoot, "linked.iso"));
    const linkedMetadataContent = Buffer.from("linked metadata ISO");
    const linkedMetadataName = "metadata-linked.iso";
    const linkedMetadataSha = createHash("sha256").update(linkedMetadataContent).digest("hex");
    const outsideMetadata = path.join(item.root, "outside-metadata.json");
    await writeFile(path.join(item.inboxRoot, linkedMetadataName), linkedMetadataContent);
    await writeFile(outsideMetadata, JSON.stringify({ schemaVersion: 1, name: linkedMetadataName, sizeBytes: linkedMetadataContent.length, sha256: linkedMetadataSha, uploadedAt: "2026-08-16T20:00:00.000Z" }));
    await symlink(outsideMetadata, path.join(item.inboxRoot, `${linkedMetadataName}.boxpilot.json`));
    const result = await item.helper.inspect();
    expect(result.inbox.candidates).toHaveLength(1);
    expect(result.inbox.candidates[0]).toMatchObject({ name: item.name, sizeBytes: item.content.length, sha256: item.sha256 });
    expect(result.inbox.candidates[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.library.images).toEqual([expect.objectContaining({ name: "debian.iso", sizeBytes: 7 })]);
    expect(result.boundary).toMatchObject({ browserPathAccepted: false, arbitraryDestinationAccepted: false, existingMediaOverwritten: false, mutationPerformed: false });
  });

  it("imports exact staged bytes atomically and removes the staging pair", async () => {
    const item = await fixture();
    const before = await item.helper.inspect();
    const candidate = before.inbox.candidates[0];
    const result = await item.helper.importMedia({
      importId: randomUUID(), filename: item.name, expectedSizeBytes: item.content.length, expectedSha256: item.sha256, expectedRevision: candidate.revision,
    });
    expect(result).toMatchObject({ imported: true, verified: true, filename: item.name, sha256: item.sha256, stagingRemoved: true, boundary: { existingMediaOverwritten: false, virtualMachineCreated: false, libvirtChanged: false } });
    expect(await readFile(path.join(item.mediaRoot, item.name))).toEqual(item.content);
    expect((await lstat(path.join(item.mediaRoot, item.name))).mode & 0o777).toBe(0o444);
    await expect(lstat(path.join(item.inboxRoot, item.name))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when staged bytes change after review", async () => {
    const item = await fixture();
    const candidate = (await item.helper.inspect()).inbox.candidates[0];
    await writeFile(path.join(item.inboxRoot, item.name), Buffer.from("changed ISO"));
    await expect(item.helper.importMedia({ importId: randomUUID(), filename: item.name, expectedSizeBytes: candidate.sizeBytes, expectedSha256: candidate.sha256, expectedRevision: candidate.revision })).rejects.toThrow(/changed after approval|SHA-256/);
    await expect(lstat(path.join(item.mediaRoot, item.name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(item.inboxRoot, item.name), "utf8")).toBe("changed ISO");
  });

  it("never overwrites existing managed media", async () => {
    const item = await fixture();
    const candidate = (await item.helper.inspect()).inbox.candidates[0];
    await writeFile(path.join(item.mediaRoot, item.name), "existing");
    await expect(item.helper.importMedia({ importId: randomUUID(), filename: item.name, expectedSizeBytes: candidate.sizeBytes, expectedSha256: candidate.sha256, expectedRevision: candidate.revision })).rejects.toThrow("already exists");
    expect(await readFile(path.join(item.mediaRoot, item.name), "utf8")).toBe("existing");
    expect(await readFile(path.join(item.inboxRoot, item.name))).toEqual(item.content);
  });

  it("rejects unsafe fields and filename traversal", () => {
    expect(safeIsoFilename("../ubuntu.iso")).toBe(false);
    expect(safeIsoFilename("ubuntu.img")).toBe(false);
    expect(validateVmMediaImportInput({ importId: randomUUID(), filename: "../ubuntu.iso", expectedSizeBytes: 10, expectedSha256: "a".repeat(64), expectedRevision: "b".repeat(64) })).toContain("The ISO filename is invalid");
    expect(validateVmMediaImportInput({ importId: randomUUID(), filename: "ubuntu.iso", expectedSizeBytes: 10, expectedSha256: "a".repeat(64), expectedRevision: "b".repeat(64), path: "/tmp/evil" })).toContain("VM media import accepts only the fixed evidence fields");
  });
});

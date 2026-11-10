import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUbuntuMediaHelper, validateUbuntuMediaAcquireInput } from "./ubuntu-media-helper.mjs";
import { getUbuntuMediaSpec, ubuntuMediaCatalogRevision } from "./ubuntu-media-spec.mjs";

describe("Ubuntu media acquisition helper", () => {
  it("starts only the fixed unit and verifies the exact staging and evidence result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-ubuntu-helper-"));
    const paths = { approval: path.join(root, "approval.json"), inboxRoot: path.join(root, "inbox"), evidenceRoot: path.join(root, "evidence") };
    await Promise.all([mkdir(paths.inboxRoot), mkdir(paths.evidenceRoot)]);
    const acquisitionId = "77777777-7777-4777-8777-777777777777";
    const spec = getUbuntuMediaSpec("ubuntu-server-26.04-amd64");
    let acquired = false;
    const inspectMedia = vi.fn(async () => ({ inbox: { candidates: acquired ? [{ name: spec.name, sizeBytes: spec.sizeBytes, sha256: spec.sha256 }] : [] }, library: { images: [] } }));
    const run = vi.fn(async (binary, args) => {
      expect(binary).toBe("/usr/bin/systemctl");
      expect(args).toEqual(["start", "boxpilot-ubuntu-media.service"]);
      acquired = true;
      await writeFile(path.join(paths.evidenceRoot, `${acquisitionId}.json`), JSON.stringify({ schemaVersion: 1, acquisitionId, imageId: spec.id, catalogRevision: ubuntuMediaCatalogRevision, name: spec.name, sizeBytes: spec.sizeBytes, sha256: spec.sha256, sourceHost: "releases.ubuntu.com" }));
      return { ok: true, stdout: "" };
    });
    const helper = createUbuntuMediaHelper({ paths, inspectMedia, run, now: () => new Date("2026-08-16T21:00:00.000Z") });
    const result = await helper.acquire({ acquisitionId, imageId: spec.id, expectedCatalogRevision: ubuntuMediaCatalogRevision });
    expect(result).toMatchObject({ acquired: true, staged: true, locallyVerified: true, evidenceRecorded: true, boundary: { arbitraryUrlAccepted: false, existingMediaOverwritten: false, virtualMachineCreated: false } });
    await expect(readFile(paths.approval, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects injected fields and catalog identities", () => {
    expect(validateUbuntuMediaAcquireInput({ acquisitionId: "77777777-7777-4777-8777-777777777777", imageId: "ubuntu-server-26.04-amd64", expectedCatalogRevision: ubuntuMediaCatalogRevision })).toEqual([]);
    expect(validateUbuntuMediaAcquireInput({ acquisitionId: "77777777-7777-4777-8777-777777777777", imageId: "evil", expectedCatalogRevision: ubuntuMediaCatalogRevision, url: "https://example.com" })).toContain("Ubuntu media acquisition accepts only the fixed identity fields");
  });
});

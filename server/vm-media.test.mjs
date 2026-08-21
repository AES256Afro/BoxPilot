import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVmMediaService } from "./vm-media.mjs";

function requestFor(content, filename = "ubuntu.iso", declaredSize = content.length) {
  const request = Readable.from([content]);
  const headers = new Map([
    ["content-type", "application/octet-stream"],
    ["x-boxpilot-filename", filename],
    ["x-boxpilot-size", String(declaredSize)],
  ]);
  request.get = (name) => headers.get(name.toLowerCase());
  return request;
}

describe("VM media controller service", () => {
  it("streams an authenticated upload into a complete staging pair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-upload-"));
    const inboxRoot = path.join(root, "inbox");
    await mkdir(inboxRoot);
    const content = Buffer.from("browser ISO bytes");
    const service = createVmMediaService({ helper: {}, store: {}, inboxRoot, filesystemStats: async () => ({ bavail: 100, bsize: 1024 ** 3 }) });
    const result = await service.upload(requestFor(content));
    expect(result).toMatchObject({ name: "ubuntu.iso", sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
    expect(await readFile(path.join(inboxRoot, "ubuntu.iso"))).toEqual(content);
    const metadata = JSON.parse(await readFile(path.join(inboxRoot, "ubuntu.iso.boxpilot.json"), "utf8"));
    expect(metadata).toMatchObject({ schemaVersion: 1, name: "ubuntu.iso", sizeBytes: content.length, sha256: result.sha256, source: "authenticated-browser-upload" });
  });

  it("removes partials after byte-count failure and rejects traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-upload-fail-"));
    const service = createVmMediaService({ helper: {}, store: {}, inboxRoot: root, filesystemStats: async () => ({ bavail: 100, bsize: 1024 ** 3 }) });
    await expect(service.upload(requestFor(Buffer.from("short"), "ubuntu.iso", 99))).rejects.toThrow("byte count");
    await expect(lstat(path.join(root, "ubuntu.iso"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.upload(requestFor(Buffer.from("bytes"), "../ubuntu.iso"))).rejects.toThrow("safe filename");
  });

  it("pins the staged ISO evidence into the operation parameters", async () => {
    const candidate = { name: "ubuntu.iso", sizeBytes: 100, sha256: "a".repeat(64), uploadedAt: "2026-08-16T20:00:00.000Z", modifiedAt: "2026-08-16T20:00:00.000Z", revision: "b".repeat(64) };
    const inventory = { inbox: { path: "/fixed/inbox", candidates: [candidate] }, library: { path: "/fixed/media", images: [] } };
    const helper = { request: vi.fn(async () => inventory) };
    const service = createVmMediaService({ helper, store: {} });
    const parameters = await service.prepareOperation({ filename: "ubuntu.iso" });
    expect(parameters).toMatchObject({ filename: "ubuntu.iso", expectedSizeBytes: 100, expectedSha256: "a".repeat(64), expectedRevision: "b".repeat(64) });
    expect(parameters.importId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(service.prepareOperation({ filename: "../ubuntu.iso" })).rejects.toThrow("fixed upload area");
    await expect(service.prepareOperation({ filename: "missing.iso" })).rejects.toThrow("unavailable or incomplete");
    inventory.library.images.push({ name: "ubuntu.iso", sizeBytes: 100 });
    await expect(service.prepareOperation({ filename: "ubuntu.iso" })).rejects.toThrow("already exists");
  });
});

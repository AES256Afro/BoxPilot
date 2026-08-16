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

  it("pins helper evidence into an immutable plan and rechecks it before staging", async () => {
    const candidate = { name: "ubuntu.iso", sizeBytes: 100, sha256: "a".repeat(64), uploadedAt: "2026-08-16T20:00:00.000Z", modifiedAt: "2026-08-16T20:00:00.000Z", revision: "b".repeat(64) };
    const helper = { request: vi.fn(async () => ({ inbox: { path: "/fixed/inbox", candidates: [candidate] }, library: { path: "/fixed/media", images: [] } })) };
    let stored;
    const store = {
      createPlan: vi.fn((plan) => (stored = { ...plan, id: "plan-one", revision: "plan-revision", status: "draft", expiresAt: "2026-08-16T21:00:00.000Z" })),
      getPlan: vi.fn(() => stored),
      stagePlan: vi.fn(),
      createJob: vi.fn((job) => ({ ...job, id: "job-one", state: "awaiting_approval" })),
    };
    const service = createVmMediaService({ helper, store });
    const plan = await service.plan("ubuntu.iso", "owner-one");
    expect(plan).toMatchObject({ id: "plan-one", revision: "plan-revision", input: { filename: "ubuntu.iso", expectedSizeBytes: 100, expectedSha256: "a".repeat(64), expectedRevision: "b".repeat(64) }, executable: true });
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "virtualization.media.import", state: "awaiting_approval", risk: "medium" });
    expect(store.stagePlan).toHaveBeenCalledWith("plan-one", "owner-one");
    expect(helper.request).toHaveBeenCalledTimes(2);
  });
});

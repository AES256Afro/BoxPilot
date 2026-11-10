import { describe, expect, it, vi } from "vitest";
import { createUbuntuMediaService } from "./ubuntu-media.mjs";

describe("Ubuntu media acquisition controller", () => {
  it("creates and stages an immutable official catalog plan", async () => {
    const helper = { request: vi.fn(async () => ({ inbox: { candidates: [] }, library: { images: [] } })) };
    let stored;
    const store = {
      createPlan: vi.fn((plan) => (stored = { ...plan, id: "plan-one", revision: "plan-revision", status: "draft", expiresAt: "2026-08-16T22:00:00.000Z" })),
      getPlan: vi.fn(() => stored), stagePlan: vi.fn(), createJob: vi.fn((job) => ({ ...job, id: "job-one", state: "awaiting_approval" })),
    };
    const service = createUbuntuMediaService({ store, helper });
    const catalog = await service.catalog();
    expect(catalog.images).toHaveLength(2);
    expect(catalog.images.every((image) => image.state === "available")).toBe(true);
    expect(catalog.boundary).toMatchObject({ officialHostOnly: "releases.ubuntu.com", arbitraryUrlAccepted: false, automaticDownload: false });
    const plan = await service.plan("ubuntu-server-26.04-amd64", "owner-one");
    expect(plan).toMatchObject({ id: "plan-one", input: { imageId: "ubuntu-server-26.04-amd64" }, artifact: { name: "ubuntu-26.04-live-server-amd64.iso" } });
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "virtualization.media.acquire", risk: "networked-artifact", state: "awaiting_approval" });
    expect(store.stagePlan).toHaveBeenCalledWith("plan-one", "owner-one");
  });
});

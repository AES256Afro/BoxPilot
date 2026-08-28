import { describe, expect, it, vi } from "vitest";
import { createTlsRenewal, shouldRenew } from "./tls-renewal.mjs";

const now = Date.parse("2026-08-28T12:00:00.000Z");
const inDays = (days) => new Date(now + days * 24 * 3600 * 1000).toUTCString();

describe("shouldRenew", () => {
  it("renews only inside the window", () => {
    expect(shouldRenew(inDays(60), { now, withinMs: 30 * 24 * 3600 * 1000 })).toBe(false);
    expect(shouldRenew(inDays(20), { now, withinMs: 30 * 24 * 3600 * 1000 })).toBe(true);
    expect(shouldRenew(inDays(-1), { now, withinMs: 30 * 24 * 3600 * 1000 })).toBe(true); // already expired
    expect(shouldRenew("not a date", { now, withinMs: 1 })).toBe(false);
  });
});

describe("the renewal check", () => {
  const provisioned = (notAfter) => ({ provisioned: true, notAfter, names: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"] });

  it("does nothing when TLS is not set up", async () => {
    const helper = { request: vi.fn() };
    const renewal = createTlsRenewal({ helper, store: { listActiveJobs: () => [] }, readStatus: async () => ({ provisioned: false }), now: () => now });
    expect(await renewal.check()).toMatchObject({ renewed: false, reason: "not-provisioned" });
    expect(helper.request).not.toHaveBeenCalled();
  });

  it("does nothing when the certificate is not close to expiry", async () => {
    const helper = { request: vi.fn() };
    const renewal = createTlsRenewal({ helper, store: { listActiveJobs: () => [] }, readStatus: async () => provisioned(inDays(200)), now: () => now });
    expect(await renewal.check()).toMatchObject({ renewed: false, reason: "not-due" });
    expect(helper.request).not.toHaveBeenCalled();
  });

  it("reissues the certificate with its current names once inside the window", async () => {
    const helper = { request: vi.fn(async () => ({ restartScheduled: true })) };
    const recordAudit = vi.fn();
    const renewal = createTlsRenewal({ helper, store: { listActiveJobs: () => [], recordAudit }, readStatus: async () => provisioned(inDays(10)), now: () => now });
    expect(await renewal.check()).toMatchObject({ renewed: true, names: ["boxpilot.lan", "bigbox"] });
    expect(helper.request).toHaveBeenCalledWith("system.web.tls.provision", { names: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"] }, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(recordAudit).toHaveBeenCalledWith("tls.renewed", expect.anything());
  });

  it("waits rather than restarting BoxPilot out from under a running job", async () => {
    const helper = { request: vi.fn() };
    const renewal = createTlsRenewal({ helper, store: { listActiveJobs: () => [{ id: "job-1" }] }, readStatus: async () => provisioned(inDays(5)), now: () => now });
    expect(await renewal.check()).toMatchObject({ renewed: false, reason: "job-running" });
    expect(helper.request).not.toHaveBeenCalled();
  });

  it("records a failure instead of throwing", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("helper down"); }) };
    const recordAudit = vi.fn();
    const renewal = createTlsRenewal({ helper, store: { listActiveJobs: () => [], recordAudit }, readStatus: async () => provisioned(inDays(1)), now: () => now });
    expect(await renewal.check()).toMatchObject({ renewed: false, reason: "failed", error: "helper down" });
    expect(recordAudit).toHaveBeenCalledWith("tls.renew.failed", expect.anything());
  });
});

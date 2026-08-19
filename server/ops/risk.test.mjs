import { describe, expect, it } from "vitest";
import { approvalRequirement, knownJobTypes, normalizeApprovalMode, riskTierForJob, riskTiers } from "./risk.mjs";

describe("risk tiers", () => {
  it("maps known job types to tiers and defaults unknown types to high", () => {
    expect(riskTierForJob("helper.canary.verify")).toBe("low");
    expect(riskTierForJob("application.uptime-kuma.action")).toBe("low");
    expect(riskTierForJob("prerequisite.docker.install")).toBe("medium");
    expect(riskTierForJob("application.pi-hole.deploy")).toBe("high");
    expect(riskTierForJob("virtualization.export.backup.retention.apply")).toBe("high");
    expect(riskTierForJob("something.new")).toBe("high");
    for (const type of knownJobTypes()) expect(riskTiers).toContain(riskTierForJob(type));
  });

  it("normalizes approval modes", () => {
    expect(normalizeApprovalMode("always-password")).toBe("always-password");
    expect(normalizeApprovalMode("tiered")).toBe("tiered");
    expect(normalizeApprovalMode("yolo")).toBe("tiered");
    expect(normalizeApprovalMode(undefined)).toBe("tiered");
  });

  it("requires a password only for high risk unless the session is elevated or the mode is always-password", () => {
    const now = () => new Date("2026-08-19T12:00:00.000Z");
    expect(approvalRequirement({ jobType: "helper.canary.verify", now })).toMatchObject({ tier: "low", passwordRequired: false, elevated: false });
    expect(approvalRequirement({ jobType: "prerequisite.docker.install", now })).toMatchObject({ tier: "medium", passwordRequired: false });
    expect(approvalRequirement({ jobType: "application.pi-hole.deploy", now })).toMatchObject({ tier: "high", passwordRequired: true, reason: "high risk" });
    expect(approvalRequirement({ jobType: "application.pi-hole.deploy", elevatedUntil: "2026-08-19T12:05:00.000Z", now })).toMatchObject({ tier: "high", passwordRequired: false, elevated: true });
    expect(approvalRequirement({ jobType: "application.pi-hole.deploy", elevatedUntil: "2026-08-19T11:59:59.000Z", now })).toMatchObject({ passwordRequired: true, elevated: false });
    expect(approvalRequirement({ jobType: "application.pi-hole.deploy", elevatedUntil: "not-a-date", now })).toMatchObject({ passwordRequired: true });
    expect(approvalRequirement({ jobType: "helper.canary.verify", mode: "always-password", now })).toMatchObject({ tier: "low", passwordRequired: true, reason: "always-password mode" });
    expect(approvalRequirement({ jobType: "application.pi-hole.deploy", mode: "always-password", elevatedUntil: "2026-08-19T12:05:00.000Z", now })).toMatchObject({ passwordRequired: true });
  });
});

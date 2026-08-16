import { describe, expect, it, vi } from "vitest";
import { createSupportBundleService } from "./support-bundle.mjs";

function service(overrides = {}) {
  return createSupportBundleService({
    inventory: { inspect: vi.fn(async () => ({ host: { hostname: "bigbox" }, mount: "/srv/private/app", password: "do-not-export" })) },
    prerequisites: { inspect: vi.fn(async () => ({ checks: [{ id: "docker", summary: "token=secret-value" }] })) },
    actionCenter: { inspect: vi.fn(async () => ({ notices: [], boundary: { mutationPerformed: false } })) },
    audit: { list: vi.fn(async () => ({ events: [{ type: "job", sessionId: "private-session", detail: "private-owner" }] })) },
    helper: { request: vi.fn(async (_operation, parameters) => ({ source: parameters.source, entries: [{ message: "Bearer private-bearer", unit: "boxpilot.service" }] })) },
    loadPolicy: vi.fn(async () => ({ status: "loaded", additionalLiterals: ["private-owner"], additionalPathPrefixes: ["/srv/private"] })),
    now: () => new Date("2026-08-16T06:00:00.000Z"),
    version: "0.30.0-test",
    ...overrides,
  });
}

describe("source-backed support bundle", () => {
  it("collects only fixed sources and applies the final configurable redaction pass", async () => {
    const result = await service().inspect();
    expect(result).toMatchObject({ schemaVersion: 1, product: { version: "0.30.0-test" }, sources: { inventory: { status: "available" }, logs: { boxpilot: { status: "available" }, docker: { status: "available" }, tailscale: { status: "available" }, virtualization: { status: "available" } } }, boundary: { mutationPerformed: false, credentialsIncluded: false, arbitraryLogsAccepted: false } });
    const serialized = JSON.stringify(result);
    for (const secret of ["do-not-export", "secret-value", "private-session", "private-owner", "private-bearer", "/srv/private"]) expect(serialized).not.toContain(secret);
    expect(result.redactionPolicy).toMatchObject({ additionalLiteralCount: 1, configuredValuesIncluded: false });
  });

  it("degrades each collector independently and never returns thrown error text", async () => {
    const failed = service({ inventory: { inspect: vi.fn(async () => { throw new Error("inventory-secret"); }) }, helper: { request: vi.fn(async () => { throw new Error("log-secret"); }) } });
    const result = await failed.inspect();
    expect(result.sources.inventory).toEqual({ status: "unavailable" });
    expect(Object.values(result.sources.logs).every((item) => item.status === "unavailable")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("inventory-secret");
    expect(JSON.stringify(result)).not.toContain("log-secret");
  });
});

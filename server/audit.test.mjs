import { describe, expect, it, vi } from "vitest";
import { createAuditLog, parseAuditLimit } from "./audit.mjs";

describe("virtualization audit log", () => {
  it("records redacted structured events in JSONL", async () => {
    const append = vi.fn(async () => {});
    const makeDirectory = vi.fn(async () => {});
    const audit = createAuditLog({ stateDirectory: "/safe/state", append, makeDirectory });

    const event = await audit.record("vm.plan.created", { domain: "ubuntu-lab", revision: "abc123", warningCount: 0 });

    expect(event).toMatchObject({ type: "vm.plan.created", domain: "ubuntu-lab", revision: "abc123" });
    expect(makeDirectory).toHaveBeenCalledWith("/safe/state", { recursive: true, mode: 0o700 });
    expect(append.mock.calls[0][0]).toBe("/safe/state/audit.jsonl");
    expect(JSON.parse(append.mock.calls[0][1])).toMatchObject({ type: "vm.plan.created", warningCount: 0 });
  });

  it("returns newest valid events first and skips malformed lines", async () => {
    const read = vi.fn(async () => [
      JSON.stringify({ id: "one", timestamp: "2026-08-14T12:00:00Z", type: "vm.plan.created" }),
      "not-json",
      JSON.stringify({ id: "two", timestamp: "2026-08-14T12:01:00Z", type: "vm.action.requested" }),
      "",
    ].join("\n"));
    const audit = createAuditLog({ stateDirectory: "/safe/state", read });

    const result = await audit.list(10);

    expect(result.events.map((event) => event.id)).toEqual(["two", "one"]);
  });

  it("bounds requested log length", () => {
    expect(parseAuditLimit("0")).toBe(1);
    expect(parseAuditLimit("5000")).toBe(200);
    expect(parseAuditLimit("invalid")).toBe(50);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "./registry.mjs";
import { parseUpdateUnits, updateOperations, updateOutcome, updateSuperseded } from "./update.mjs";

const registry = createRegistry([updateOperations]);
const sha = "d".repeat(40);

describe("self-update operations", () => {
  it("reads update units and the upgrade log and names the outcome", async () => {
    const run = vi.fn(async (binary, args) => {
      if (args[0] === "list-units") return { ok: true, stdout: "boxpilot-update-20260821T150000Z.service loaded inactive dead BoxPilot update to v0.62.0\n", stderr: "" };
      return { ok: true, stdout: "-- Logs begin --\n2026-08-21T15:00:01+0000 host sh[9]: [boxpilot-upgrade] downloading AES256Afro/BoxPilot@v0.62.0\n2026-08-21T15:02:10+0000 host sh[9]: [boxpilot-upgrade] BoxPilot 0.62.0 (v0.62.0) is live; 0 unit file(s) updated; previous tree at /opt/boxpilot.prev.x", stderr: "" };
    });
    const status = await registry.execute("system.update.status", {}, { run });
    expect(status).toMatchObject({ outcome: "live", units: [{ unit: "boxpilot-update-20260821T150000Z.service", active: "inactive", sub: "dead" }] });
    expect(status.log).toHaveLength(2);
  });

  it("classifies running, failed, and unknown outcomes", () => {
    expect(updateOutcome(parseUpdateUnits("boxpilot-update-1T.service loaded active running x"), [])).toBe("running");
    expect(updateOutcome([], ["a [boxpilot-upgrade] ERROR: upgrade failed; previous tree restored"])).toBe("failed");
    expect(updateOutcome(parseUpdateUnits("boxpilot-update-1T.service loaded failed failed x"), ["a [boxpilot-upgrade] downloading"])).toBe("failed");
    expect(updateOutcome([], ["a [boxpilot-upgrade] building BoxPilot 0.62.0"])).toBe("running");
    expect(updateOutcome([], [])).toBeNull();
    expect(parseUpdateUnits("other.service loaded active running y\n")).toEqual([]);
  });

  it("stages the update through the root task with only the pinned tag and commit", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ started: true })) };
    await expect(registry.execute("system.update", { tag: "v0.62.0", expectedCommit: sha }, { runUnit, jobLog: null })).resolves.toEqual({ started: true });
    expect(runUnit.runTask).toHaveBeenCalledWith("system.update", { tag: "v0.62.0", expectedCommit: sha }, expect.objectContaining({ timeoutMs: 5 * 60_000 }));
    expect(registry.validate("system.update", { tag: "main", expectedCommit: sha })).toBeTruthy();
    expect(registry.validate("system.update", { tag: "v0.62.0", expectedCommit: "nope" })).toBeTruthy();
    expect(registry.get("system.update").risk).toBe("high");
  });
});

// M36: an update staged for a version the server has since reached has nothing left to do.
describe("an update staged before the server moved on", () => {
  it("is superseded by the same or a newer running version, and not by an older one", () => {
    expect(updateSuperseded({ tag: "v1.116.0" }, { version: "1.138.0" })).toBe("BoxPilot is already at 1.138.0, so the update to v1.116.0 has nothing to do");
    expect(updateSuperseded({ tag: "v1.138.0" }, { version: "1.138.0" })).toMatch(/already at 1.138.0/);
    expect(updateSuperseded({ tag: "v1.139.0" }, { version: "1.138.0" })).toBeNull();
    expect(updateSuperseded({ tag: "v1.139.0-rc.1" }, { version: "1.138.0" })).toBeNull();
    expect(updateSuperseded({}, { version: "1.138.0" })).toBeNull();
    expect(registry.get("system.update").supersededWhen).toBe(updateSuperseded);
  });
});

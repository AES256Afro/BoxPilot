import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { fail2banOperations } from "./fail2ban.mjs";

const operations = Object.fromEntries(fail2banOperations().map((operation) => [operation.id, operation]));

describe("fail2ban operations", () => {
  it("validates thresholds and stages the task with defaults", async () => {
    const spec = operations["fail2ban.apply"].parameters;
    expect(validateParameters(spec, { maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 120 }, "t")).toBeNull();
    expect(validateParameters(spec, { maxRetry: 0 }, "t")).toContain("between 1 and 50");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["fail2ban.apply"].run({}, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("fail2ban.apply", { enabled: true, maxRetry: 5, findTimeMinutes: 10, banTimeMinutes: 60, ignoreLan: true }, expect.anything());
  });

  it("reads state, counting bans from the client status", async () => {
    const run = vi.fn(async (binary, args) => (args[0] === "is-active" ? { ok: true, stdout: "active\n", stderr: "" } : args[0] === "status" ? { ok: true, stdout: "Status for the jail: sshd\n   |- Currently banned: 2\n   |- Total banned: 7\n", stderr: "" } : { ok: false, stdout: "", stderr: "" }));
    const state = await operations["fail2ban.inspect"].run({}, { run });
    expect(typeof state.installed).toBe("boolean");
    if (state.installed) expect(state).toMatchObject({ running: true, currentlyBanned: 2, totalBanned: 7 });
    else expect(state).toMatchObject({ running: null, currentlyBanned: null });
  });
});

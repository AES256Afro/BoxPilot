import { describe, expect, it, vi } from "vitest";
import { parseUnitFailure, unitFailureMessage, unitFailureShowArgs } from "./unit-failure.mjs";

const unit = "boxpilot-example.service";
const showArgs = ["show", unit, "-p", "Result", "-p", "ExecMainCode", "-p", "ExecMainStatus"];

function showing(stdout) {
  return vi.fn(async (binary, args) => (binary.endsWith("systemctl") && args[0] === "show" ? { ok: true, stdout } : { ok: false, stdout: "" }));
}

describe("unit failure", () => {
  it("asks systemctl for the result and the main process's code and status, one -p each", () => {
    expect(unitFailureShowArgs(unit)).toEqual(showArgs);
  });

  it("parses the three properties and refuses an answer missing one", () => {
    expect(parseUnitFailure("Result=core-dump\nExecMainCode=3\nExecMainStatus=5\n")).toEqual({ result: "core-dump", code: 3, status: 5 });
    expect(parseUnitFailure("Result=exit-code\nExecMainCode=1\nExecMainStatus=100")).toEqual({ result: "exit-code", code: 1, status: 100 });
    expect(parseUnitFailure("Result=exit-code\nExecMainCode=1")).toBeNull();
    expect(parseUnitFailure("Result=exit-code\nExecMainCode=one\nExecMainStatus=1")).toBeNull();
    expect(parseUnitFailure("Result=signal\nExecMainCode=2\nExecMainStatus=-9")).toBeNull();
    expect(parseUnitFailure(`Result=core-dump\nExecMainCode=3\nExecMainStatus=${"9".repeat(400)}`)).toBeNull(); // a status that would print as Infinity
    expect(parseUnitFailure("Result=core-dump\r\nExecMainCode=3\r\nExecMainStatus=05\r\n")).toEqual({ result: "core-dump", code: 3, status: 5 });
    expect(parseUnitFailure("ExecMainCode=1\nExecMainStatus=1")).toBeNull();
    expect(parseUnitFailure("")).toBeNull();
    expect(parseUnitFailure(undefined)).toBeNull();
  });

  it.each([
    ["core-dump", "Result=core-dump\nExecMainCode=3\nExecMainStatus=5", "The example service's process died (signal 5) before the script ran; nothing was changed"],
    ["exit-code", "Result=exit-code\nExecMainCode=1\nExecMainStatus=2", "The example service failed and rolled back (exit status 2)"],
    ["timeout", "Result=timeout\nExecMainCode=2\nExecMainStatus=15", "The example service ran out of time and systemd stopped it before it finished"],
    ["signal", "Result=signal\nExecMainCode=2\nExecMainStatus=9", "The example service's process was killed by signal 9 before it finished"],
    ["start-limit-hit", "Result=start-limit-hit\nExecMainCode=0\nExecMainStatus=0", "The example service failed and rolled back"],
    ["core-dump without a dumped main process", "Result=core-dump\nExecMainCode=1\nExecMainStatus=1", "The example service failed and rolled back"],
    ["an answer systemctl could not give", "", "The example service failed and rolled back"],
  ])("says what Result=%s means", async (_result, stdout, message) => {
    const run = showing(stdout);
    await expect(unitFailureMessage({ run, systemctlBinary: "/usr/bin/systemctl", unit, subject: "The example service", fallback: "The example service failed and rolled back", unchanged: "nothing was changed" })).resolves.toBe(message);
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", showArgs, { timeout: 10000 });
  });

  it("falls back to the plain sentence when systemctl show fails or throws", async () => {
    const failing = vi.fn(async () => ({ ok: false, stdout: "" }));
    await expect(unitFailureMessage({ run: failing, systemctlBinary: "/usr/bin/systemctl", unit, subject: "The example service" })).resolves.toBe("The example service failed");
    const throwing = vi.fn(async () => { throw new Error("socket gone"); });
    await expect(unitFailureMessage({ run: throwing, systemctlBinary: "/usr/bin/systemctl", unit, subject: "The example service" })).resolves.toBe("The example service failed");
  });

  it("leaves the core-dump sentence without a clause when the caller claims nothing about what was left untouched", async () => {
    await expect(unitFailureMessage({ run: showing("Result=core-dump\nExecMainCode=3\nExecMainStatus=11"), systemctlBinary: "/usr/bin/systemctl", unit, subject: "The example service" }))
      .resolves.toBe("The example service's process died (signal 11) before the script ran");
  });
});

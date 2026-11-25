import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { fail2banOperations, parseJailStatus } from "./fail2ban.mjs";

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

  const status = [
    "Status for the jail: sshd",
    "|- Filter",
    "|  |- Currently failed:\t1",
    "|  |- Total failed:\t40",
    "|  `- Journal matches:\t_SYSTEMD_UNIT=sshd.service + _COMM=sshd",
    "`- Actions",
    "   |- Currently banned:\t3",
    "   |- Total banned:\t9",
    "   `- Banned IP list:\t203.0.113.7 2001:db8::5 198.51.100.20",
    "",
  ].join("\n");

  // M90: only the counts were read, so the page could not say which addresses were banned.
  it("reads which addresses are banned, not only how many", async () => {
    expect(parseJailStatus(status)).toEqual({ currentlyBanned: 3, totalBanned: 9, bannedAddresses: ["203.0.113.7", "2001:db8::5", "198.51.100.20"] });
    expect(parseJailStatus("   `- Banned IP list:\t\n").bannedAddresses).toEqual([]);
    expect(parseJailStatus("   `- Banned IP list:\t1.2.3.4 <script> 01.2.3.4 1.2.3.4\n").bannedAddresses).toEqual(["1.2.3.4"]);
    const run = vi.fn(async (_binary, args) => (args[0] === "is-active" ? { ok: true, stdout: "active\n", stderr: "" } : { ok: true, stdout: status, stderr: "" }));
    const state = await operations["fail2ban.inspect"].run({}, { run, installedCheck: async () => {} });
    expect(state).toMatchObject({ installed: true, running: true, currentlyBanned: 3, bannedAddresses: ["203.0.113.7", "2001:db8::5", "198.51.100.20"] });
    expect(operations["fail2ban.inspect"].minimumRole).toBeNull();
  });

  it("lifts one ban: a strict address, one argument, and the jail read back", async () => {
    const spec = operations["fail2ban.unban"].parameters;
    expect(operations["fail2ban.unban"].risk).toBe("medium");
    for (const address of ["203.0.113.7", "2001:db8::5", "::ffff:192.0.2.1"]) expect(validateParameters(spec, { address }, "t"), address).toBeNull();
    for (const address of ["203.0.113.0/24", "01.2.3.4", "1.2.3.4 5.6.7.8", "fe80::1%eth0", "--all", "1.2.3", "", "999.1.1.1"]) expect(validateParameters(spec, { address }, "t"), address).not.toBeNull();
    const after = status.replace("203.0.113.7 ", "").replace("banned:\t3", "banned:\t2");
    const run = vi.fn(async (_binary, args) => (args[0] === "set" ? { ok: true, stdout: "1\n", stderr: "" } : { ok: true, stdout: after, stderr: "" }));
    await expect(operations["fail2ban.unban"].run({ address: "203.0.113.7" }, { run })).resolves.toEqual({ address: "203.0.113.7", unbanned: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/fail2ban-client", ["set", "sshd", "unbanip", "203.0.113.7"], expect.anything());
  });

  it("does not report a ban lifted that fail2ban refused, or that is still listed", async () => {
    const refused = vi.fn(async () => ({ ok: false, stdout: "", stderr: "ERROR  NOK: ('sshd',)\nSocket error" }));
    await expect(operations["fail2ban.unban"].run({ address: "203.0.113.7" }, { run: refused })).rejects.toThrow("fail2ban did not lift the ban on 203.0.113.7");
    const stillThere = vi.fn(async (_binary, args) => (args[0] === "set" ? { ok: true, stdout: "1\n", stderr: "" } : { ok: true, stdout: status, stderr: "" }));
    await expect(operations["fail2ban.unban"].run({ address: "203.0.113.7" }, { run: stillThere })).rejects.toThrow("is still on the sshd jail's banned list");
    const notBanned = vi.fn(async () => ({ ok: true, stdout: "0\n", stderr: "" }));
    await expect(operations["fail2ban.unban"].run({ address: "192.0.2.9" }, { run: notBanned })).resolves.toMatchObject({ unbanned: false });
    const olderClient = vi.fn(async () => ({ ok: false, stdout: "", stderr: "192.0.2.9 is not banned" }));
    await expect(operations["fail2ban.unban"].run({ address: "192.0.2.9" }, { run: olderClient })).resolves.toMatchObject({ unbanned: false });
  });
});

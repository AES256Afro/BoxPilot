import { describe, expect, it, vi } from "vitest";
import { fail2banApply, parseJail, renderJail, validateFail2banConfig } from "./fail2ban.mjs";

function fakeRun({ testFails = false } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("fail2ban-client") && args[0] === "-t") return testFails ? { ok: false, stdout: "", stderr: "ERROR  Failed during configuration: bad value" } : { ok: true, stdout: "OK: configuration test is successful", stderr: "" };
    if (binary.endsWith("fail2ban-client")) return { ok: true, stdout: "Status for the jail: sshd\n|- Filter\n|  |- Currently failed: 0\n`- Actions\n   |- Currently banned: 2\n", stderr: "" };
    if (binary.endsWith("/ip")) return { ok: true, stdout: JSON.stringify([{ dst: "default", dev: "eno1" }, { dst: "192.168.1.0/24", dev: "eno1", scope: "link" }, { dst: "172.17.0.0/16", dev: "docker0", scope: "link" }]), stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}
function fakeFiles({ existing = null, ufw = true } = {}) {
  const state = { jail: existing, unlinked: [] };
  return {
    state,
    readFile: vi.fn(async () => { if (state.jail === null) throw new Error("ENOENT"); return state.jail; }),
    writeFile: vi.fn(async (path, content) => { state.jail = content; }),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    unlink: vi.fn(async (path) => { state.unlinked.push(path); state.jail = null; }),
    access: vi.fn(async (path) => { if (path.endsWith("ufw") && !ufw) throw new Error("ENOENT"); }),
  };
}

describe("fail2ban tasks", () => {
  it("validates thresholds and renders a jail that never bans home or tailnet addresses", () => {
    expect(validateFail2banConfig({})).toBeNull();
    expect(validateFail2banConfig({ maxRetry: 0 })).toContain("maxRetry");
    expect(validateFail2banConfig({ banTimeMinutes: 99999 })).toContain("banTimeMinutes");
    const text = renderJail({ maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 120, lanSubnets: ["192.168.1.0/24"], ufwPresent: true });
    expect(text).toContain("ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10 192.168.1.0/24");
    expect(text).toContain("bantime = 120m\nfindtime = 15m\nmaxretry = 3\nbackend = systemd\nbanaction = ufw");
    expect(text).toContain("[sshd]\nenabled = true\nmode = aggressive");
    expect(renderJail({ ignoreLan: false, lanSubnets: ["192.168.1.0/24"] })).toContain("ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10\n");
    expect(parseJail(text)).toEqual({ managed: true, maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 120, ignoreLan: true, ignore: ["127.0.0.1/8", "::1", "100.64.0.0/10", "192.168.1.0/24"], sshd: true });
    expect(parseJail("[DEFAULT]\nbantime = 1h\nfindtime = 600\n")).toMatchObject({ managed: false, banTimeMinutes: 60, findTimeMinutes: 10, sshd: false });
  });

  it("applies the jail: tests the config, starts the service, and reports bans", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    const result = await fail2banApply({ maxRetry: 4, findTimeMinutes: 10, banTimeMinutes: 60 }, { run, files });
    expect(result).toMatchObject({ enabled: true, maxRetry: 4, ignored: ["127.0.0.1/8", "::1", "100.64.0.0/10", "192.168.1.0/24"], banAction: "ufw", currentlyBanned: 2 });
    expect(files.state.jail).toContain("maxretry = 4");
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain("fail2ban-client -t");
    expect(calls).toContain("systemctl enable --now fail2ban");
    expect(calls).toContain("fail2ban-client status sshd");
    const noUfw = await fail2banApply({}, { run: fakeRun(), files: fakeFiles({ ufw: false }) });
    expect(noUfw.banAction).toBe("iptables");
  });

  it("restores the previous jail when the config test fails, and disables cleanly", async () => {
    const files = fakeFiles({ existing: "# Managed by BoxPilot\n[DEFAULT]\nmaxretry = 5\n" });
    await expect(fail2banApply({ maxRetry: 2 }, { run: fakeRun({ testFails: true }), files })).rejects.toThrow("restored the previous one");
    expect(files.state.jail).toContain("maxretry = 5");
    const run = fakeRun();
    await expect(fail2banApply({ enabled: false }, { run, files })).resolves.toEqual({ enabled: false });
    expect(files.state.unlinked).toEqual(["/etc/fail2ban/jail.d/boxpilot.local"]);
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["disable", "--now", "fail2ban"], expect.anything());
    const missing = fakeFiles();
    missing.access = vi.fn(async () => { throw new Error("ENOENT"); });
    await expect(fail2banApply({}, { run: fakeRun(), files: missing })).rejects.toThrow("not installed");
  });
});

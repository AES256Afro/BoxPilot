import { describe, expect, it, vi } from "vitest";
import { firewallRuleAdd, firewallRuleDelete, firewallSet, validateRule } from "./firewall.mjs";

const okRun = () => vi.fn(async (binary, args) => {
  if (args[0] === "status") return { ok: true, stdout: "Status: active\nTo  Action  From\n22/tcp  ALLOW IN  Anywhere", stderr: "" };
  return { ok: true, stdout: "Rule added", stderr: "" };
});

describe("root firewall tasks", () => {
  it("validates rules strictly", () => {
    expect(validateRule({ action: "allow", port: 8080, protocol: "tcp" })).toBeNull();
    expect(validateRule({ action: "drop", port: 8080, protocol: "tcp" })).toContain("action");
    expect(validateRule({ action: "allow", port: 0, protocol: "tcp" })).toContain("port");
    expect(validateRule({ action: "allow", port: 8080, protocol: "icmp" })).toContain("protocol");
    expect(validateRule({ action: "allow", port: 8080, protocol: "tcp", comment: "bad; comment" })).toContain("comment");
  });

  it("adds SSH and tailnet rules before enabling", async () => {
    const run = okRun();
    const result = await firewallSet({ enabled: true }, { run });
    expect(result.enabled).toBe(true);
    expect(result.status[0]).toBe("Status: active");
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    const enableIndex = calls.findIndex((call) => call === "--force enable");
    expect(calls.findIndex((call) => call.startsWith("allow 22/tcp"))).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((call) => call.startsWith("allow in on tailscale0"))).toBeLessThan(enableIndex);
    expect(calls.findIndex((call) => call.startsWith("allow 22/tcp"))).toBeLessThan(enableIndex);
  });

  it("disables without adding rules", async () => {
    const run = okRun();
    await firewallSet({ enabled: false }, { run });
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls.some((call) => call.startsWith("allow"))).toBe(false);
    expect(calls).toContain("--force disable");
  });

  it("adds and deletes rules with exact arguments", async () => {
    const run = okRun();
    await firewallRuleAdd({ action: "allow", port: 8080, protocol: "tcp", comment: "Jellyfin" }, { run });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "8080/tcp", "comment", "Jellyfin"], expect.anything());
    await firewallRuleAdd({ action: "deny", port: 25, protocol: "any" }, { run });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["deny", "25"], expect.anything());
    await firewallRuleDelete({ action: "allow", port: 8080, protocol: "tcp" }, { run });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "8080/tcp"], expect.anything());
  });

  it("refuses to delete the SSH rule", async () => {
    const run = okRun();
    await expect(firewallRuleDelete({ action: "allow", port: 22, protocol: "tcp" }, { run })).rejects.toThrow("lock you out");
    expect(run).not.toHaveBeenCalled();
  });
});

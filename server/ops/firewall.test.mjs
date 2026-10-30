import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { firewallOperations, mergeRuleFamilies, parseDefaultPolicies, parseUfwConf, parseUserRules } from "./firewall.mjs";

const operations = Object.fromEntries(firewallOperations().map((operation) => [operation.id, operation]));

describe("firewall operations", () => {
  it("parses ufw.conf and default policies", () => {
    expect(parseUfwConf("# ufw.conf\nENABLED=yes\nLOGLEVEL=low\n")).toBe(true);
    expect(parseUfwConf("ENABLED=no\n")).toBe(false);
    expect(parseUfwConf("")).toBeNull();
    expect(parseDefaultPolicies('DEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\nDEFAULT_FORWARD_POLICY="REJECT"\n'))
      .toEqual({ incoming: "drop", outgoing: "accept", routed: "reject" });
  });

  it("parses user.rules tuples including app profiles, interfaces, and comments", () => {
    const content = [
      "### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in",
      "### tuple ### allow any any 0.0.0.0/0 any 0.0.0.0/0 OpenSSH - in",
      "### tuple ### allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0",
      `### tuple ### allow tcp 8096 0.0.0.0/0 any 0.0.0.0/0 in comment=${Buffer.from("Jellyfin").toString("hex")}`,
      "### tuple ### something unparsable in",
    ].join("\n");
    const rules = parseUserRules(content, "v4");
    expect(rules[0]).toMatchObject({ action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null });
    expect(rules[1]).toMatchObject({ action: "allow", app: "OpenSSH", port: null });
    expect(rules[2]).toMatchObject({ interface: "tailscale0" });
    expect(rules[3]).toMatchObject({ port: 8096, comment: "Jellyfin" });
    expect(rules[4]).toMatchObject({ raw: "something unparsable in" });
  });

  it("merges identical v4 and v6 rules into one row", () => {
    const v4 = parseUserRules("### tuple ### allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 in", "v4");
    const v6 = parseUserRules("### tuple ### allow tcp 80 ::/0 any ::/0 in", "v6");
    const merged = mergeRuleFamilies(v4, v6);
    expect(merged).toHaveLength(1);
    expect(merged[0].family).toBe("both");
  });

  it("keeps where a rule lets traffic in from, and which way it goes", () => {
    // What ufw writes to user.rules for, as `ufw status verbose` shows them:
    //   8096/tcp  ALLOW IN   192.168.8.0/24
    //   8096/tcp  ALLOW IN   Anywhere
    //   25/tcp    DENY OUT   Anywhere
    // The page could not tell the first two apart, and its Delete could reach the wrong one.
    const v4 = parseUserRules([
      "### tuple ### allow tcp 8096 0.0.0.0/0 any 192.168.8.0/24 in",
      "### tuple ### allow tcp 8096 0.0.0.0/0 any 0.0.0.0/0 in",
      "### tuple ### deny tcp 25 0.0.0.0/0 any 0.0.0.0/0 out",
      "### tuple ### allow any any 0.0.0.0/0 any 192.168.8.0/24 OpenSSH - in",
    ].join("\n"), "v4");
    expect(v4[0]).toMatchObject({ action: "allow", port: 8096, protocol: "tcp", direction: "in", source: "192.168.8.0/24" });
    expect(v4[1]).toMatchObject({ action: "allow", port: 8096, protocol: "tcp", direction: "in", source: null });
    expect(v4[2]).toMatchObject({ action: "deny", port: 25, protocol: "tcp", direction: "out", source: null });
    expect(v4[3]).toMatchObject({ app: "OpenSSH", source: "192.168.8.0/24" });
    // The any-source rule is the same rule in both families; the LAN-only one is v4 alone.
    const v6 = parseUserRules("### tuple ### allow tcp 8096 ::/0 any ::/0 in\n### tuple ### deny tcp 25 ::/0 any ::/0 out", "v6");
    expect(v6[0]).toMatchObject({ source: null });
    const merged = mergeRuleFamilies(v4, v6);
    expect(merged.map((rule) => [rule.port, rule.direction, rule.source, rule.family])).toEqual([
      [8096, "in", "192.168.8.0/24", "v4"],
      [8096, "in", null, "both"],
      [25, "out", null, "both"],
      [null, "in", "192.168.8.0/24", "v4"],
    ]);
  });

  it("stages mutations as root tasks and enforces parameter shapes", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["firewall.set"].run({ enabled: true }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("firewall.set", { enabled: true }, expect.anything());
    await operations["firewall.rule.add"].run({ action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("firewall.rule-add", { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" }, expect.anything());
    expect(validateParameters(operations["firewall.rule.add"].parameters, { action: "allow", port: 8096, protocol: "tcp" }, "t")).toBeNull();
    expect(validateParameters(operations["firewall.rule.add"].parameters, { action: "allow", port: 70000, protocol: "tcp" }, "t")).toContain("port");
    expect(validateParameters(operations["firewall.rule.delete"].parameters, { action: "allow", port: 8096, protocol: "sctp" }, "t")).toContain("one of");
    expect(operations["firewall.set"].risk).toBe("high");
    expect(validateParameters(operations["firewall.rule.add"].parameters, { action: "limit", port: 22, protocol: "tcp" }, "t")).toBeNull();
  });

  it("stages profile application as a high-risk root task with validated profile and service ids", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    const operation = operations["firewall.profile.apply"];
    expect(operation.risk).toBe("high");
    await operation.run({ profile: "home-server", services: ["dns"] }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("firewall.profile-apply", { profile: "home-server", services: ["dns"], replace: false, sshRateLimit: false }, expect.anything());
    expect(validateParameters(operation.parameters, { profile: "tailscale-only", services: [], replace: true, sshRateLimit: true }, "t")).toBeNull();
    expect(validateParameters(operation.parameters, { profile: "fortress" }, "t")).toContain("one of");
    expect(validateParameters(operation.parameters, { profile: "home-server", services: ["irc"] }, "t")).toContain("may only contain");
  });
});

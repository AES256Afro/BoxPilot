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
  });
});

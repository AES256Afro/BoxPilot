import { describe, expect, it } from "vitest";
import { adviseFirewall, buildPlan, isProtected, profiles, protectedRules, services } from "./firewall-profiles.mjs";

describe("firewall profiles", () => {
  it("always protects SSH and Tailscale, and opens the web port only when BoxPilot is served on the LAN", () => {
    const loopback = protectedRules({ webPort: 8787, webHost: "127.0.0.1" });
    expect(loopback.map((entry) => [entry.port, entry.protocol, entry.allow])).toEqual([[22, "tcp", true], [41641, "udp", true], [8787, "tcp", false]]);
    const lan = protectedRules({ webPort: 9000, webHost: "0.0.0.0" });
    expect(lan.find((entry) => entry.label === "BoxPilot")).toMatchObject({ port: 9000, allow: true });
    expect(isProtected({ port: 22, protocol: "any" }, loopback)).toBe(true);
    expect(isProtected({ port: 22, protocol: "udp" }, loopback)).toBe(false);
    expect(isProtected({ port: 8787, protocol: "tcp" }, loopback)).toBe(true);
  });

  it("builds a plan that opens protected ports first and enables last", () => {
    const plan = buildPlan({ profileId: "home-server", serviceIds: ["jellyfin"], webPort: 8787, webHost: "0.0.0.0" });
    const argv = plan.steps.map((step) => step.args.join(" "));
    expect(argv[0]).toBe("allow 22/tcp comment BoxPilot keeps SSH reachable");
    expect(argv[1]).toBe("allow 41641/udp comment BoxPilot keeps Tailscale reachable");
    expect(argv[2]).toBe("allow 8787/tcp comment BoxPilot keeps BoxPilot reachable");
    expect(argv).toContain("allow 8096/tcp comment BoxPilot service: Jellyfin");
    expect(argv).toContain("allow 7359/udp comment BoxPilot service: Jellyfin");
    expect(argv.at(-3)).toBe("default deny incoming");
    expect(argv.at(-1)).toBe("--force enable");
    expect(plan.steps.find((step) => step.args[3] === "tailscale0")?.tolerateFailure).toBe(true);
  });

  it("resets first when replacing, drops services for Tailscale-only, and denies risky ports on the trusted LAN", () => {
    expect(buildPlan({ profileId: "home-server", replace: true }).steps[0].args).toEqual(["--force", "reset"]);
    const tailnet = buildPlan({ profileId: "tailscale-only", serviceIds: ["web", "samba"] });
    expect(tailnet.services).toEqual([]);
    expect(tailnet.steps.some((step) => step.args[1] === "445/tcp")).toBe(false);
    const trusted = buildPlan({ profileId: "trusted-lan" });
    const argv = trusted.steps.map((step) => step.args.join(" "));
    expect(argv).toContain("deny 2375/tcp comment BoxPilot profile: Docker API (unencrypted)");
    expect(argv).toContain("default allow incoming");
    expect(() => buildPlan({ profileId: "nope" })).toThrow("Unknown firewall profile");
    expect(() => buildPlan({ profileId: "home-server", serviceIds: ["irc"] })).toThrow("Unknown services");
  });

  it("ships consistent profile and service tables", () => {
    expect(profiles.filter((profile) => profile.recommended)).toHaveLength(1);
    expect(new Set(services.map((service) => service.id)).size).toBe(services.length);
    for (const service of services) for (const port of service.ports) expect(port.port).toBeGreaterThan(0);
  });

  describe("advice", () => {
    const base = { installed: true, enabled: true, defaults: { incoming: "drop", outgoing: "accept", routed: "reject" }, rules: [] };
    it("points at installing, then at the Home server profile, naming exposed risky ports", () => {
      expect(adviseFirewall({ report: { installed: false } })[0]).toMatchObject({ id: "install", focus: "install" });
      const advice = adviseFirewall({ report: { ...base, enabled: false }, listeners: [{ protocol: "tcp", port: 5432, address: "0.0.0.0", scope: "wildcard" }] });
      expect(advice).toHaveLength(1);
      expect(advice[0]).toMatchObject({ id: "enable-profile", focus: "profiles" });
      expect(advice[0].detail).toContain("PostgreSQL (5432)");
    });

    it("flags allow-by-default, risky allows, blocked apps, missing Tailscale UDP, and plain SSH", () => {
      const report = {
        ...base,
        defaults: { incoming: "accept", outgoing: "accept", routed: "reject" },
        rules: [
          { action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: null, family: "both" },
          { action: "allow", protocol: "tcp", port: 3306, app: null, direction: "in", interface: null, comment: null, family: "both" },
        ],
      };
      const advice = adviseFirewall({ report, listeners: [{ protocol: "tcp", port: 6379, address: "0.0.0.0", scope: "wildcard" }], apps: [{ id: "jellyfin", name: "Jellyfin", ports: [{ port: 8096, protocol: "tcp", label: "Web UI" }] }], webHost: "0.0.0.0" });
      const ids = advice.map((entry) => entry.id);
      expect(ids).toContain("default-deny");
      expect(advice.find((entry) => entry.id === "risky-allow-3306-tcp")).toMatchObject({ operationId: "firewall.rule.delete", parameters: { action: "allow", port: 3306, protocol: "tcp" } });
      expect(advice.find((entry) => entry.id === "risky-listen-6379-tcp")).toMatchObject({ operationId: "firewall.rule.add", parameters: { action: "deny", port: 6379 } });
      expect(ids).not.toContain("app-jellyfin-8096-tcp"); // default allow: the app is already reachable
      expect(ids).toContain("ssh-limit");
      expect(ids).toContain("lan-http");

      const denyDefault = adviseFirewall({ report: { ...report, defaults: base.defaults }, apps: [{ id: "jellyfin", name: "Jellyfin", ports: [{ port: 8096, protocol: "tcp", label: "Web UI" }] }] });
      expect(denyDefault.find((entry) => entry.id === "app-jellyfin-8096-tcp")).toMatchObject({ operationId: "firewall.rule.add", parameters: { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" } });
      expect(denyDefault.find((entry) => entry.id === "tailscale-udp")).toMatchObject({ level: "warn", parameters: { port: 41641, protocol: "udp" } });
    });

    it("suggests fail2ban while SSH is allowed and fail2ban is not protecting it", () => {
      const report = { ...base, rules: [{ action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: null, family: "both" }] };
      expect(adviseFirewall({ report, fail2ban: { installed: false, running: null, configured: false } }).find((entry) => entry.id === "fail2ban")).toMatchObject({ focus: "fail2ban" });
      expect(adviseFirewall({ report, fail2ban: { installed: true, running: true, configured: true } }).some((entry) => entry.id === "fail2ban")).toBe(false);
      expect(adviseFirewall({ report }).some((entry) => entry.id === "fail2ban")).toBe(false);
    });

    it("stays quiet about the trusted-LAN profile's allow-by-default and about rate-limited SSH", () => {
      const report = { ...base, defaults: { incoming: "accept", outgoing: "accept", routed: "reject" }, rules: [{ action: "limit", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: null, family: "both" }, { action: "allow", protocol: "udp", port: 41641, app: null, direction: "in", interface: null, comment: null, family: "both" }] };
      const ids = adviseFirewall({ report, current: { id: "trusted-lan" } }).map((entry) => entry.id);
      expect(ids).not.toContain("default-deny");
      expect(ids).not.toContain("ssh-limit");
      expect(ids).not.toContain("tailscale-udp");
    });
  });
});

describe("a rule left holding a port open for nothing", () => {
  const base = {
    report: { installed: true, enabled: true, defaults: { incoming: "deny" }, rules: [] },
    listeners: [], apps: [], webPort: 8787, webHost: "127.0.0.1",
  };
  const orphans = (advice) => advice.filter((entry) => entry.id.startsWith("orphan-"));

  it("names where the app went, which is the case that actually happens", () => {
    // Switching Pi-hole to host networking moved its admin page from 8084 to 80. The rule for 8084
    // stayed behind, opening a port nothing answers while the page it was written for went dark.
    const advice = adviseFirewall({
      ...base,
      report: { ...base.report, rules: [{ action: "allow", port: 8084, protocol: "tcp", direction: "in", comment: "Pi-hole" }] },
      listeners: [{ port: 80, protocol: "tcp", address: "0.0.0.0" }],
      apps: [{ id: "pi-hole", name: "Pi-hole", ports: [{ port: 80, protocol: "tcp", label: "Admin UI" }] }],
    });
    const [found] = orphans(advice);
    expect(found.title).toBe("Pi-hole no longer uses port 8084");
    expect(found.detail).toContain("now publishes 80/tcp");
    expect(found).toMatchObject({ operationId: "firewall.rule.delete", parameters: { action: "allow", port: 8084, protocol: "tcp" } });
  });

  it("says the plainer thing when no installed app claims the rule", () => {
    const advice = adviseFirewall({
      ...base,
      report: { ...base.report, rules: [{ action: "allow", port: 9999, protocol: "tcp", direction: "in", comment: "something old" }] },
    });
    expect(orphans(advice)[0].title).toBe("Nothing is listening on port 9999");
  });

  it("stays quiet when something is actually listening", () => {
    const advice = adviseFirewall({
      ...base,
      report: { ...base.report, rules: [{ action: "allow", port: 53, protocol: "udp", direction: "in", comment: "DNS" }] },
      listeners: [{ port: 53, protocol: "udp", address: "0.0.0.0" }],
    });
    expect(orphans(advice)).toEqual([]);
  });

  it("stays quiet for an installed app whose container is merely stopped", () => {
    // The app still publishes the port; it is not listening because it is not running. Advising the
    // rule away would quietly close the door on an app the owner intends to start again.
    const advice = adviseFirewall({
      ...base,
      report: { ...base.report, rules: [{ action: "allow", port: 8096, protocol: "tcp", direction: "in", comment: "Jellyfin" }] },
      apps: [{ id: "jellyfin", name: "Jellyfin", ports: [{ port: 8096, protocol: "tcp", label: "Web UI" }] }],
    });
    expect(orphans(advice)).toEqual([]);
  });

  it("never offers to remove a rule that keeps you able to log in", () => {
    const advice = adviseFirewall({
      ...base,
      report: { ...base.report, rules: [{ action: "allow", port: 22, protocol: "tcp", direction: "in", comment: "SSH" }, { action: "allow", port: 8787, protocol: "tcp", direction: "in", comment: "BoxPilot" }] },
    });
    expect(orphans(advice)).toEqual([]);
  });
});

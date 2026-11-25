import { describe, expect, it } from "vitest";
import { adviseFirewall, buildPlan, isProtected, lanSubnets, mergeRuleFamilies, parseUserRules, profiles, protectedRules, ruleTarget, services, sshPortsFromSshdT } from "./firewall-profiles.mjs";

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

  it("never offers to remove a rule that only lets one address or range in", () => {
    // "Remove the rule" runs `ufw delete allow 3306/tcp`, which matches only the rule from anywhere:
    // for `allow from 192.168.8.20 to any port 3306` it failed with "does not exist any more", and
    // the advice came back on every visit.
    const fromOne = { action: "allow", port: 3306, protocol: "tcp", direction: "in", comment: null, source: "192.168.8.20" };
    const fromLan = { action: "allow", port: 9999, protocol: "tcp", direction: "in", comment: "something old", source: "192.168.8.0/24" };
    const advice = adviseFirewall({ ...base, report: { ...base.report, rules: [fromOne, fromLan] } });
    expect(advice.filter((entry) => entry.operationId === "firewall.rule.delete")).toEqual([]);
    expect(advice.some((entry) => entry.id === "risky-allow-3306-tcp")).toBe(false);
    expect(orphans(advice)).toEqual([]);
    // The same port allowed from anywhere is still flagged, and its removal still offered.
    const anywhere = adviseFirewall({ ...base, report: { ...base.report, rules: [fromOne, { ...fromOne, source: null }] } });
    expect(anywhere.find((entry) => entry.id === "risky-allow-3306-tcp")).toMatchObject({ operationId: "firewall.rule.delete", parameters: { action: "allow", port: 3306, protocol: "tcp" } });
  });

  it("never offers to remove a rule tied to an interface, an application profile or one address of this server", () => {
    // The tuples ufw writes for `allow in on eth0 to any port 8084 proto tcp`, `allow 'Nginx HTTP'`
    // and `allow to 192.168.1.5 port 3306 proto tcp`. `ufw delete allow 8084/tcp` matches none of
    // them, so each Remove failed for good, and the last was called "open to the whole LAN".
    const rules = parseUserRules([
      "### tuple ### allow tcp 8084 0.0.0.0/0 any 0.0.0.0/0 in_eth0",
      "### tuple ### allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 Nginx%20HTTP - in",
      "### tuple ### allow tcp 3306 192.168.1.5 any 0.0.0.0/0 in",
    ].join("\n"), "v4");
    expect(rules.map((rule) => [rule.port, rule.interface, rule.app, rule.destination, rule.deletable])).toEqual([
      [8084, "eth0", null, null, false],
      [80, null, "Nginx%20HTTP", null, false],
      [3306, null, null, "192.168.1.5", false],
    ]);
    const advice = adviseFirewall({ ...base, report: { ...base.report, rules } });
    expect(advice.filter((entry) => entry.operationId === "firewall.rule.delete")).toEqual([]);
    expect(advice.some((entry) => entry.id === "risky-allow-3306-tcp")).toBe(false);
    expect(orphans(advice)).toEqual([]);
    // The plain rule beside them is still the one the advice is about.
    const plain = parseUserRules("### tuple ### allow tcp 3306 0.0.0.0/0 any 0.0.0.0/0 in", "v4");
    expect(plain[0].deletable).toBe(true);
    expect(adviseFirewall({ ...base, report: { ...base.report, rules: [...rules, ...plain] } }).find((entry) => entry.id === "risky-allow-3306-tcp"))
      .toMatchObject({ operationId: "firewall.rule.delete", parameters: { action: "allow", port: 3306, protocol: "tcp" } });
  });

  it("never offers to remove a rule that keeps you able to log in", () => {
    const advice = adviseFirewall({
      ...base,
      report: { ...base.report, rules: [{ action: "allow", port: 22, protocol: "tcp", direction: "in", comment: "SSH" }, { action: "allow", port: 8787, protocol: "tcp", direction: "in", comment: "BoxPilot" }] },
    });
    expect(orphans(advice)).toEqual([]);
  });
});

// M90: applying a profile only ever added rules, so switching to "Tailscale only" ("The LAN sees SSH
// and nothing else") left every earlier service open while the Profile panel said "Nothing".
describe("what applying a profile closes (M90)", () => {
  const hex = (text) => Buffer.from(text).toString("hex");
  const tuple = (rest, comment) => `### tuple ### ${rest}${comment ? ` comment=${hex(comment)}` : ""}`;
  // What ufw's user.rules holds after Home server with Web and Plex, an app allowed by hand, a
  // LAN-only rule, a tailnet rule and the rules BoxPilot always keeps.
  const v4 = [
    tuple("allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot keeps SSH reachable"),
    tuple("allow udp 41641 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot keeps Tailscale reachable"),
    tuple("allow tcp 8787 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot keeps BoxPilot reachable"),
    tuple("allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0", "BoxPilot keeps the tailnet reachable"),
    tuple("allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot service: Web (HTTP/HTTPS)"),
    tuple("allow tcp 443 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot service: Web (HTTP/HTTPS)"),
    tuple("allow tcp 32400 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot service: Plex"),
    tuple("allow tcp 8096 0.0.0.0/0 any 0.0.0.0/0 in", "Jellyfin"),
    tuple("allow tcp 9000 0.0.0.0/0 any 192.168.1.0/24 in", "LAN only"),
    tuple("allow tcp 3000 0.0.0.0/0 any 100.64.0.0/10 in", "tailnet only"),
    tuple("deny tcp 25 0.0.0.0/0 any 0.0.0.0/0 out", "no mail out"),
  ].join("\n");
  const v6 = v4.replace(/0\.0\.0\.0\/0/g, "::/0").split("\n").filter((line) => !line.includes("192.168") && !line.includes("100.64")).join("\n");
  const existing = mergeRuleFamilies(parseUserRules(v4, "v4"), parseUserRules(v6, "v6"));
  const deletes = (plan) => plan.steps.filter((step) => step.args[1] === "delete").map((step) => step.args.slice(2).join(" "));

  it("closes every allow but the protected and tailnet ones when switching to Tailscale only", () => {
    const plan = buildPlan({ profileId: "tailscale-only", existing, webPort: 8787, webHost: "0.0.0.0" });
    expect(deletes(plan)).toEqual([
      "allow 80/tcp", "allow 443/tcp", "allow 32400/tcp", "allow 8096/tcp",
      "allow from 192.168.1.0/24 to any port 9000 proto tcp",
    ]);
    const argv = plan.steps.map((step) => step.args.join(" "));
    // Never SSH, Tailscale, BoxPilot's own port or the tailnet interface; never an outgoing rule.
    expect(argv.some((call) => / delete .*\b(22|41641|8787)\//.test(call) || call.includes("tailscale0") && call.includes("delete") || call.includes("delete deny"))).toBe(false);
    // Closing comes after the protected allows and before the firewall is turned on.
    expect(argv.indexOf("--force delete allow 80/tcp")).toBeGreaterThan(argv.findIndex((call) => call.startsWith("allow in on tailscale0")));
    expect(argv.indexOf("--force delete allow 80/tcp")).toBeLessThan(argv.indexOf("--force enable"));
    expect(plan.steps.find((step) => step.args.join(" ") === "--force delete allow 32400/tcp")).toMatchObject({ label: "Close 32400/tcp (Plex): Tailscale only opens nothing on the LAN", removes: { action: "allow", port: 32400, protocol: "tcp", source: null, comment: "BoxPilot service: Plex" } });
  });

  it("closes only the services no longer ticked on Home server, and leaves rules the owner wrote", () => {
    const plan = buildPlan({ profileId: "home-server", serviceIds: ["web"], existing });
    expect(deletes(plan)).toEqual(["allow 32400/tcp"]);
    expect(buildPlan({ profileId: "home-server", serviceIds: ["web", "plex"], existing }).steps.some((step) => step.removes)).toBe(false);
  });

  it("closes nothing when starting from scratch, since the reset already does", () => {
    expect(buildPlan({ profileId: "tailscale-only", replace: true, existing }).steps.some((step) => step.removes)).toBe(false);
  });

  it("drops the trusted-LAN profile's deny rules only once the new default is deny", () => {
    const trusted = parseUserRules(tuple("deny tcp 3306 0.0.0.0/0 any 0.0.0.0/0 in", "BoxPilot profile: MySQL / MariaDB"), "v4");
    const argv = buildPlan({ profileId: "home-server", existing: trusted }).steps.map((step) => step.args.join(" "));
    expect(argv.indexOf("--force delete deny 3306/tcp")).toBeGreaterThan(argv.indexOf("default deny incoming"));
    expect(argv.indexOf("--force delete deny 3306/tcp")).toBeLessThan(argv.indexOf("--force enable"));
    expect(buildPlan({ profileId: "trusted-lan", existing: trusted }).steps.some((step) => step.removes)).toBe(false);
  });
});

describe("where a rule lets traffic in from (M90)", () => {
  it("writes and deletes a rule from one range with the same words", () => {
    expect(ruleTarget({ port: 8096, protocol: "tcp" })).toEqual(["8096/tcp"]);
    expect(ruleTarget({ port: 8096, protocol: "tcp", source: "192.168.1.0/24" })).toEqual(["from", "192.168.1.0/24", "to", "any", "port", "8096", "proto", "tcp"]);
    expect(ruleTarget({ port: 53, protocol: "any", source: "100.64.0.0/10" })).toEqual(["from", "100.64.0.0/10", "to", "any", "port", "53"]);
  });

  it("finds this LAN from the server's own private addresses, not the tailnet's or Docker's", () => {
    expect(lanSubnets({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
      tailscale0: [{ address: "100.101.1.2", family: "IPv4", internal: false, cidr: "100.101.1.2/32" }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, cidr: "172.17.0.1/16" }],
      eth0: [{ address: "192.168.1.5", family: "IPv4", internal: false, cidr: "192.168.1.5/24" }, { address: "2001:db8::5", family: "IPv6", internal: false, cidr: "2001:db8::5/64" }],
      wlan0: [{ address: "203.0.113.9", family: "IPv4", internal: false, cidr: "203.0.113.9/24" }],
    })).toEqual(["192.168.1.0/24"]);
    expect(lanSubnets({ enp3s0: [{ address: "10.1.2.3", family: 4, internal: false, cidr: "10.1.2.3/16" }] })).toEqual(["10.1.0.0/16"]);
    expect(lanSubnets({})).toEqual([]);
  });

  it("opens an app to this LAN, rate-limits SSH in one rule, and sends plain HTTP to Network", () => {
    const report = { installed: true, enabled: true, defaults: { incoming: "drop", outgoing: "accept", routed: "reject" }, rules: [{ action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: null, family: "both" }] };
    const advice = adviseFirewall({ report, apps: [{ id: "jellyfin", name: "Jellyfin", ports: [{ port: 8096, protocol: "tcp", label: "Web UI" }] }], webHost: "0.0.0.0", lan: "192.168.1.0/24" });
    expect(advice.find((entry) => entry.id === "app-jellyfin-8096-tcp")).toMatchObject({ operationId: "firewall.rule.add", parameters: { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin", source: "192.168.1.0/24" } });
    const limit = advice.find((entry) => entry.id === "ssh-limit");
    expect(limit).toMatchObject({ operationId: "firewall.rule.add", parameters: { action: "limit", port: 22, protocol: "tcp" } });
    expect(limit.focus).toBeUndefined();
    const http = advice.find((entry) => entry.id === "lan-http");
    expect(http).toMatchObject({ focus: "network" });
    expect(http.detail).toContain("turn off LAN access, or set up HTTPS");
    expect(http.detail).not.toContain("installer");
    // Beside a LAN-only SSH rule, `limit 22/tcp` would add one from anywhere: not offered.
    const lanOnly = adviseFirewall({ report: { ...report, rules: [{ ...report.rules[0], source: "192.168.1.0/24" }] } });
    expect(lanOnly.some((entry) => entry.id === "ssh-limit")).toBe(false);
  });
});

// M90 review: "Tailscale only" deleted BoxPilot's own HTTPS port (web-tls writes a bare
// `ufw allow 8443/tcp`) and a custom SSH port, because only 22, 41641 and the web port were protected.
describe("what a profile may never close (M90 review)", () => {
  const rule = (action, port, extra = {}) => ({ action, protocol: "tcp", port, app: null, source: null, destination: null, direction: "in", interface: null, comment: null, family: "both", ...extra });
  const deletes = (plan) => plan.steps.filter((step) => step.removes).map((step) => step.args.join(" "));

  it("reads sshd's ports from sshd -T, its listen addresses included, and says when there are none", () => {
    expect(sshPortsFromSshdT("port 2222\npermitrootlogin no\n")).toEqual([2222]);
    expect(sshPortsFromSshdT("port 22\nport 2222\nlistenaddress [::]:2222\nlistenaddress 0.0.0.0:4022\n")).toEqual([22, 2222, 4022]);
    expect(sshPortsFromSshdT("permitrootlogin no\n")).toBeNull();
    expect(sshPortsFromSshdT("")).toBeNull();
    expect(sshPortsFromSshdT("port 99999\n")).toBeNull();
  });

  it("keeps the HTTPS port while a certificate is set and the page is on the LAN, and sshd's ports", () => {
    const list = protectedRules({ webPort: 8787, webHost: "0.0.0.0", tlsPort: 8443, sshPorts: [2222] });
    expect(list.map((entry) => [entry.port, entry.protocol, entry.kind, entry.allow])).toEqual([[22, "tcp", "ssh", true], [2222, "tcp", "ssh", true], [41641, "udp", "tailscale", true], [8787, "tcp", "web", true], [8443, "tcp", "tls", true]]);
    // On loopback the HTTPS listener is too, so there is nothing on the LAN to keep.
    expect(protectedRules({ webHost: "127.0.0.1", tlsPort: 8443 }).some((entry) => entry.port === 8443)).toBe(false);
  });

  it("does not close the HTTPS port or sshd's port on Tailscale only", () => {
    const existing = [rule("allow", 8443), rule("limit", 2222), rule("allow", 2222, { source: "192.168.1.0/24" }), rule("allow", 8443, { protocol: "udp" }), rule("allow", 3000)];
    const plan = buildPlan({ profileId: "tailscale-only", webPort: 8787, webHost: "0.0.0.0", tlsPort: 8443, sshPorts: [2222], existing });
    expect(deletes(plan)).toEqual(["--force delete allow 3000/tcp"]);
    expect(plan.steps.map((step) => step.args.join(" "))).toContain("allow 2222/tcp comment BoxPilot keeps SSH reachable");
    expect(plan.notes).toEqual([]);
    // Rate-limiting covers every SSH port.
    const limited = buildPlan({ profileId: "home-server", sshRateLimit: true, sshPorts: [2222] });
    expect(limited.steps.map((step) => step.args.slice(0, 2).join(" "))).toEqual(expect.arrayContaining(["limit 22/tcp", "limit 2222/tcp"]));
  });

  it("closes nothing that could be SSH's when its port is unknown, and says so", () => {
    const existing = [rule("limit", 4022), rule("allow", 2222), rule("allow", 5000, { comment: "SSH for the NAS" }), rule("allow", 3000), rule("deny", 2222, { comment: "BoxPilot profile: old" })];
    const plan = buildPlan({ profileId: "tailscale-only", sshPorts: null, existing });
    expect(deletes(plan)).toEqual(["--force delete allow 3000/tcp", "--force delete deny 2222/tcp"]);
    expect(plan.notes[0]).toContain("SSH port could not be read");
    // Known, the same 2222 allow is an ordinary rule again.
    expect(deletes(buildPlan({ profileId: "tailscale-only", sshPorts: [22], existing }))).toContain("--force delete allow 2222/tcp");
  });
});

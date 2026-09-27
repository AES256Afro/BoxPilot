import { describe, expect, it, vi } from "vitest";
import { beginMarker, chainName, endMarker, hasDockerRules, parseUfwStatus, renderDockerRules, spliceManagedBlock, syncDockerRules } from "./firewall-docker.mjs";

const status = [
  "Status: active",
  "Logging: on (low)",
  "Default: deny (incoming), allow (outgoing), disabled (routed)",
  "",
  "To                         Action      From",
  "--                         ------      ----",
  "22/tcp                     LIMIT IN    Anywhere",
  "41641/udp                  ALLOW IN    Anywhere",
  "Anywhere on tailscale0     ALLOW IN    Anywhere",
  "8096/tcp                   ALLOW IN    Anywhere",
  "53                         ALLOW IN    Anywhere",
  "5432/tcp                   DENY IN     Anywhere",
  "32400/tcp                  ALLOW IN    192.168.50.0/24",
  "22/tcp (v6)                LIMIT IN    Anywhere (v6)",
].join("\n");

describe("docker firewall rules", () => {
  it("reads the policy and port rules from ufw status, skipping interface and IPv6 rows", () => {
    const parsed = parseUfwStatus(status);
    expect(parsed.active).toBe(true);
    expect(parsed.defaultIncoming).toBe("deny");
    expect(parsed.allowed).toEqual([
      { port: 22, protocol: "tcp", from: null }, { port: 41641, protocol: "udp", from: null }, { port: 8096, protocol: "tcp", from: null },
      { port: 53, protocol: "tcp", from: null }, { port: 53, protocol: "udp", from: null }, { port: 32400, protocol: "tcp", from: "192.168.50.0/24" },
    ]);
    expect(parsed.denied).toEqual([{ port: 5432, protocol: "tcp", from: null }]);
    expect(parseUfwStatus("Status: inactive").active).toBe(false);
    expect(parseUfwStatus("Default: allow (incoming), allow (outgoing)").defaultIncoming).toBe("allow");
  });

  it("renders a deny-default chain that returns for allowed ports and drops the rest", () => {
    const block = renderDockerRules(parseUfwStatus(status));
    expect(block.startsWith(beginMarker)).toBe(true);
    expect(block.trim().endsWith(endMarker)).toBe(true);
    expect(block).toContain(`-I DOCKER-USER 1 -j ${chainName}`);
    expect(block).toContain(`-A ${chainName} -i tailscale0 -j RETURN`);
    expect(block).toContain(`-A ${chainName} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`);
    expect(block).toContain(`-A ${chainName} -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL -j DROP`);
    expect(block).toContain(`-A ${chainName} -p tcp -m conntrack --ctorigdstport 8096 --ctdir ORIGINAL -j RETURN`);
    expect(block).toContain(`-A ${chainName} -p tcp -s 192.168.50.0/24 -m conntrack --ctorigdstport 32400 --ctdir ORIGINAL -j RETURN`);
    expect(block.trim().split("\n").at(-3)).toBe(`-A ${chainName} -j DROP`);
    expect(block.indexOf("5432")).toBeLessThan(block.indexOf("8096"));
  });

  it("renders an allow-default chain that only drops denied ports", () => {
    const block = renderDockerRules({ defaultIncoming: "allow", allowed: [{ port: 80, protocol: "tcp", from: null }], denied: [{ port: 3306, protocol: "tcp", from: null }] });
    expect(block).toContain("--ctorigdstport 3306 --ctdir ORIGINAL -j DROP");
    expect(block).not.toContain("--ctorigdstport 80 ");
    expect(block.trim().split("\n").at(-3)).toBe(`-A ${chainName} -j RETURN`);
  });

  it("splices the managed block in, replaces it, and removes it", () => {
    const original = "# ufw after.rules\n*filter\n:ufw-after-input - [0:0]\nCOMMIT\n";
    const once = spliceManagedBlock(original, renderDockerRules({ allowed: [{ port: 1, protocol: "tcp", from: null }] }));
    expect(once.startsWith(original)).toBe(true);
    expect(hasDockerRules(once)).toBe(true);
    const twice = spliceManagedBlock(once, renderDockerRules({ allowed: [{ port: 2, protocol: "tcp", from: null }] }));
    expect(twice.split(beginMarker).length).toBe(2);
    expect(twice).toContain("--ctorigdstport 2 ");
    expect(twice).not.toContain("--ctorigdstport 1 ");
    expect(spliceManagedBlock(twice, null)).toBe(original);
    expect(hasDockerRules(original)).toBe(false);
  });

  it("writes the block, reattaches the chain, and reloads ufw", async () => {
    const files = { "/etc/ufw/after.rules": "*filter\nCOMMIT\n" };
    const run = vi.fn(async (binary, args) => {
      if (args[0] === "status") return { ok: true, stdout: status, stderr: "" };
      if (binary.endsWith("iptables") && args[0] === "-D") return { ok: false, stdout: "", stderr: "No chain/target/match by that name." };
      return { ok: true, stdout: "", stderr: "" };
    });
    const log = vi.fn();
    const result = await syncDockerRules({ enabled: true }, { run, log, read: async (file) => files[file], write: async (file, content) => { files[file] = content; } });
    expect(result).toMatchObject({ synced: true, enabled: true, defaultIncoming: "deny" });
    expect(hasDockerRules(files["/etc/ufw/after.rules"])).toBe(true);
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain(`iptables -F ${chainName}`);
    expect(calls).toContain(`iptables -X ${chainName}`);
    expect(calls.at(-1)).toBe("ufw reload");
    expect(log.mock.calls.at(-1)[0]).toContain("follow the firewall");
  });

  it("backs the block out when ufw rejects it", async () => {
    const original = "*filter\nCOMMIT\n";
    const files = { "/etc/ufw/after.rules": original };
    let reloads = 0;
    const run = vi.fn(async (binary, args) => {
      if (args[0] === "status") return { ok: true, stdout: status, stderr: "" };
      if (args[0] === "reload") { reloads += 1; return reloads === 1 ? { ok: false, stdout: "", stderr: "Problem running '/etc/ufw/after.rules'" } : { ok: true, stdout: "", stderr: "" }; }
      return { ok: false, stdout: "", stderr: "" };
    });
    await expect(syncDockerRules({ enabled: true }, { run, read: async (file) => files[file], write: async (file, content) => { files[file] = content; } })).rejects.toThrow("backed out");
    expect(files["/etc/ufw/after.rules"]).toBe(original);
    expect(reloads).toBe(2);
  });

  it("removes the block and chain when the firewall is turned off, and tolerates a missing file", async () => {
    const files = { "/etc/ufw/after.rules": spliceManagedBlock("*filter\nCOMMIT\n", renderDockerRules({})) };
    const run = vi.fn(async () => ({ ok: false, stdout: "", stderr: "" }));
    const result = await syncDockerRules({ enabled: false }, { run, read: async (file) => files[file], write: async (file, content) => { files[file] = content; } });
    expect(result).toEqual({ synced: true, enabled: false });
    expect(hasDockerRules(files["/etc/ufw/after.rules"])).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.join(" ") === "reload")).toBe(false);
    const missing = await syncDockerRules({ enabled: true }, { run, read: async () => { throw new Error("ENOENT"); } });
    expect(missing).toMatchObject({ synced: false, reason: "after-rules-missing" });
  });
});

describe("when ufw's own rules cannot be read", () => {
  it("leaves the Docker rules alone instead of rendering a chain that drops every published port", async () => {
    const written = [];
    const run = vi.fn(async (_binary, args) => (args[0] === "status"
      ? { ok: false, stdout: "", stderr: "ERROR: problem running ufw-init" }
      : { ok: true, stdout: "", stderr: "" }));
    await expect(syncDockerRules({ enabled: true }, {
      run,
      read: async () => "# after.rules\nCOMMIT\n",
      write: async (path, text) => { written.push({ path, text }); },
    })).rejects.toThrow(/could not read the firewall's own rules/i);
    expect(written).toEqual([]); // nothing was rewritten on a guess
    expect(run.mock.calls.some(([, args]) => args[0] === "reload")).toBe(false);
  });

  it("refuses to mirror an inactive firewall, which would read as no allowed ports at all", async () => {
    const run = vi.fn(async (_binary, args) => (args[0] === "status"
      ? { ok: true, stdout: "Status: inactive\n", stderr: "" }
      : { ok: true, stdout: "", stderr: "" }));
    await expect(syncDockerRules({ enabled: true }, {
      run,
      read: async () => "# after.rules\nCOMMIT\n",
      write: async () => {},
    })).rejects.toThrow(/not active/i);
  });
});

describe("ufw rules that carry a comment", () => {
  // What `ufw status verbose` prints after a BoxPilot profile apply: every rule BoxPilot adds has a
  // comment, and ufw appends it after the source column as `# comment`.
  const commented = [
    "Status: active",
    "Logging: on (low)",
    "Default: allow (incoming), allow (outgoing), deny (routed)",
    "New profiles: skip",
    "",
    "To                         Action      From",
    "--                         ------      ----",
    "22/tcp                     LIMIT IN    Anywhere                   # BoxPilot keeps SSH reachable (rate-limited)",
    "41641/udp                  ALLOW IN    Anywhere                   # BoxPilot keeps Tailscale reachable",
    "Anywhere on tailscale0     ALLOW IN    Anywhere                   # BoxPilot keeps the tailnet reachable",
    "5432/tcp                   DENY IN     Anywhere                   # BoxPilot profile: PostgreSQL",
    "6379/tcp                   DENY IN     Anywhere                   # BoxPilot profile: Redis",
    "8123/tcp                   ALLOW IN    192.168.1.0/24             # BoxPilot service: Home Assistant",
    "9000/tcp on eth0           ALLOW IN    Anywhere                   # Portainer",
    "Anywhere                   ALLOW FWD   Anywhere                   # routed",
    "22/tcp (v6)                LIMIT IN    Anywhere (v6)              # BoxPilot keeps SSH reachable (rate-limited)",
    "6379/tcp (v6)              DENY IN     Anywhere (v6)              # BoxPilot profile: Redis",
    "Anywhere (v6) on tailscale0 ALLOW IN   Anywhere (v6)              # BoxPilot keeps the tailnet reachable",
    "",
  ].join("\n");

  it("mirrors commented rules instead of dropping them, and still skips IPv6, interface, and routed rows", () => {
    const parsed = parseUfwStatus(commented);
    expect(parsed.defaultIncoming).toBe("allow");
    expect(parsed.denied).toEqual([{ port: 5432, protocol: "tcp", from: null }, { port: 6379, protocol: "tcp", from: null }]);
    expect(parsed.allowed).toEqual([
      { port: 22, protocol: "tcp", from: null }, { port: 41641, protocol: "udp", from: null }, { port: 8123, protocol: "tcp", from: "192.168.1.0/24" },
    ]);
  });

  it("drops the trusted-lan risky ports from Docker-published traffic too", () => {
    const block = renderDockerRules(parseUfwStatus(commented));
    expect(block).toContain(`-A ${chainName} -p tcp -m conntrack --ctorigdstport 6379 --ctdir ORIGINAL -j DROP`);
    expect(block).toContain(`-A ${chainName} -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL -j DROP`);
  });

  it("lets ticked services through a deny-default chain", () => {
    const block = renderDockerRules(parseUfwStatus(commented.replace("Default: allow (incoming)", "Default: deny (incoming)")));
    expect(block).toContain(`-A ${chainName} -p tcp -s 192.168.1.0/24 -m conntrack --ctorigdstport 8123 --ctdir ORIGINAL -j RETURN`);
    expect(block).not.toContain("--ctorigdstport 9000 ");
  });
});

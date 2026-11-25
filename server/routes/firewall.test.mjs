import express from "express";
import { describe, expect, it } from "vitest";
import { createFirewallRouter } from "./firewall.mjs";

const rules = [
  { action: "allow", protocol: "tcp", port: 22, app: null, source: null, destination: null, direction: "in", interface: null, comment: "BoxPilot keeps SSH reachable", family: "both" },
  { action: "allow", protocol: "tcp", port: 80, app: null, source: null, destination: null, direction: "in", interface: null, comment: "BoxPilot service: Web (HTTP/HTTPS)", family: "both" },
  { action: "allow", protocol: "tcp", port: 32400, app: null, source: null, destination: null, direction: "in", interface: null, comment: "BoxPilot service: Plex", family: "both" },
];

async function serve({ inspect = async () => ({ installed: true, enabled: true, defaults: { incoming: "drop", outgoing: "accept", routed: "reject" }, rules }) } = {}) {
  const helper = { request: async (id) => (id === "firewall.inspect" ? inspect() : id === "app.inspect" ? { applications: [] } : null) };
  const app = express();
  app.use("/api/v1", createFirewallRouter({
    state: { getSetting: () => null }, helper, catalogService: { get: async () => null }, webPort: 8787, webHost: "127.0.0.1",
    listeners: async () => [],
    getNetworkInterfaces: () => ({ eth0: [{ address: "192.168.1.5", family: "IPv4", internal: false, cidr: "192.168.1.5/24" }] }),
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// M90: the preview is built against the rules in place, so it lists what applying a profile closes.
describe("the firewall plan preview", () => {
  it("lists the deletions Tailscale only makes, from the rules the helper reads", async () => {
    const { base, close } = await serve();
    try {
      const plan = await (await fetch(`${base}/firewall/plan?profile=tailscale-only`)).json();
      const removes = plan.steps.filter((step) => step.removes).map((step) => step.args.join(" "));
      expect(removes).toEqual(["--force delete allow 80/tcp", "--force delete allow 32400/tcp"]);
      const home = await (await fetch(`${base}/firewall/plan?profile=home-server&services=web`)).json();
      expect(home.steps.filter((step) => step.removes).map((step) => step.args.join(" "))).toEqual(["--force delete allow 32400/tcp"]);
    } finally {
      await close();
    }
  });

  it("says it cannot list what closes when the rules cannot be read, rather than showing a plan that closes nothing", async () => {
    const { base, close } = await serve({ inspect: async () => { throw new Error("helper down"); } });
    try {
      const response = await fetch(`${base}/firewall/plan?profile=tailscale-only`);
      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("could not be read");
      // Starting from scratch resets everything, so it needs no read.
      expect((await fetch(`${base}/firewall/plan?profile=tailscale-only&replace=true`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("tells the page this LAN's range and the tailnet's, for the add form's From", async () => {
    const { base, close } = await serve();
    try {
      const overview = await (await fetch(`${base}/firewall/overview`)).json();
      expect(overview.sources).toEqual({ lan: "192.168.1.0/24", tailnet: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"] });
    } finally {
      await close();
    }
  });
});

// M90 review: the preview keeps what the root task keeps: the HTTPS port (from this process's env)
// and sshd's port (from firewall.inspect).
describe("the preview keeps BoxPilot's HTTPS port and SSH's port", () => {
  it("lists no deletion of either", async () => {
    const withExtras = [...rules, { ...rules[1], port: 8443, comment: null }, { ...rules[1], action: "limit", port: 2222, comment: null }];
    const helper = { request: async (id) => (id === "firewall.inspect" ? { installed: true, enabled: true, defaults: null, rules: withExtras, sshPorts: [2222] } : id === "app.inspect" ? { applications: [] } : null) };
    const app = express();
    app.use("/api/v1", createFirewallRouter({
      state: { getSetting: () => null }, helper, catalogService: { get: async () => null }, webPort: 8787, webHost: "0.0.0.0",
      listeners: async () => [], getNetworkInterfaces: () => ({}),
      env: { BOXPILOT_TLS_CERT: "/etc/boxpilot/tls/leaf.crt", BOXPILOT_TLS_KEY: "/etc/boxpilot/tls/leaf.key", BOXPILOT_TLS_PORT: "8443" },
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;
    try {
      const plan = await (await fetch(`${base}/firewall/plan?profile=tailscale-only`)).json();
      expect(plan.steps.filter((step) => step.removes).map((step) => step.args.join(" "))).toEqual(["--force delete allow 80/tcp", "--force delete allow 32400/tcp"]);
      const overview = await (await fetch(`${base}/firewall/overview`)).json();
      expect(overview.protected.map((entry) => entry.port)).toEqual([22, 2222, 41641, 8787, 8443]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

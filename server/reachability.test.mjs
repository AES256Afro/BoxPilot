import http from "node:http";
import { describe, expect, it } from "vitest";
import { composeVerdicts, planProbes } from "./reachability.mjs";
import { probeAddresses } from "./tasks/reachability.mjs";

const facts = {
  installed: true, running: true, sidecars: [],
  lanAddress: "192.168.1.10", tailnetAddress: "100.64.0.9", tailnetDnsName: "homebox.tail0a1b.ts.net",
  ports: [{ id: "web", label: "Web UI", host: 8095, exposure: "lan", protocol: "tcp" }],
};

describe("which addresses the doctor decides to check", () => {
  it("plans LAN and tailnet probes for a LAN port, and explains the form browsers refuse", () => {
    const plan = planProbes(facts);
    expect(plan.map((address) => [address.kind, address.url])).toEqual([
      ["lan", "http://192.168.1.10:8095"],
      ["tailnet", "http://100.64.0.9:8095"],
      ["browser-rule", "http://homebox.tail0a1b.ts.net:<port>"],
    ]);
    expect(plan.find((address) => address.kind === "browser-rule").probe).toBe(false);
    expect(plan.find((address) => address.kind === "browser-rule").note).toMatch(/HSTS preload/);
    expect(plan.find((address) => address.kind === "tailnet").note).toMatch(/http:\/\/homebox:<port>/);
  });

  it("plans the Serve address and its loopback end for a tailnet-only port", () => {
    const tunneled = { ...facts, ports: [{ id: "web", label: "Web UI", host: 8095, exposure: "loopback", protocol: "tcp" }] };
    const plan = planProbes(tunneled, [{ dnsName: "homebox.tail0a1b.ts.net", port: 8095, target: "http://127.0.0.1:8095" }]);
    expect(plan.map((address) => [address.kind, address.url])).toEqual([
      ["serve", "https://homebox.tail0a1b.ts.net:8095"],
      ["loopback", "http://127.0.0.1:8095"],
    ]);
    expect(plan[1].note).toMatch(/local end of the Serve address/);
  });

  it("skips udp ports and addresses the host does not have", () => {
    const bare = { ...facts, lanAddress: null, tailnetAddress: null, tailnetDnsName: null, ports: [...facts.ports, { id: "dns", label: "DNS", host: 53, exposure: "lan", protocol: "udp" }] };
    expect(planProbes(bare)).toEqual([]);
  });
});

describe("what the verdicts say", () => {
  it("names a broken helper container as the headline, before any address talk", () => {
    const plan = planProbes(facts);
    const { headline } = composeVerdicts(plan, [], { ...facts, sidecars: [{ id: "vpn", running: true, status: "restarting", restarts: 4 }] });
    expect(headline).toMatch(/vpn container is restarting over and over.*Its log says why/);
  });

  it("reads answered, refused, and dropped apart, in the owner's terms", () => {
    const plan = planProbes(facts);
    const { headline, addresses } = composeVerdicts(plan, [
      { id: plan[0].id, outcome: "answered", status: 200, ms: 12 },
      { id: plan[1].id, outcome: "timeout", ms: 4000 },
    ], facts);
    expect(headline).toBeNull();
    expect(addresses[0].verdict).toBe("Answers (HTTP 200 in 12ms).");
    expect(addresses[1].verdict).toMatch(/silently dropped.*firewall/);
    expect(addresses[2].outcome).toBe("not-probed");
  });

  it("says a self-signed certificate means a warning, not a failure", () => {
    const plan = planProbes(facts);
    const { addresses } = composeVerdicts(plan, [{ id: plan[0].id, outcome: "answered", status: 401, ms: 30, tls: "unverified" }], facts);
    expect(addresses[0].verdict).toMatch(/HTTP 401 in 30ms; the certificate is self-signed/);
  });
});

describe("the prober, against a real socket", () => {
  it("reports answered with the status, and refused where nothing listens", async () => {
    const server = http.createServer((request, response) => { response.statusCode = 401; response.end("Unauthorized"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const { results } = await probeAddresses({ probes: [
        { id: "up", url: `http://127.0.0.1:${port}/` },
        { id: "down", url: "http://127.0.0.1:1/" },
        { id: "junk", url: "gopher://x" },
      ] });
      expect(results.find((entry) => entry.id === "up")).toMatchObject({ outcome: "answered", status: 401 });
      expect(results.find((entry) => entry.id === "down").outcome).toBe("refused");
      expect(results.find((entry) => entry.id === "junk").outcome).toBe("error");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("bounds how many addresses one ask may probe", async () => {
    await expect(probeAddresses({ probes: Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, url: "http://127.0.0.1:1/" })) })).rejects.toThrow(/At most 12/);
  });
});

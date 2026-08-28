import { describe, expect, it, vi } from "vitest";
import { aggregateAppStats, appOperations, parseDockerStats, parseServeStatus } from "./apps.mjs";

const operations = Object.fromEntries(appOperations().map((operation) => [operation.id, operation]));

const serveJson = JSON.stringify({
  TCP: { 8093: { HTTPS: true } },
  Web: { "homebox.tail1234.ts.net:8093": { Handlers: { "/": { Proxy: "http://127.0.0.1:8093" } } } },
  AllowFunnel: {},
});

function fakeApps(installed = true, port = 8093) {
  return { inspect: vi.fn(async () => ({ applications: [{ id: "ntfy", installed, urls: installed && port ? [{ id: "web", host: port, exposure: "lan" }] : [] }] })) };
}

describe("the reachability op hands the task everything the planner decided", () => {
  it("keeps sourceAddress on outside-vantage probes", async () => {
    const facts = {
      installed: true, running: true, sidecars: [], serves: [],
      lanAddress: "192.168.1.10", tailnetAddress: null, tailnetDnsName: null,
      ports: [{ id: "web", label: "Web UI", host: 8095, exposure: "lan", protocol: "tcp" }],
    };
    let handed = null;
    await operations["app.reachability.inspect"].run({ id: "demo" }, {
      apps: { reachabilityFacts: async () => facts },
      runUnit: { runTask: async (name, parameters) => { handed = parameters; return { results: [] }; } },
      jobLog: null,
    });
    const outside = handed.probes.find((probe) => probe.sourceAddress);
    // The outside vantage is the whole feature; dropping this field once shipped it inert.
    expect(outside).toMatchObject({ url: "http://192.168.1.10:8095", sourceAddress: "192.168.1.10" });
  });
});

describe("app stats", () => {
  it("parses docker stats lines and rolls sidecars up into their app", () => {
    const output = [
      JSON.stringify({ Name: "bp-paperless-ngx", CPUPerc: "2.50%", MemUsage: "512MiB / 31.2GiB" }),
      JSON.stringify({ Name: "bp-paperless-ngx-broker", CPUPerc: "0.30%", MemUsage: "18.5MiB / 31.2GiB" }),
      JSON.stringify({ Name: "bp-ntfy", CPUPerc: "0.05%", MemUsage: "22MiB / 31.2GiB" }),
      JSON.stringify({ Name: "unrelated-container", CPUPerc: "9.99%", MemUsage: "1GiB / 31.2GiB" }),
      "garbage line",
    ].join("\n");
    const rows = parseDockerStats(output);
    expect(rows[0]).toEqual({ name: "bp-paperless-ngx", cpuPercent: 2.5, memBytes: 512 * 1024 ** 2 });
    const stats = aggregateAppStats(rows, ["paperless-ngx", "ntfy"]);
    expect(stats["paperless-ngx"]).toEqual({ cpuPercent: 2.8, memBytes: Math.round(512 * 1024 ** 2 + 18.5 * 1024 ** 2), containers: 2 });
    expect(stats.ntfy.containers).toBe(1);
    expect(Object.keys(stats)).toHaveLength(2);
  });
});

describe("app serve operations", () => {
  it("parses tailscale serve status", () => {
    expect(parseServeStatus(serveJson)).toEqual([{ dnsName: "homebox.tail1234.ts.net", port: 8093, target: "http://127.0.0.1:8093" }]);
    expect(parseServeStatus("garbage")).toEqual([]);
    expect(parseServeStatus("{}")).toEqual([]);
  });

  it("publishes an installed app's web port over tailnet HTTPS and reports the URL", async () => {
    const run = vi.fn(async (_binary, args) => {
      if (args[1] === "status") return { ok: true, stdout: serveJson, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const result = await operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: fakeApps() });
    expect(result).toEqual({ id: "ntfy", enabled: true, port: 8093, url: "https://homebox.tail1234.ts.net:8093" });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["serve", "--bg", "--yes", "--https=8093", "http://127.0.0.1:8093"], expect.anything());

    await operations["app.serve.set"].run({ id: "ntfy", enabled: false }, { run, apps: fakeApps() });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["serve", "--yes", "--https=8093", "off"], expect.anything());
  });

  it("refuses to publish apps that are not installed or have no web port", async () => {
    const run = vi.fn();
    await expect(operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: fakeApps(false) })).rejects.toThrow("not installed");
    await expect(operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: fakeApps(true, null) })).rejects.toThrow("no web port");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports serve state and degrades quietly when tailscale is absent", async () => {
    const up = vi.fn(async () => ({ ok: true, stdout: serveJson, stderr: "" }));
    await expect(operations["app.serve.inspect"].run({}, { run: up })).resolves.toEqual({ available: true, serves: [{ dnsName: "homebox.tail1234.ts.net", port: 8093, target: "http://127.0.0.1:8093" }] });
    const down = vi.fn(async () => ({ ok: false, stdout: "", stderr: "no tailscaled" }));
    await expect(operations["app.serve.inspect"].run({}, { run: down })).resolves.toEqual({ available: false, serves: [] });
  });
});

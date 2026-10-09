import { describe, expect, it, vi } from "vitest";
import { checkpointCeilingMs } from "../app-helper.mjs";
import { aggregateAppStats, appOperations, parseDockerStats, parseServeStatus } from "./apps.mjs";

const operations = Object.fromEntries(appOperations().map((operation) => [operation.id, operation]));

describe("operations that take a checkpoint first", () => {
  // A checkpoint is a whole app backup. With a 15- or 40-minute budget, a 60-minute archive alone
  // outlasted the job: it was recorded failed ("may still be running") while the helper finished
  // the backup, and then the change, with nobody watching.
  const minutes = (value) => value * 60_000;
  const ownSteps = { "app.update": minutes(40), "app.rollback": minutes(40), "app.reconfigure": minutes(15), "app.compose.edit": minutes(20), "app.backup.restore-path": minutes(60), "app.backup.restore": minutes(90) };

  it("budget the checkpoint's whole ceiling on top of their own steps", () => {
    expect(checkpointCeilingMs).toBeGreaterThanOrEqual(minutes(60));
    for (const [id, own] of Object.entries(ownSteps)) expect(operations[id].timeoutMs, id).toBeGreaterThanOrEqual(checkpointCeilingMs + own);
  });

  it("still offer more time where they did, as several times the larger budget", () => {
    for (const id of ["app.update", "app.rollback"]) expect(operations[id].maxTimeoutMs, id).toBe(4 * operations[id].timeoutMs);
  });
});

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

  // The Dockge port trap (2026-09-29): Dockge was on the home network (every address) and served at the same port, so
  // tailscaled held 100.x:5001 and Docker could not publish 0.0.0.0:5001 after a restart.
  it("refuses to serve an app published on every address, and serves one on loopback", async () => {
    const run = vi.fn(async (_binary, args) => (args[1] === "status" ? { ok: true, stdout: serveJson, stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    const published = (bind) => ({ inspect: vi.fn(async () => ({ applications: [{ id: "ntfy", name: "ntfy", installed: true, urls: [{ id: "web", host: 8093, exposure: "lan" }], published: [{ id: "web", host: 8093, protocol: "tcp", bind, fixed: false, web: true }] }] })) });
    await expect(operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: published("0.0.0.0") })).rejects.toThrow("ntfy is on your home network at port 8093, published on every address, and Tailscale Serve would hold the same port on the tailnet address.");
    await expect(operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: published("*") })).rejects.toThrow("change who can reach it to Tailnet only");
    expect(run).not.toHaveBeenCalled();
    await expect(operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: published("127.0.0.1") })).resolves.toMatchObject({ enabled: true, url: "https://homebox.tail1234.ts.net:8093" });
  });

  it("stops serving and starts the app, for Repair's fix of a port Serve held", async () => {
    let served = true;
    const run = vi.fn(async (_binary, args) => {
      if (args[1] === "status") return { ok: true, stdout: served ? serveJson : "{}", stderr: "" };
      if (args.includes("off")) served = false;
      return { ok: true, stdout: "", stderr: "" };
    });
    const apps = { ...fakeApps(), action: vi.fn(async () => ({ id: "ntfy", action: "start", running: true, status: "running", recreated: true })) };
    const result = await operations["app.serve.set"].run({ id: "ntfy", enabled: false, start: true }, { run, apps });
    expect(result).toEqual({ id: "ntfy", enabled: false, port: 8093, url: null, withdrawn: "https://homebox.tail1234.ts.net:8093", started: true, status: "running", recreated: true });
    expect(apps.action).toHaveBeenCalledWith({ id: "ntfy", action: "start" }, expect.anything());
    // Without start it only withdraws, as before.
    served = true;
    apps.action.mockClear();
    await operations["app.serve.set"].run({ id: "ntfy", enabled: false }, { run, apps });
    expect(apps.action).not.toHaveBeenCalled();
  });

  it("withdraws a served app from the tailnet before putting it on the home network, and back if that fails", async () => {
    const order = [];
    let served = true;
    const run = vi.fn(async (_binary, args) => {
      if (args[1] === "status") return { ok: true, stdout: served ? serveJson : "{}", stderr: "" };
      order.push(`tailscale ${args.slice(1).join(" ")}`);
      served = !args.includes("off");
      return { ok: true, stdout: "", stderr: "" };
    });
    const apps = { ...fakeApps(), reconfigure: vi.fn(async () => { order.push("reconfigure"); return { hostPorts: [{ id: "web", host: 8093, protocol: "tcp", exposure: "lan", tailnet: "serve" }] }; }) };
    const result = await operations["app.exposure.set"].run({ id: "ntfy", mode: "lan" }, { run, apps });
    expect(order).toEqual(["tailscale --yes --https=8093 off", "reconfigure"]);
    expect(result).toMatchObject({ mode: "lan", served: false, urls: [], withdrawn: ["https://homebox.tail1234.ts.net:8093"] });

    order.length = 0; served = true;
    apps.reconfigure.mockImplementationOnce(async () => { order.push("reconfigure"); throw new Error("ntfy reconfiguration failed; the previous configuration was restored. Container exited"); });
    await expect(operations["app.exposure.set"].run({ id: "ntfy", mode: "lan" }, { run, apps })).rejects.toThrow("Tailscale Serve publishes it again at https://homebox.tail1234.ts.net:8093.");
    expect(order).toEqual(["tailscale --yes --https=8093 off", "reconfigure", "tailscale --bg --yes --https=8093 http://127.0.0.1:8093"]);
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

describe("who may measure the data folders", () => {
  const find = (id) => appOperations().find((operation) => operation.id === id);

  it("is not open to viewers", () => {
    // It reads through root's permissions, so it would hand a viewer the path and size of every
    // app's data - and each call is a folder walk holding a helper read slot for minutes.
    expect(find("app.data.usage").minimumRole).toBe("operator");
  });

  it("changes nothing, so it can never queue behind a deploy", () => {
    expect(find("app.data.usage").readOnly).toBe(true);
  });
});

describe("operations that re-render an app's compose file carry the devices the web process resolved", () => {
  // The helper runs with PrivateDevices, so a device glob resolved there matches nothing: Jellyfin
  // lost its GPU render node when its password or exposure changed, and Zigbee2MQTT refused to start.
  it("covers every app operation that ends in writing the project", async () => {
    const { deviceResolvingOperations } = await import("../catalog/devices.mjs");
    // app.reinstall writes the project again when its compose file is gone too (M35).
    const rerendering = appOperations().filter((operation) => /apps\.(install|reinstall|update|reconfigure|rollbackApp|setPassword)\(/.test(String(operation.run))).map((operation) => operation.id);
    expect(rerendering.length).toBeGreaterThan(4);
    expect([...deviceResolvingOperations].sort()).toEqual([...rerendering].sort());
    for (const id of deviceResolvingOperations) expect(operations[id].parameters.fields.devices, id).toBeTruthy();
  });

  it("hands them on when the password or the exposure changes", async () => {
    const apps = {
      setPassword: vi.fn(async () => ({ changed: true })),
      reconfigure: vi.fn(async () => ({ hostPorts: [] })),
      inspect: vi.fn(async () => ({ applications: [{ id: "jellyfin", installed: true, urls: [{ id: "web", host: 8096, exposure: "lan" }] }] })),
    };
    await operations["app.password.set"].run({ id: "jellyfin", password: "correct horse", devices: ["/dev/dri/renderD128"] }, { apps });
    expect(apps.setPassword).toHaveBeenCalledWith(expect.objectContaining({ id: "jellyfin", devices: ["/dev/dri/renderD128"] }), expect.anything());
    await operations["app.exposure.set"].run({ id: "jellyfin", mode: "lan", devices: ["/dev/dri/renderD128"] }, { apps, run: vi.fn() });
    expect(apps.reconfigure).toHaveBeenCalledWith(expect.objectContaining({ id: "jellyfin", devices: ["/dev/dri/renderD128"] }), expect.anything());
  });
});

describe("installing an app for the tailnet only (M38)", () => {
  const zulipServe = JSON.stringify({ TCP: { 8543: { HTTPS: true } }, Web: { "homebox.tail1234.ts.net:8543": { Handlers: { "/": { Proxy: "http://127.0.0.1:8543" } } } } });
  const installed = (exposure) => ({ install: vi.fn(async () => ({ installed: true, id: "zulip", name: "Zulip", exposure, hostPorts: [{ id: "web", host: 8543, protocol: "tcp", exposure: exposure === "tailnet" ? "loopback" : "lan", tailnet: "serve" }] })) });

  it("publishes its web port with Tailscale Serve once it is up, and says where", async () => {
    const run = vi.fn(async (_binary, args) => (args[1] === "status" ? { ok: true, stdout: zulipServe, stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    const result = await operations["app.install"].run({ id: "zulip", values: {} }, { apps: installed("tailnet"), run });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["serve", "--bg", "--yes", "--https=8543", "http://127.0.0.1:8543"], expect.anything());
    expect(result).toMatchObject({ installed: true, served: true, urls: ["https://homebox.tail1234.ts.net:8543"] });
    expect(result.warnings).toBeUndefined();
  });

  it("keeps the install and says how to publish it when Serve fails", async () => {
    const run = vi.fn(async (_binary, args) => (args[0] === "serve" && args[1] === "--bg" ? { ok: false, stdout: "", stderr: "serve: Tailscale is stopped" } : { ok: true, stdout: "{}", stderr: "" }));
    const result = await operations["app.install"].run({ id: "zulip", values: {} }, { apps: installed("tailnet"), run });
    expect(result).toMatchObject({ installed: true, served: false });
    expect(result.warnings[0]).toMatch(/publishing it with Tailscale Serve failed \(8543: serve: Tailscale is stopped\).*choose Publish on the tailnet/);
  });

  it("leaves an app on the home network alone", async () => {
    const run = vi.fn();
    const result = await operations["app.install"].run({ id: "zulip", values: { exposure: "lan" } }, { apps: installed("lan"), run });
    expect(run).not.toHaveBeenCalled();
    expect(result.served).toBeUndefined();
  });
});

// R4B3-6: a restore writes the backup's compose file again for this server and says who can reach the
// app and on which ports (exposure, hostPorts), as an install does; app.backup.restore ignored that,
// so restoring a tailnet-only backup left its web port on 127.0.0.1 with nothing publishing it.
describe("restoring a tailnet-only app's backup", () => {
  const serving = JSON.stringify({ Web: { "homebox.tail1234.ts.net:8384": { Handlers: { "/": { Proxy: "http://127.0.0.1:8384" } } } } });
  const restoring = (exposure, extra = {}) => ({ restoreAppBackup: vi.fn(async () => ({ restored: true, id: "relay", name: "Relay", backup: "20260819T120000Z.tar.gz", exposure, hostPorts: [{ id: "web", host: 8384, protocol: "tcp", exposure: exposure === "tailnet" ? "loopback" : "lan", tailnet: "serve" }], ...extra })) });
  const parameters = { id: "relay", backup: "20260819T120000Z.tar.gz" };

  it("publishes its web port with Tailscale Serve once it is back, and says where", async () => {
    const run = vi.fn(async (_binary, args) => (args[1] === "status" ? { ok: true, stdout: serving, stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    const result = await operations["app.backup.restore"].run(parameters, { apps: restoring("tailnet"), run });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["serve", "--bg", "--yes", "--https=8384", "http://127.0.0.1:8384"], expect.anything());
    expect(result).toMatchObject({ restored: true, served: true, urls: ["https://homebox.tail1234.ts.net:8384"] });
    expect(result.warnings).toBeUndefined();
  });

  it("keeps the restore, with its own warnings, and says how to publish it when Serve fails", async () => {
    const run = vi.fn(async (_binary, args) => (args[1] === "--bg" ? { ok: false, stdout: "", stderr: "serve: Tailscale is stopped" } : { ok: true, stdout: "{}", stderr: "" }));
    const result = await operations["app.backup.restore"].run(parameters, { apps: restoring("tailnet", { warnings: ["an earlier warning"] }), run });
    expect(result).toMatchObject({ restored: true, served: false });
    expect(result.warnings[0]).toBe("an earlier warning");
    expect(result.warnings[1]).toMatch(/^Relay is installed for your tailnet only, but publishing it with Tailscale Serve failed \(8384: serve: Tailscale is stopped\).*choose Publish on the tailnet\.$/);
  });

  it("leaves an app on the home network alone", async () => {
    const run = vi.fn();
    const result = await operations["app.backup.restore"].run(parameters, { apps: restoring("lan"), run });
    expect(run).not.toHaveBeenCalled();
    expect(result.served).toBeUndefined();
  });
});

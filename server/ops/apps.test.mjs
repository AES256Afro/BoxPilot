import { describe, expect, it, vi } from "vitest";
import { appOperations, parseServeStatus } from "./apps.mjs";

const operations = Object.fromEntries(appOperations().map((operation) => [operation.id, operation]));

const serveJson = JSON.stringify({
  TCP: { 8093: { HTTPS: true } },
  Web: { "bigbox.tail1234.ts.net:8093": { Handlers: { "/": { Proxy: "http://127.0.0.1:8093" } } } },
  AllowFunnel: {},
});

function fakeApps(installed = true, port = 8093) {
  return { inspect: vi.fn(async () => ({ applications: [{ id: "ntfy", installed, urls: installed && port ? [{ id: "web", host: port, exposure: "lan" }] : [] }] })) };
}

describe("app serve operations", () => {
  it("parses tailscale serve status", () => {
    expect(parseServeStatus(serveJson)).toEqual([{ dnsName: "bigbox.tail1234.ts.net", port: 8093, target: "http://127.0.0.1:8093" }]);
    expect(parseServeStatus("garbage")).toEqual([]);
    expect(parseServeStatus("{}")).toEqual([]);
  });

  it("publishes an installed app's web port over tailnet HTTPS and reports the URL", async () => {
    const run = vi.fn(async (_binary, args) => {
      if (args[1] === "status") return { ok: true, stdout: serveJson, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const result = await operations["app.serve.set"].run({ id: "ntfy", enabled: true }, { run, apps: fakeApps() });
    expect(result).toEqual({ id: "ntfy", enabled: true, port: 8093, url: "https://bigbox.tail1234.ts.net:8093" });
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
    await expect(operations["app.serve.inspect"].run({}, { run: up })).resolves.toEqual({ available: true, serves: [{ dnsName: "bigbox.tail1234.ts.net", port: 8093, target: "http://127.0.0.1:8093" }] });
    const down = vi.fn(async () => ({ ok: false, stdout: "", stderr: "no tailscaled" }));
    await expect(operations["app.serve.inspect"].run({}, { run: down })).resolves.toEqual({ available: false, serves: [] });
  });
});

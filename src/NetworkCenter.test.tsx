import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkCenter from "./NetworkCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const topology = {
  generatedAt: "2026-08-16T00:00:00Z",
  collectors: { addresses: true, routes: true, resolvers: true, listeners: true, tailscale: true },
  eligibleLanAddresses: [{ interface: "eno1", address: "192.168.8.10", cidr: "192.168.8.10/24" }],
  defaultRoutes: [{ gateway: "192.168.8.1", interface: "eno1", protocol: "static" }],
  defaultResolvers: ["94.140.14.49", "94.140.14.59"],
  tailscale: { connected: true, dnsName: "homebox.example.ts.net", resolverPresent: true, defaultDnsObserved: false, overrideState: "non-tailscale-default-observed" },
  dnsListeners: [{ protocol: "tcp", address: "127.0.0.53", port: 53, scope: "loopback", interface: null }],
  devices: [{ address: "192.168.1.50", mac: "aa:bb:cc:dd:ee:ff", interface: "eno1", state: "REACHABLE" }],
  routerCatalog: [{ id: "glinet-flint-2", name: "GL.iNet Flint 2", roles: ["edge-router", "adguard-home-host"], integration: "read-only-declaration", note: "No router credentials are accepted.", officialSource: "https://docs.gl-inet.com/" }],
  mutationSupported: false,
};

const acceptanceStatus = {
  source: { installed: false, healthy: false, state: "not-installed", lanAddress: null, detail: "Managed Pi-hole was not found" },
  linkedDeploymentJobId: null,
  linkedBackupId: null,
  acceptances: [],
  limitations: ["A passing server-side test proves only the controller path.", "A second device is required."],
};

describe("Network Center", () => {
  it("renders live topology and creates a no-change recovery assessment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/network/topology")) return new Response(JSON.stringify(topology), { status: 200, headers: { "Content-Type": "application/json" } });
      if (input.toString().endsWith("/api/v1/network/dns-acceptance")) return new Response(JSON.stringify(acceptanceStatus), { status: 200, headers: { "Content-Type": "application/json" } });
      if (input.toString().endsWith("/api/v1/operations/network.wake/jobs")) return new Response(JSON.stringify({ job: { id: "job-wake", type: "op:network.wake", title: "Wake a device on the LAN", state: "awaiting_approval", risk: "low", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "low risk" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf" });
      const submitted = JSON.parse(String(init?.body));
      expect(submitted).toMatchObject({ gatewayAddress: "192.168.8.1", serverAddress: "192.168.8.10", dnsServiceAddress: "94.140.14.49", fallbackDnsAddress: "94.140.14.59", tailscaleDnsOverride: false });
      return new Response(JSON.stringify({ plan: {
        id: "plan-one", revision: "a".repeat(64), expiresAt: "2026-08-16T01:00:00Z",
        output: {
          executable: false, readyForChangeWindow: false, topology: { summary: "Keep Flint 2 as the only edge router.", devices: ["Flint 2: edge router", "TP-Link: access point"] },
          dns: { role: "current-external", primary: "94.140.14.49", emergency: "94.140.14.59" },
          blockers: [{ id: "router-checkpoint", summary: "Record the router configuration" }], warnings: ["Tailscale DNS override is declared off."],
          changes: ["No setting will be changed"], recovery: ["Restore router DNS"], routerMutationSupported: false, dnsCutoverSupported: false,
        },
      } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkCenter csrfToken="csrf" />);
    expect(await screen.findByText("192.168.8.1")).toBeTruthy();
    expect(screen.getByText("94.140.14.49 + 94.140.14.59")).toBeTruthy();
    expect(screen.getByText("GL.iNet Flint 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate no-change assessment" }));
    expect(await screen.findByText("Change window blocked")).toBeTruthy();
    expect(screen.getAllByText("Router writes locked").length).toBeGreaterThan(0);
    expect(screen.getByText("DNS cutover locked")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // LAN devices from the neighbour table, each with a one-click Wake-on-LAN.
    expect(screen.getByText("aa:bb:cc:dd:ee:ff")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    expect(await screen.findByText("Low risk")).toBeTruthy();
    const wakeCall = fetchMock.mock.calls.find(([url]) => url.toString().endsWith("/operations/network.wake/jobs"));
    expect(JSON.parse(String(wakeCall?.[1]?.body))).toEqual({ parameters: { mac: "aa:bb:cc:dd:ee:ff" } });
  });

});

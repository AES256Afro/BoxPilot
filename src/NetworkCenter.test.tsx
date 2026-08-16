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
  tailscale: { connected: true, dnsName: "bigbox.example.ts.net", resolverPresent: true, defaultDnsObserved: false, overrideState: "non-tailscale-default-observed" },
  dnsListeners: [{ protocol: "tcp", address: "127.0.0.53", port: 53, scope: "loopback", interface: null }],
  routerCatalog: [{ id: "glinet-flint-2", name: "GL.iNet Flint 2", roles: ["edge-router", "adguard-home-host"], integration: "read-only-declaration", note: "No router credentials are accepted.", officialSource: "https://docs.gl-inet.com/" }],
  mutationSupported: false,
};

describe("Network Center", () => {
  it("renders live topology and creates a no-change recovery assessment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/network/topology")) return new Response(JSON.stringify(topology), { status: 200, headers: { "Content-Type": "application/json" } });
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
    expect(screen.getByText("Router writes locked")).toBeTruthy();
    expect(screen.getByText("DNS cutover locked")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

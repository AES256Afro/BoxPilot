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
    expect(screen.getAllByText("Router writes locked")).toHaveLength(2);
    expect(screen.getByText("DNS cutover locked")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("hands a ready Pi-hole assessment id to the application workflow", async () => {
    const onAssessmentReady = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/network/topology")) return new Response(JSON.stringify(topology), { status: 200, headers: { "Content-Type": "application/json" } });
      if (input.toString().endsWith("/api/v1/network/dns-acceptance")) return new Response(JSON.stringify(acceptanceStatus), { status: 200, headers: { "Content-Type": "application/json" } });
      const submitted = JSON.parse(String(init?.body));
      expect(submitted).toMatchObject({ dnsRole: "pihole-on-host", dnsServiceAddress: "192.168.8.10", routerBackupRecorded: true, emergencyResolverTested: true, secondDeviceReady: true });
      return new Response(JSON.stringify({ plan: {
        id: "pihole-assessment", revision: "b".repeat(64), expiresAt: "2026-08-16T01:00:00Z",
        output: {
          executable: false, readyForChangeWindow: true, topology: { summary: "Keep Flint 2 as the only edge router.", devices: ["Flint 2: edge router"] },
          dns: { role: "pihole-on-host", primary: "192.168.8.10", emergency: "94.140.14.59" }, blockers: [], warnings: [],
          changes: ["No network setting will be changed"], recovery: ["Restore external DNS"], routerMutationSupported: false, dnsCutoverSupported: false,
        },
      } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkCenter csrfToken="csrf" onAssessmentReady={onAssessmentReady} />);

    await screen.findByText("192.168.8.1");
    fireEvent.change(screen.getByLabelText("DNS role"), { target: { value: "pihole-on-host" } });
    fireEvent.change(screen.getByLabelText("Proposed primary DNS IPv4"), { target: { value: "192.168.8.10" } });
    fireEvent.click(screen.getByLabelText(/Router configuration backup/));
    fireEvent.click(screen.getByLabelText(/Emergency resolver tested/));
    fireEvent.click(screen.getByLabelText(/Second LAN device ready/));
    fireEvent.click(screen.getByRole("button", { name: "Generate no-change assessment" }));

    expect(await screen.findByText("Prerequisites recorded")).toBeTruthy();
    expect(onAssessmentReady).toHaveBeenCalledWith("pihole-assessment");
    expect(screen.getByText(/ready for the Applications staging gate/)).toBeTruthy();
  });

  it("plans and stages fixed controller-only DNS checks while showing the second-device lock", async () => {
    const onOpenRepair = vi.fn();
    const liveAcceptance = {
      ...acceptanceStatus,
      source: { installed: true, healthy: true, state: "running", lanAddress: "192.168.8.10", detail: "Managed Pi-hole is healthy" },
      linkedDeploymentJobId: "deploy-one",
      linkedBackupId: "backup-one",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/network/topology")) return new Response(JSON.stringify(topology), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/network/dns-acceptance") && !init?.method) return new Response(JSON.stringify(liveAcceptance), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/network/dns-acceptance/plans")) return new Response(JSON.stringify({ plan: {
        id: "acceptance-plan", revision: "c".repeat(16), expiresAt: "2026-08-16T01:00:00Z",
        output: {
          executable: true, resolverAddress: "192.168.8.10", linkedDeploymentJobId: "deploy-one", linkedAssessmentId: "assessment-one", linkedBackupId: "backup-one", blockers: [],
          tests: [
            { id: "local-udp", protocol: "udp", name: "pi.hole", type: "A", expectedRcode: 0 },
            { id: "local-tcp", protocol: "tcp", name: "pi.hole", type: "A", expectedRcode: 0 },
          ],
          evidenceBoundary: { provesHostPath: true, provesSecondDevicePath: false, routerMutationSupported: false, dnsCutoverSupported: false },
          changes: ["Send fixed queries"], recovery: "No settings are changed.",
        },
      } }), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/v1/network/dns-acceptance-plans/")) return new Response(JSON.stringify({ job: { id: "acceptance-job" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);

    expect(await screen.findByText("Prove DNS directly from this server")).toBeTruthy();
    expect(screen.getByText("Second device not proven")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan fixed direct DNS checks" }));
    expect(await screen.findByText("Exact checks are ready to stage")).toBeTruthy();
    expect(screen.getByText(/UDP pi\.hole A on port 53/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage fixed checks for approval" }));
    expect(await screen.findByText(/Direct DNS acceptance is staged/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Repair Center" }));
    expect(onOpenRepair).toHaveBeenCalled();
  });
});

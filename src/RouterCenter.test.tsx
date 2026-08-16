import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RouterCenter, { hashRouterBackup } from "./RouterCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const status = {
  catalog: [{ id: "glinet-flint-2", name: "GL.iNet Flint 2", roles: ["edge-router"], officialSource: "https://docs.gl-inet.com/" }],
  checkpoints: [], latestByModel: { "glinet-flint-2": null },
  boundary: { hashing: "operator-browser-reported-sha256", configurationUploaded: false, credentialsAccepted: false, routerSessionOpened: false, routerMutationSupported: false, dnsCutoverSupported: false, maximumFileBytes: 67108864 },
  limitations: ["The configuration stays local."],
};
const readiness = {
  generatedAt: "2026-08-16T00:00:00.000Z",
  recommendedTopology: { id: "flint2-edge-tplink-ap", summary: "Keep Flint 2 as the only edge router, NAT, and DHCP server.", rationale: "One routing boundary." },
  alternateTopology: { id: "omada-edge-access-points", summary: "Keep ER707-M2 as the only edge router.", gate: "Use a separate migration plan." },
  observedGateway: { address: "192.168.8.1", interface: "eno1", protocol: "static", modelVerified: false, identityClaim: "address-observed-model-unverified" },
  checks: [
    { id: "gateway.observed", state: "verified", title: "One live default gateway", evidence: "192.168.8.1 is observed.", action: "Confirm the Flint LAN address." },
    { id: "gateway.identity", state: "operator-check", title: "Gateway model identity", evidence: "Model not verified.", action: "Compare addresses." },
    { id: "flint.checkpoint", state: "action-required", title: "Flint 2 recovery checkpoint", evidence: "No checkpoint.", action: "Record one." },
  ],
  counts: { verified: 1, "action-required": 1, "operator-check": 1, unavailable: 0 },
  guides: [{ modelId: "glinet-flint-2", intendedRole: "Only edge router", mode: "Router mode", officialSources: [{ label: "Flint guide", url: "https://docs.gl-inet.com/" }], steps: ["Export the configuration."], verify: ["Confirm one DHCP server."], rollback: "Restore the prior edge.", checkpoint: null }],
  sourceReviewedAt: "2026-08-16",
  boundary: { credentialsAccepted: false, routerSessionsOpened: false, neighborDiscoveryPerformed: false, arbitraryTargetsProbed: false, configurationUploaded: false, routerMutationSupported: false, dhcpMutationSupported: false, dnsCutoverSupported: false, tailscaleMutationSupported: false },
};
const flint2Status = {
  observedGateway: { gateway: "192.168.8.1", interface: "eno1", protocol: "static" }, checkpoint: null, acceptances: [], sourceReviewedAt: "2026-08-16",
  officialSources: ["https://docs.gl-inet.com/router/en/4/interface_guide/adguardhome/", "https://docs.gl-inet.com/router/en/4/interface_guide/network_mode/"],
  boundary: { credentialsAccepted: false, routerSessionOpened: false, arbitraryTargetAccepted: false, routerMutationSupported: false, dnsCutoverSupported: false },
};

function responseFor(input: RequestInfo | URL) {
  const url = String(input);
  return new Response(JSON.stringify(url.endsWith("router-readiness") ? readiness : url.endsWith("flint2-adguard-acceptance") ? flint2Status : status), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Router Center", () => {
  it("hashes bytes with SHA-256 and rejects unsafe file sizes", async () => {
    const digest = vi.fn(async () => Uint8Array.from({ length: 32 }, (_, index) => index).buffer);
    const file = { size: 64, arrayBuffer: vi.fn(async () => new ArrayBuffer(64)) };
    await expect(hashRouterBackup(file, digest)).resolves.toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    expect(digest).toHaveBeenCalled();
    await expect(hashRouterBackup({ size: 1, arrayBuffer: file.arrayBuffer }, digest)).rejects.toThrow("between 64 bytes");
  });

  it("renders the no-upload boundary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => responseFor(input));
    vi.stubGlobal("fetch", fetchMock);
    render(<RouterCenter csrfToken="csrf" />);
    expect(await screen.findByText("No file upload")).toBeTruthy();
    expect(screen.getByText("Credentials rejected")).toBeTruthy();
    expect(screen.getAllByText("GL.iNet Flint 2")).toHaveLength(3);
    expect(screen.getByText("192.168.8.1 via eno1")).toBeTruthy();
    expect(screen.getByText("Address observed. Router model not verified.")).toBeTruthy();
    expect(screen.getByText("Gateway model identity")).toBeTruthy();
    expect(screen.getByText("Operator steps")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hash locally and record metadata" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Flint 2 AdGuard Home direct acceptance")).toBeTruthy();
    expect(screen.getByText(/BoxPilot does not accept an address or claim the physical model/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "AdGuard Home guide" }).getAttribute("href")).toContain("adguardhome");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("sends only locally derived metadata and never the selected file", async () => {
    const digest = "c".repeat(64);
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => Uint8Array.from({ length: 32 }, () => 0xcc).buffer) } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return responseFor(input);
      const submitted = JSON.parse(String(init.body));
      expect(submitted).toEqual({ modelId: "glinet-flint-2", firmwareVersion: "4.8.2", checksumSha256: digest, sizeBytes: 64, fileRetainedByOperator: true });
      expect(String(init.body)).not.toContain("router-backup.tar");
      return new Response(JSON.stringify({ checkpoint: { id: "checkpoint-one", ...submitted, hashOrigin: "operator-browser-reported-sha256", configurationUploaded: false, createdAt: "2026-08-16T02:00:00.000Z" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RouterCenter csrfToken="csrf" />);
    await screen.findByText("No file upload");
    fireEvent.change(screen.getByLabelText("Firmware version"), { target: { value: "4.8.2" } });
    const file = { name: "router-backup.tar", size: 64, arrayBuffer: vi.fn(async () => new ArrayBuffer(64)) } as unknown as File;
    fireEvent.change(screen.getByLabelText(/^Router backup file/), { target: { files: [file] } });
    fireEvent.click(screen.getByLabelText(/I retained the original configuration/));
    fireEvent.click(screen.getByRole("button", { name: "Hash locally and record metadata" }));
    expect(await screen.findByText(/configuration file never left this browser/)).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
  });

  it("submits only six fixed declarations and stages the immutable gateway-derived plan", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return responseFor(input);
      if (url.endsWith("/flint2-adguard-acceptance/plans")) {
        const submitted = JSON.parse(String(init.body));
        expect(Object.keys(submitted).sort()).toEqual(["adguardHomeEnabled", "emergencyResolverTested", "handleClientRequestsReviewed", "routerModeConfirmed", "singleDhcpAuthorityConfirmed", "vpnPolicyImpactReviewed"]);
        expect(Object.values(submitted).every((value) => value === true)).toBe(true);
        expect(String(init.body)).not.toContain("192.168.8.1");
        return new Response(JSON.stringify({ plan: { id: "flint-plan", revision: "rev-one", expiresAt: "2026-08-16T08:00:00.000Z", output: { executable: true, routerModel: "GL.iNet Flint 2 (GL-MT6000)", resolverAddress: "192.168.8.1", checkpointId: "checkpoint-one", checkpointFirmware: "4.8.2", blockers: [], tests: [{ id: "gateway-public-udp", protocol: "udp", name: "example.com", port: 53 }], vendorWarnings: ["Model identity remains unverified."], changes: ["Four fixed queries"], recovery: "No router setting changes." } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      expect(url).toBe("/api/v1/network/flint2-adguard-acceptance/plans/flint-plan/stage");
      expect(JSON.parse(String(init.body))).toEqual({ revision: "rev-one" });
      return new Response(JSON.stringify({ job: { id: "job-one" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RouterCenter csrfToken="csrf" />);
    await screen.findByText("Flint 2 AdGuard Home direct acceptance");
    for (const label of ["Flint 2 shows Router mode", "only production NAT", "APPLICATIONS > AdGuard Home", "Handle Client Requests", "VPN and upstream-DNS", "independent emergency resolver"]) fireEvent.click(screen.getByLabelText(new RegExp(label)));
    fireEvent.click(screen.getByRole("button", { name: "Review fixed DNS acceptance" }));
    expect(await screen.findByText(/GL.iNet Flint 2 \(GL-MT6000\) at 192.168.8.1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    expect(await screen.findByText(/Open Repair Center to review the job/)).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApplicationCatalog from "./ApplicationCatalog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("curated application catalog", () => {
  it("loads manifests and renders a live reviewed deployment plan", async () => {
    const application = {
      id: "uptime-kuma", name: "Uptime Kuma", category: "Monitoring", description: "Monitor services", execution: "enabled", risk: "low", targets: ["docker"],
      image: { version: "2.5.0", digestPinned: true }, integrity: `sha256:${"a".repeat(64)}`, live: { installed: false, state: "not-installed", detail: "Ready to plan" },
    };
    const plan = {
      id: "plan-one", subjectId: "uptime-kuma", revision: "revision123", input: { target: "docker", hostPort: 3001 }, expiresAt: "2026-08-15T20:00:00Z",
      output: { executable: true, changes: ["Create managed data directory"], blockers: [], warnings: [], recovery: { summary: "Preserve data", preservesData: true }, image: application.image },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf" });
      return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} />);

    expect(await screen.findByText("Uptime Kuma")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan deployment" }));
    expect(screen.getByText(/Image digest pinned/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate live plan" }));
    expect(await screen.findByText("Ready to stage")).toBeTruthy();
    expect(screen.getByText("Create managed data directory")).toBeTruthy();
  });

  it("creates and stages an immutable Uptime Kuma lifecycle action", async () => {
    const application = {
      id: "uptime-kuma", name: "Uptime Kuma", category: "Monitoring", description: "Monitor services", execution: "enabled", risk: "low", targets: ["docker"],
      image: { version: "2.5.0", digestPinned: true }, integrity: `sha256:${"a".repeat(64)}`,
      live: { installed: true, state: "running", healthy: true, port: 3101, detail: "Managed container is running", backup: { state: "required", verifiedAt: null }, lifecycle: { installed: true, managed: true, state: "running", running: true, healthy: true, port: 3101, revision: "b".repeat(64), allowedActions: ["stop", "restart"], detail: "Managed Uptime Kuma is healthy" } },
    };
    const plan = {
      id: "action-plan", revision: "action-revision", input: { applicationId: "uptime-kuma", action: "restart", expectedRevision: "b".repeat(64) },
      output: { executable: true, applicationId: "uptime-kuma", applicationName: "Uptime Kuma", label: "Restart", current: { state: "running", healthy: true, port: 3101, lanAddress: null, dnsTcpBound: false, dnsUdpBound: false }, desired: { state: "running", healthy: true, port: 3101, lanAddress: null, dnsTcpBound: false, dnsUdpBound: false }, changes: ["Restart only the exact managed container"], recovery: "Persistent data stays in place", boundaries: ["No image, port, volume, network, data, or other container can change"] },
    };
    const onOpenRepair = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/applications/uptime-kuma/action-plans")) {
        expect(JSON.parse(String(init?.body))).toEqual({ action: "restart" });
        return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      expect(url).toContain("/api/v1/application-action-plans/action-plan/stage");
      expect(JSON.parse(String(init?.body))).toEqual({ revision: "action-revision" });
      return new Response(JSON.stringify({ job: { id: "job-one", state: "awaiting_approval" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" onInspectCompose={vi.fn()} onOpenRepair={onOpenRepair} />);

    expect(await screen.findByRole("button", { name: "Plan restart" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan restart" }));
    expect(await screen.findByRole("heading", { name: "Restart Uptime Kuma" })).toBeTruthy();
    expect(screen.getByText("Restart only the exact managed container")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    expect(await screen.findByText(/Restart job staged/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Repair Center" }));
    expect(onOpenRepair).toHaveBeenCalledOnce();
  });

  it("carries the linked network assessment into an exact-address Pi-hole plan", async () => {
    const application = {
      id: "pi-hole", name: "Pi-hole", category: "DNS", description: "Filter DNS", execution: "enabled", risk: "network-critical", targets: ["docker", "virtual-machine"],
      image: { version: "2026.07.2", digestPinned: true }, integrity: `sha256:${"b".repeat(64)}`, live: { installed: false, state: "not-installed", detail: "Ready to plan", backup: { state: "not-applicable", verifiedAt: null } },
    };
    const plan = {
      id: "pihole-plan", subjectId: "pi-hole", revision: "revision456", input: { target: "docker", hostPort: 8080, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one" }, expiresAt: "2026-08-15T20:00:00Z",
      output: { executable: true, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one", changes: ["Start exact-address Pi-hole"], blockers: [], warnings: ["No DNS cutover"], recovery: { summary: "Preserve data", preservesData: true }, image: application.image },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(String(init?.body))).toMatchObject({ target: "docker", hostPort: 8080, networkAssessmentId: "network-plan-one" });
      return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" networkAssessmentId="network-plan-one" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} onOpenNetwork={vi.fn()} />);

    expect(await screen.findByText("Pi-hole")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan deployment" }));
    expect(screen.getByText("Network assessment linked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate live plan" }));
    expect(await screen.findByText("Ready to stage")).toBeTruthy();
    expect(screen.getByText(/DNS 192\.168\.8\.10:53 TCP\/UDP/)).toBeTruthy();
  });

  it("creates a network-critical Pi-hole lifecycle action from strict managed evidence", async () => {
    const application = {
      id: "pi-hole", name: "Pi-hole", category: "DNS", description: "Filter DNS", execution: "enabled", risk: "network-critical", targets: ["docker", "virtual-machine"],
      image: { version: "2026.07.2", digestPinned: true }, integrity: `sha256:${"b".repeat(64)}`,
      live: {
        installed: true, state: "running", healthy: true, lanAddress: "192.168.8.10", port: 8080, detail: "Managed Pi-hole is healthy", backup: { state: "required", verifiedAt: null },
        lifecycle: { installed: true, managed: true, state: "running", running: true, healthy: true, lanAddress: "192.168.8.10", port: 8080, dnsTcpBound: true, dnsUdpBound: true, revision: "c".repeat(64), allowedActions: ["stop", "restart"], detail: "Managed Pi-hole is healthy" },
      },
    };
    const plan = {
      id: "pihole-action-plan", revision: "pihole-action-revision", input: { applicationId: "pi-hole", action: "restart", expectedRevision: "c".repeat(64) },
      output: {
        executable: true, applicationId: "pi-hole", applicationName: "Pi-hole", label: "Restart",
        current: { state: "running", healthy: true, port: 8080, lanAddress: "192.168.8.10", dnsTcpBound: true, dnsUdpBound: true },
        desired: { state: "running", healthy: true, port: 8080, lanAddress: "192.168.8.10", dnsTcpBound: true, dnsUdpBound: true },
        changes: ["Restart only the exact managed Pi-hole container"], recovery: "Keep clients on the independently tested resolver", boundaries: ["No router, DHCP, client DNS, data, secret, or Tailscale setting can change"],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/applications/pi-hole/action-plans")) return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ job: { id: "job-pihole", state: "awaiting_approval" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Plan restart" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan restart" }));
    expect(await screen.findByRole("heading", { name: "Restart Pi-hole" })).toBeTruthy();
    expect(screen.getByText("192.168.8.10")).toBeTruthy();
    expect(screen.getByText("Keep clients on the independently tested resolver")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    expect(await screen.findByText(/Restart job staged/)).toBeTruthy();
  });

  it("shows and stages the exact inert Keel 1.2.6 release without claiming installation", async () => {
    const artifact = {
      repository: "AES256Afro/Keel", releaseTag: "v1.2.6", releaseCommitSha: "884e7ab1cc48139ed51de350ea5812a2e3a9cc7d",
      name: "keel-1.2.6-linux-x64.tar.gz", sizeBytes: 71052143,
      digest: "sha256:696f5e444696d3da876f870fe72b6743e7e15c4fbf25809d02469a14da1f2e00",
      locallyVerifiedByBoxPilot: false,
    };
    const application = {
      id: "keel", name: "Keel Notes", category: "Knowledge", description: "Self-hosted notebook", execution: "staging-enabled", risk: "stateful", targets: ["native-service"],
      image: { version: "1.2.6", digestPinned: true }, artifact, integrity: `sha256:${"c".repeat(64)}`,
      live: { installed: false, state: "not-installed", healthy: false, kind: null, version: null, listener: "none", healthIdentityVerified: false, risks: [], native: { candidateCount: 0 }, docker: { available: true, candidateCount: 0 }, provenance: { status: "matched", checkedAt: "2026-08-16T04:00:00Z" }, artifact: { state: "verified", readyToAcquire: false, artifactPresent: true, locallyVerified: true, partialPresent: false, detail: "The exact Keel release archive is locally verified" }, archive: { state: "safe", safeToExtract: true, artifactLocallyVerified: true, memberCount: 2974, expectedMemberCount: 2974, risks: [], detail: "The exact archive passed the runtime membership gate" }, staging: { state: "absent", staged: false, readyToStage: true, partialCount: 0, detail: "The fixed Keel release has not been staged" }, loginProof: { state: "not-run", verified: false, credentialsStored: false, sessionStored: false, detail: "No terminal-only Keel instance-owner login proof has been recorded" }, detail: "No supported Keel installation was found", boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false } },
    };
    const plan = {
      id: "keel-plan", subjectId: "keel", revision: "revision789", input: { target: "native-service", hostPort: 3000 }, expiresAt: "2026-08-16T04:00:00Z",
      output: {
        executable: true, artifact: { ...artifact, locallyVerifiedByBoxPilot: true, githubReportedDigestMatched: true }, image: application.image, archiveInspection: application.live.archive, stagingInspection: application.live.staging,
        discovery: { installed: false, state: "not-installed", healthy: false, kind: null, version: null, port: 3000, listener: "none", healthIdentityVerified: false, risks: [], native: { candidateCount: 0 }, docker: { available: true, candidateCount: 0 }, detail: "No supported Keel installation was found", boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false } },
        changes: ["Publish an inert root-only release tree", "Leave service, state, accounts, registration, and listeners unchanged"],
        blockers: [],
        warnings: ["Keep the managed-secret key with the database"], recovery: { summary: "Preserve workspace data", preservesData: true },
      },
    };
    const artifactPlan = {
      id: "keel-artifact-plan", revision: "artifact-revision", input: { acquisitionId: "11111111-1111-4111-8111-111111111111", expectedArtifactState: "absent" }, expiresAt: "2026-08-16T04:00:00Z",
      output: { executable: true, currentState: "absent", partialPresent: false, provenanceMatched: true, artifact, changes: ["Download only the fixed archive", "Keep it unextracted and uninstalled"], blockers: [], recovery: { summary: "Remove only fixed partial files on failure" } },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/applications/keel/artifact-plans")) return new Response(JSON.stringify({ plan: artifactPlan }), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/keel-artifact-plans/keel-artifact-plan/stage")) return new Response(JSON.stringify({ job: { id: "job-one", state: "awaiting_approval" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/v1/application-plans/keel-plan/stage")) return new Response(JSON.stringify({ job: { id: "job-two", state: "awaiting_approval", type: "application.keel.stage" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(String(init?.body))).toEqual({ target: "native-service", hostPort: 3000 });
      return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} />);

    expect(await screen.findByText("Keel Notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan safe staging" }));
    expect(screen.getByText("Guarded native lifecycle enabled")).toBeTruthy();
    expect(screen.getByText("Terminal-only instance-owner login proof")).toBeTruthy();
    expect(screen.getByText(/State: not-run \| current database: not matched \| owner route: not verified/)).toBeTruthy();
    expect(screen.getByText(/Native candidates: 0 \| Docker candidates: 0/)).toBeTruthy();
    expect(screen.getByText(/Release asset digest pinned/)).toBeTruthy();
    expect(screen.getByText(/State: verified \| local bytes verified: yes/)).toBeTruthy();
    expect(screen.getByText(/State: safe \| safe to extract: yes/)).toBeTruthy();
    expect(screen.getByText(/State: absent \| staged: no \| ready: yes/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Deployment target" })).toHaveProperty("value", "native-service");
    fireEvent.click(screen.getByRole("button", { name: "Generate live plan" }));
    expect(await screen.findByText("Ready to stage")).toBeTruthy();
    expect(screen.getAllByText(/884e7ab1cc48/)).toHaveLength(1);
    expect(screen.getByText(/verified from local bytes: yes/)).toBeTruthy();
    expect(screen.getByText("Plan-time discovery")).toBeTruthy();
    expect(screen.getByText("Plan-time archive gate")).toBeTruthy();
    expect(screen.getByText("Plan-time staging boundary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage inert release for approval" }));
    expect(await screen.findByText(/Keel 1.2.6 inert staging job created/)).toBeTruthy();
  });
});

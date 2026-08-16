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

  it("shows an exact Keel release plan while keeping every execution step locked", async () => {
    const artifact = {
      repository: "AES256Afro/Keel", releaseTag: "v1.2.5", releaseCommitSha: "bcf872e2cee5820bdeb74685f5573cc6beb0a28f",
      name: "keel-1.2.5-linux-x64.tar.gz", sizeBytes: 47655144,
      digest: "sha256:4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee",
      locallyVerifiedByBoxPilot: false,
    };
    const application = {
      id: "keel", name: "Keel Notes", category: "Knowledge", description: "Self-hosted notebook", execution: "planning-only", risk: "stateful", targets: ["native-service"],
      image: { version: "1.2.5", digestPinned: false }, artifact, integrity: `sha256:${"c".repeat(64)}`,
      live: { installed: false, state: "not-installed", healthy: false, kind: null, version: null, listener: "none", healthIdentityVerified: false, risks: [], native: { candidateCount: 0 }, docker: { available: true, candidateCount: 0 }, provenance: { status: "matched", checkedAt: "2026-08-16T04:00:00Z" }, detail: "No supported Keel installation was found", boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false } },
    };
    const plan = {
      id: "keel-plan", subjectId: "keel", revision: "revision789", input: { target: "native-service", hostPort: 3000 }, expiresAt: "2026-08-16T04:00:00Z",
      output: {
        executable: false, artifact: { ...artifact, githubReportedDigestMatched: true }, image: application.image,
        discovery: { installed: false, state: "not-installed", healthy: false, kind: null, version: null, port: 3000, listener: "none", healthIdentityVerified: false, risks: [], native: { candidateCount: 0 }, docker: { available: true, candidateCount: 0 }, detail: "No supported Keel installation was found", boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false } },
        changes: ["Require a five-minute one-use terminal claim"],
        blockers: [{ id: "keel.execution", summary: "Keel installation remains disabled", repair: { description: "Complete the restricted adapter" } }],
        warnings: ["Keep the managed-secret key with the database"], recovery: { summary: "Preserve workspace data", preservesData: true },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(String(init?.body))).toEqual({ target: "native-service", hostPort: 3000 });
      return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} />);

    expect(await screen.findByText("Keel Notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan deployment" }));
    expect(screen.getByText("Discovery only")).toBeTruthy();
    expect(screen.getByText(/Native candidates: 0 \| Docker candidates: 0/)).toBeTruthy();
    expect(screen.getByText(/Release asset digest pinned/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Deployment target" })).toHaveProperty("value", "native-service");
    fireEvent.click(screen.getByRole("button", { name: "Generate live plan" }));
    expect(await screen.findByText("Planning result")).toBeTruthy();
    expect(screen.getByText(/bcf872e2cee5/)).toBeTruthy();
    expect(screen.getByText(/verified from local bytes: no/)).toBeTruthy();
    expect(screen.getByText("Plan-time discovery")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stage for approval" })).toBeNull();
  });
});

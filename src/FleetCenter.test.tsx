import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FleetCenter from "./FleetCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const status = {
  agents: [{
    id: "11111111-1111-4111-8111-111111111111", name: "macbook-lan", fingerprint: "a".repeat(64), capabilities: ["dns-probe-v1"],
    status: "active", lastSequence: 4, enrolledAt: "2026-08-16T01:00:00.000Z", lastSeenAt: "2026-08-16T01:30:00.000Z",
  }],
  tasks: [],
  evidence: [],
  enrollment: { tokenTtlMinutes: 10, keyType: "Ed25519", tokenStoredAsDigest: true },
  executionBoundary: {
    controllerShellAccess: false, arbitraryCommands: false, arbitraryTargets: false,
    supportedTasks: ["dns.pi-hole.acceptance.v1", "dns.flint2-adguard.acceptance.v1"], nodeLocalExecution: true, routerMutationSupported: false, dnsCutoverSupported: false,
  },
  schedulingPolicy: {
    mode: "owner-approved-one-shot", allowedDelayMinutes: [0, 5, 10], executionWindowMinutes: 10,
    recurrenceSupported: false, unattendedExecutionSupported: false, cancellationSupported: false,
    taskTypes: ["dns.pi-hole.acceptance.v1", "dns.flint2-adguard.acceptance.v1"], targetSources: ["fresh-passing-pi-hole-controller-acceptance", "fresh-passing-flint2-gateway-controller-acceptance"], passwordReauthenticationRequired: true,
  },
};

describe("Fleet Center", () => {
  it("shows the no-shell boundary and creates a one-time enrollment command after reauthentication", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/fleet") && !init?.method) return new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(input.toString()).toContain("/api/v1/fleet/enrollments");
      expect(init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf" });
      expect(JSON.parse(String(init?.body))).toEqual({ password: "correct horse battery" });
      return new Response(JSON.stringify({ enrollment: { token: "secret-one-time-token", expiresAt: "2026-08-16T02:00:00.000Z" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FleetCenter csrfToken="csrf" />);

    expect(await screen.findByText("No remote shell")).toBeTruthy();
    expect(screen.getByText("Commands unavailable")).toBeTruthy();
    expect(screen.getByText("One-shot only")).toBeTruthy();
    expect(screen.getByText("No recurrence")).toBeTruthy();
    expect(screen.getAllByText("macbook-lan")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "second-lan-device" } });
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create 10-minute token" }));

    expect(await screen.findByText(/secret-one-time-token/)).toBeTruthy();
    expect(screen.getByText("npm run agent -- run-once")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("schedules a Flint 2 proof without sending a resolver or query contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/fleet") && !init?.method) return new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(url).toBe("/api/v1/fleet/flint2-dns-probe-tasks");
      expect(JSON.parse(String(init?.body))).toEqual({ agentId: status.agents[0].id, delayMinutes: 5, password: "correct horse battery" });
      expect(String(init?.body)).not.toContain("192.168.8.1");
      return new Response(JSON.stringify({ task: { id: "task-one", agentId: status.agents[0].id, type: "dns.flint2-adguard.acceptance.v1", state: "pending", createdAt: "2026-08-16T02:00:00.000Z", availableAt: "2026-08-16T02:05:00.000Z", expiresAt: "2026-08-16T02:15:00.000Z" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FleetCenter csrfToken="csrf" />);
    await screen.findByText("Independent DNS proof");
    fireEvent.change(screen.getByLabelText("Proof source"), { target: { value: "flint2-adguard" } });
    fireEvent.change(screen.getByLabelText("Start delay"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Owner password for task"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule fixed Flint 2 proof" }));
    expect(await screen.findByText(/One-shot Flint 2 gateway DNS probe task-one/)).toBeTruthy();
  });
});

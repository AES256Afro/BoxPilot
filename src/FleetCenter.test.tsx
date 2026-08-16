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
    supportedTasks: ["dns.pi-hole.acceptance.v1"], nodeLocalExecution: true, routerMutationSupported: false, dnsCutoverSupported: false,
  },
  schedulingPolicy: {
    mode: "owner-approved-one-shot", allowedDelayMinutes: [0, 5, 10], executionWindowMinutes: 10,
    recurrenceSupported: false, unattendedExecutionSupported: false, cancellationSupported: false,
    taskType: "dns.pi-hole.acceptance.v1", targetSource: "fresh-passing-controller-acceptance-only", passwordReauthenticationRequired: true,
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
});

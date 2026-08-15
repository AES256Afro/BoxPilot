import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BoxPilot console", () => {
  function authenticatedFetch(input: RequestInfo | URL) {
    const url = input.toString();
    const body = url.includes("/auth/status")
      ? { bootstrapRequired: false, authenticated: true, owner: { id: "owner-one", username: "operator" }, csrfToken: "csrf-token", expiresAt: "2026-08-15T20:00:00Z" }
      : url.endsWith("/api/v1/applications")
        ? { applications: [{ id: "uptime-kuma", name: "Uptime Kuma", category: "Monitoring", description: "Private monitoring", execution: "enabled", risk: "low", targets: ["docker"], image: { version: "2.5.0", digestPinned: true }, integrity: `sha256:${"a".repeat(64)}`, live: { installed: false, state: "not-installed", detail: "Ready to plan" } }] }
      : { status: "ok", mode: "host-aware" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }

  it("navigates between product areas", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("sample data");
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(await screen.findByText("Uptime Kuma")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("staging are live");
  });

  it("opens the browser-only Compose inspector", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import Compose" }));
    expect(screen.getByRole("dialog", { name: "Inspect a Compose stack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run dry scan" }));
    expect(screen.getByText("No high-risk patterns detected by this basic scan.")).toBeTruthy();
  });

  it("renders the live redacted virtualization audit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const body = url.includes("/auth/status")
        ? { bootstrapRequired: false, authenticated: true, owner: { id: "owner-one", username: "operator" }, csrfToken: "csrf-token", expiresAt: "2026-08-15T20:00:00Z" }
        : url.includes("/audit")
        ? { available: true, persistent: true, events: [{ id: "one", timestamp: "2026-08-14T12:00:00Z", type: "vm.plan.created", revision: "abc123", domain: "ubuntu-lab" }] }
        : { status: "ok", mode: "host-aware" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Logs/ }));

    expect(await screen.findByText("Plan abc123 validated for ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("Persistent")).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BoxPilot console", () => {
  it("navigates between product areas", () => {
    render(<App />);
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("sample data");
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.getByText("Keel Notes")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("never deploys");
  });

  it("opens the browser-only Compose inspector", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import Compose" }));
    expect(screen.getByRole("dialog", { name: "Inspect a Compose stack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run dry scan" }));
    expect(screen.getByText("No high-risk patterns detected by this basic scan.")).toBeTruthy();
  });

  it("renders the live redacted virtualization audit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const body = url.includes("/audit")
        ? { available: true, persistent: true, events: [{ id: "one", timestamp: "2026-08-14T12:00:00Z", type: "vm.plan.created", revision: "abc123", domain: "ubuntu-lab" }] }
        : { status: "ok", mode: "host-aware" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Logs/ }));

    expect(await screen.findByText("Plan abc123 validated for ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("Persistent")).toBeTruthy();
  });
});

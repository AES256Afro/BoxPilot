import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MigrationCenter from "./MigrationCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("read-only Migration Center", () => {
  it("imports a source manifest and creates a locked compatibility plan", async () => {
    let imported = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/sources") && !init?.method) return new Response(JSON.stringify({ sources: imported ? [{ id: "source-one", fingerprint: `sha256:${"a".repeat(64)}`, importedAt: "2026-08-15T20:00:00Z", source: { hostname: "oldbox", operatingSystem: "Ubuntu", architecture: "x64", kernel: "7" }, capacity: {}, counts: { containers: 1, images: 1, networks: 1, volumes: 1, projects: 1 } }] : [] }), { status: 200 });
      if (url.endsWith("/import")) { imported = true; return new Response(JSON.stringify({ source: { id: "source-one" } }), { status: 201 }); }
      if (url.endsWith("/plans")) return new Response(JSON.stringify({ plan: { id: "plan-one", revision: "rev-one", output: { blockers: [], warnings: ["Read-only snapshot"], changes: ["Preserve source"], readyForTransferPlanning: true, executable: false } } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));
    render(<MigrationCenter csrfToken="csrf" />);
    fireEvent.change(screen.getByLabelText("Source manifest JSON"), { target: { value: '{"schemaVersion":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and import" }));
    expect(await screen.findByText("oldbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan compatibility" }));
    expect(await screen.findByRole("region", { name: "Migration compatibility plan" })).toBeTruthy();
    expect(screen.getByText("Transfer locked")).toBeTruthy();
  });
});

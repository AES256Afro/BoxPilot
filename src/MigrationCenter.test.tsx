import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MigrationCenter from "./MigrationCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("guarded Migration Center", () => {
  it("imports a source manifest and creates a locked compatibility plan", async () => {
    let imported = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/sources") && !init?.method) return new Response(JSON.stringify({ sources: imported ? [{ id: "source-one", fingerprint: `sha256:${"a".repeat(64)}`, importedAt: "2026-08-15T20:00:00Z", source: { hostname: "oldbox", operatingSystem: "Ubuntu", architecture: "x64", kernel: "7" }, capacity: {}, counts: { containers: 1, images: 1, networks: 1, volumes: 1, projects: 1 } }] : [] }), { status: 200 });
      if (url.endsWith("/bundles")) return new Response(JSON.stringify({ bundles: [], invalidBundles: [], transfers: [] }), { status: 200 });
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
    expect(screen.getByText("Evidence only")).toBeTruthy();
  });

  it("plans and stages an exact checksummed bundle without activation", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const bundle = {
      bundleId: "11111111-1111-4111-8111-111111111111", workloadName: "keel-notes", sourceFingerprint: fingerprint,
      sourceId: "source-one", sourceHostname: "oldbox", createdAt: "2026-08-15T20:00:00.000Z", composeFile: "compose.yaml",
      contentRevision: "b".repeat(64), fileCount: 4, sensitiveFileCount: 1, totalBytes: 8192, destinationState: "empty",
      remainingBytes: 8192, verifiedBytes: 0, executable: true, blockers: [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/sources") && !init?.method) return new Response(JSON.stringify({ sources: [{ id: "source-one", fingerprint, importedAt: bundle.createdAt, source: { hostname: "oldbox", operatingSystem: "Ubuntu", architecture: "x64", kernel: "7" }, capacity: {}, counts: { containers: 1, images: 1, networks: 1, volumes: 1, projects: 1 } }] }), { status: 200 });
      if (url.endsWith("/bundles") && !init?.method) return new Response(JSON.stringify({ bundles: [bundle], invalidBundles: [], transfers: [] }), { status: 200 });
      if (url.endsWith("/transfer-plans")) return new Response(JSON.stringify({ plan: { id: "transfer-plan", revision: "revision-one", output: { executable: true, workloadName: "keel-notes", sourceHostname: "oldbox", composeFile: "compose.yaml", fileCount: 4, sensitiveFileCount: 1, totalBytes: 8192, remainingBytes: 8192, destinationState: "empty", blockers: [], changes: ["Copy exact files", "Keep the source unchanged"], verification: ["Per-file SHA-256"], warnings: ["Activation is disabled"], recovery: "Replan to resume exact verified files. The source remains unchanged.", sourcePreserved: true, activationPerformed: false } } }), { status: 201 });
      if (url.includes("/migration-transfer-plans/") && url.endsWith("/stage")) return new Response(JSON.stringify({ job: { id: "22222222-2222-4222-8222-222222222222" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));

    render(<MigrationCenter csrfToken="csrf" />);
    expect(await screen.findByText("keel-notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan staged transfer" }));
    expect(await screen.findByRole("region", { name: "Migration transfer plan" })).toBeTruthy();
    expect(screen.getByText("Activation is disabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage transfer for approval" }));
    expect(await screen.findByText(/Job 22222222 is awaiting approval/)).toBeTruthy();
  });
});

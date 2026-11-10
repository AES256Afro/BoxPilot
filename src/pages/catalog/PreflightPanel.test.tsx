import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { PreflightPanel } from "./PreflightPanel";
import type { PortReading } from "./preflight";
import type { Manifest, Values } from "./types";

// The panel at the head of the install form (2026-11-10): it reads the inventory and Storage's
// forecast, and draws what preflight.ts worked out. The form's own part (asking the precheck about
// ports, moving a taken one) is held in ConfigSheet.test.tsx.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GiB = 1024 ** 3;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const inventory = {
  host: { hostname: "homebox", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0", uptimeSeconds: 90_000 },
  compute: { cpuCount: 8, cpuModel: "fixture", load1: 0.5, loadPercent: 6, totalMemoryBytes: 32 * GiB, usedMemoryBytes: 11 * GiB, memoryUsedPercent: 34 },
  storage: { root: { totalBytes: 100 * GiB, usedBytes: 27 * GiB, usedPercent: 27 }, filesystems: { mounts: [{ target: "/", source: "/dev/sda2", totalBytes: 100 * GiB, usedBytes: 27 * GiB, usedPercent: 27, capacityState: "healthy" }] } },
  network: { addresses: [], tailscale: { installed: true, connected: true, dnsName: null } },
};
const manifest = {
  id: "mealie", name: "Mealie", category: "Food", description: "Recipes", website: null, icon: null, risk: "medium", notes: null,
  image: { reference: "mealie:2", version: "2", digestPinned: false },
  ports: [{ id: "web", label: "Web UI", container: 9000, host: 9000, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "serve" }],
  volumes: [{ id: "data", label: "Data", container: "/data", path: "data", hostPath: null, readOnly: false, backup: true, configurable: false, description: null }],
  env: [], health: { kind: "running", stableSeconds: 10, timeoutSeconds: 180 }, network: "bridge", sidecars: [], sha256: "a",
} as Manifest;
const values: Values = { ports: { web: 9000 }, env: {}, volumes: {} };
const clear: PortReading = { state: "read", conflicts: [], moved: {} };
const host = { lanAddress: "192.0.2.10", tailscaleDnsName: null };

function serve(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    asked.push(url);
    return answers[url]?.() ?? json({ error: `unexpected ${url}` }, 500);
  }));
  return asked;
}
const verdict = () => document.querySelector(".catalog-preflight__result .ui-chip");
const cells = (item: string) => [...screen.getByRole("row", { name: new RegExp(`^${item}`) }).querySelectorAll("td")].map((cell) => cell.textContent);
const panel = (props: Partial<Parameters<typeof PreflightPanel>[0]> = {}) => <PreflightPanel manifest={manifest} values={values} ports={clear} host={host} appNameFor={() => null} nightly={null} {...props} />;

describe("the install form's Will it fit panel", () => {
  it("reads the inventory and draws the result, the table and where it will answer", async () => {
    const asked = serve({ "/api/v1/inventory": () => json(inventory), "/api/v1/storage/forecast": () => json({ forecasts: [] }) });
    render(panel());
    // Not green while it is still reading.
    expect(verdict()?.textContent).toBe("Checking…");
    expect(verdict()?.getAttribute("data-status")).toBe("unknown");
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    expect(cells("Memory")).toEqual(["Memory", "11.0 GB", "not stated", "", "21.0 GB of 32.0 GB", "Pass"]);
    expect(cells("System disk")).toEqual(["System disk", "27.0 GB", "not stated", "", "73.0 GB of 100.0 GB", "Pass"]);
    expect(cells("Port")).toEqual(["Port", "9000 is free", "takes 9000", "", "no clash", "Pass"]);
    expect(within(screen.getByRole("region", { name: "Where it will answer" })).getByText("http://192.0.2.10:9000")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "From the first night" })).toBeNull();
    expect(asked.sort()).toEqual(["/api/v1/inventory", "/api/v1/storage/forecast"]);
  });

  it("takes the inventory from the facts Home keeps when it is drawn inside them, reading that one source again", async () => {
    const asked = serve({ "/api/v1/inventory": () => json(inventory), "/api/v1/storage/forecast": () => json({ forecasts: [] }) });
    render(<FactsProvider>{panel()}</FactsProvider>);
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    expect(screen.getByRole("heading", { name: "What it takes from homebox" })).toBeTruthy();
    // The inventory alone: opening an install form does not load Home's other fifteen sources.
    expect(asked.sort()).toEqual(["/api/v1/inventory", "/api/v1/storage/forecast"]);
  });

  it("says Not read when the inventory does not answer, and carries on without a forecast", async () => {
    serve({});
    render(panel());
    await waitFor(() => expect(verdict()?.textContent).toBe("Not read"));
    expect(verdict()?.getAttribute("data-status")).toBe("unknown");
    expect(cells("Memory")).toEqual(["Memory", "not read", "not stated", "", "not read", "Not read"]);
    expect(screen.getByText("Memory and System disk could not be read, so this cannot say it fits.")).toBeTruthy();
  });

  it("says why a row is a caution or does not fit, in a notice under the table", async () => {
    const full = { ...inventory, compute: { ...inventory.compute, usedMemoryBytes: 29 * GiB, memoryUsedPercent: 91 } };
    serve({ "/api/v1/inventory": () => json(full), "/api/v1/storage/forecast": () => json({ forecasts: [{ target: "/", daysToFull: 9 }] }) });
    render(panel({ manifest: { ...manifest, needs: { memoryMb: 8192, diskMb: null } } }));
    await waitFor(() => expect(verdict()?.textContent).toBe("Does not fit"));
    expect(screen.getByText("Does not fit as it stands")).toBeTruthy();
    expect(screen.getByText("Memory: it states 8.0 GB and 3.0 GB is free.")).toBeTruthy();
    // Storage's fourteen-day warning for the system disk, in the same breath.
    expect(screen.getByText("System disk is on track to fill in about 9 days, at the rate free space has been dropping.")).toBeTruthy();
    expect(cells("System disk")[5]).toBe("Caution");
  });
});

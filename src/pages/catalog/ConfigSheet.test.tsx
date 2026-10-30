import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSheet } from "./ConfigSheet";
import type { LiveState, Manifest, Values } from "./types";

// Settings → Save sends only what the owner changed, and secrets show as saved (30 Oct 2026: an
// owner reopened TheySpy's Settings, saw empty API key boxes, and typed the keys again).

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const env = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, description: null, type: "text", secret: false, required: false, fixed: false, generate: false, default: "", options: null, ...extra });
const manifest = {
  id: "theyspy", name: "TheySpy", category: "Security", description: "d", website: null, icon: null, risk: "low", notes: null,
  image: { reference: "x/theyspy:1", version: "1", digestPinned: true }, health: { kind: "healthcheck", timeoutSeconds: 120 }, sha256: "a",
  ports: [{ id: "web", label: "Dashboard", container: 8797, host: 8797, protocol: "tcp", exposure: "lan", fixed: false }],
  volumes: [],
  env: [
    env("TS_PIHOLE_URL"),
    env("TS_PIHOLE_PASSWORD", { type: "password", secret: true }),
    env("TS_NVD_API_KEY", { type: "password", secret: true }),
    env("TS_NTFY_TOKEN", { type: "password", secret: true }),
    env("TS_ADMIN_PASSWORD", { type: "password", secret: true, generate: true }),
  ],
} as unknown as Manifest;
const live = {
  id: "theyspy", installed: true, dataPresent: true,
  state: { installedAt: "x", updatedAt: "x", manifestSha256: "a", image: null, values: { ports: { web: 8797 }, env: { TS_PIHOLE_URL: "http://192.168.8.2" }, volumes: {} }, pinnedRollback: false, uninstalledAt: null, secretsSaved: ["TS_PIHOLE_PASSWORD", "TS_NVD_API_KEY"] },
  container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "x" }, urls: [],
} as unknown as LiveState;

function open() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, errors: [], conflicts: [] }), { headers: { "Content-Type": "application/json" } })));
  const onSubmit = vi.fn<(values: Values, form: Values) => void>();
  render(<ConfigSheet manifest={manifest} live={live} mode="reconfigure" csrfToken="t" onSubmit={onSubmit} onCancel={() => {}} />);
  return onSubmit;
}
const box = (name: string) => document.querySelector(`[data-secret="${name}"] input`) as HTMLInputElement;
const save = () => fireEvent.submit(document.querySelector("form.catalog-form")!);

describe("app Settings", () => {
  it("shows a saved secret as saved, and an unsaved one as empty", () => {
    open();
    expect(box("TS_NVD_API_KEY").placeholder).toBe("Saved · leave empty to keep");
    expect(box("TS_PIHOLE_PASSWORD").placeholder).toBe("Saved · leave empty to keep");
    expect(box("TS_NTFY_TOKEN").placeholder).toBe("");
    expect(box("TS_NVD_API_KEY").value).toBe(""); // the value itself never reaches the browser
  });

  it("changing only the port sends only the port: every other setting and secret stays", async () => {
    const onSubmit = open();
    fireEvent.change(screen.getByDisplayValue("8797"), { target: { value: "8798" } });
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({ ports: { web: 8798 }, env: {}, volumes: {} });
  });

  it("clears a saved secret only when asked, and typing a new one replaces instead", async () => {
    const onSubmit = open();
    fireEvent.click(within(document.querySelector('[data-secret="TS_NVD_API_KEY"]') as HTMLElement).getByRole("button", { name: "Clear" }));
    expect(within(document.querySelector('[data-secret="TS_PIHOLE_PASSWORD"]') as HTMLElement).getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(box("TS_NVD_API_KEY").placeholder).toBe("Will be cleared when you save");
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({ ports: {}, env: {}, volumes: {}, clearSecrets: ["TS_NVD_API_KEY"] });

    fireEvent.change(box("TS_NVD_API_KEY"), { target: { value: "a-new-key" } });
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][0]).toEqual({ ports: {}, env: { TS_NVD_API_KEY: "a-new-key" }, volumes: {} });
  });
});

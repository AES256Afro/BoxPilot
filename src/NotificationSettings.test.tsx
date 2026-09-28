import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotificationSettings from "./NotificationSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Notification settings", () => {
  it("saves an ntfy target with the owner password", async () => {
    let saved: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/settings/notifications") && init?.method === "PUT") { saved = init.body as string; return json({ configured: true, kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot", hasToken: false }); }
      if (url.endsWith("/settings/notifications")) return json({ configured: false, kind: null, url: null, topic: null, hasToken: false });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NotificationSettings csrfToken="csrf-token" />);

    expect(await screen.findByText("Off")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://127.0.0.1:8093" } });
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Saved\./)).toBeTruthy();
    expect(screen.getByText("ntfy configured")).toBeTruthy();
    expect(JSON.parse(saved ?? "{}")).toEqual({ target: { kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" }, password: "correct horse battery" });
  });

  it("offers the ntfy running on this server, prefilling its loopback address in one click", async () => {
    let saved: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/settings/notifications") && init?.method === "PUT") { saved = init.body as string; return json({ configured: true, kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot", hasToken: false }); }
      if (url.endsWith("/settings/notifications")) return json({ configured: false, kind: null, url: null, topic: null, hasToken: false });
      if (url.endsWith("/settings/watch")) return json({ targetConfigured: false, activeCount: 0, conditions: [] });
      if (url.includes("/api/v1/catalog")) return json({ applications: [{ manifest: { id: "ntfy", name: "ntfy" }, live: { installed: true, container: { running: true }, urls: [{ host: 8093 }] } }], host: { lanAddress: "192.168.1.10", tailscaleDnsName: "homebox.tail0a1b.ts.net" } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NotificationSettings csrfToken="csrf-token" />);

    // One click fills in the address the owner would otherwise have to know, and only the password is left.
    fireEvent.click(await screen.findByRole("button", { name: "Use the ntfy on this server" }));
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("http://127.0.0.1:8093");
    // Now it explains how the phone actually receives, which loopback does not answer on its own.
    expect(screen.getByText(/subscribe to/)).toBeTruthy();
    expect(screen.getByText(/homebox\.tail0a1b\.ts\.net/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved\./)).toBeTruthy();
    expect(JSON.parse(saved ?? "{}").target).toEqual({ kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" });
  });

  it("sends a test from a configured target", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/settings/notifications/test") && init?.method === "POST") return json({ sent: true, kind: "gotify" });
      if (url.endsWith("/settings/notifications")) return json({ configured: true, kind: "gotify", url: "http://127.0.0.1:8091", topic: null, hasToken: true });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NotificationSettings csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
    expect(await screen.findByText(/Test sent/)).toBeTruthy();
  });

  it("shows the weekly report's schedule, previews it, sends it now and turns it off (M30.4)", async () => {
    const report = { title: "Weekly report, 1 failed", message: "Sep 20 to Sep 27: 12 jobs ran, 1 failed: Back up application data (immich).\nBackups: 7 app backups this week; database backed up today." };
    const calls: string[] = [];
    let enabled = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/settings/weekly-report/preview")) return json(report);
      if (url.endsWith("/settings/weekly-report/send") && init?.method === "POST") return json({ sent: true, ...report });
      if (url.endsWith("/settings/weekly-report") && init?.method === "PUT") { enabled = JSON.parse(init.body as string).enabled; return json({ enabled, cadence: "Sundays at 09:00", nextDueAt: null, lastSentAt: null, lastResult: null, targetConfigured: true }); }
      if (url.endsWith("/settings/weekly-report")) return json({ enabled, cadence: "Sundays at 09:00", nextDueAt: "2026-10-04T13:00:00.000Z", lastSentAt: null, lastResult: "not-announced", targetConfigured: true });
      if (url.endsWith("/settings/notifications")) return json({ configured: true, kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot", hasToken: false });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NotificationSettings csrfToken="csrf-token" />);

    expect(await screen.findByText("Weekly report")).toBeTruthy();
    expect(screen.getByText(/Sundays at 09:00, server time; next/)).toBeTruthy();
    expect(screen.getByText(/The last one reached no one/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = await screen.findByLabelText("Weekly report preview");
    expect(preview.textContent).toContain("Weekly report, 1 failed");
    expect(preview.textContent).toContain("Back up application data (immich)");

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("Sent. Check your device.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn off the weekly report" }));
    expect(await screen.findByText(/^Off\./)).toBeTruthy();
    expect(calls).toContain("PUT /api/v1/settings/weekly-report");
    expect(screen.getByRole("button", { name: "Turn on the weekly report" })).toBeTruthy();
  });

  it("does not offer to send the report now without a target", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/settings/weekly-report")) return json({ enabled: true, cadence: "Sundays at 09:00", nextDueAt: "2026-10-04T13:00:00.000Z", lastSentAt: null, lastResult: null, targetConfigured: false });
      if (url.endsWith("/settings/notifications")) return json({ configured: false, kind: null, url: null, topic: null, hasToken: false });
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<NotificationSettings csrfToken="csrf-token" />);
    expect(((await screen.findByRole("button", { name: "Send now" })) as HTMLButtonElement).disabled).toBe(true);
  });
});

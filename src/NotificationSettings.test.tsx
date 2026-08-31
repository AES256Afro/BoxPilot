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
      if (url.endsWith("/catalog")) return json({ applications: [{ manifest: { id: "ntfy", name: "ntfy" }, live: { installed: true, container: { running: true }, urls: [{ host: 8093 }] } }], host: { lanAddress: "192.168.8.10", tailscaleDnsName: "homebox.tail0a1b.ts.net" } });
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
});

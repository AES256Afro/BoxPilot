import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SingleSignOnPanel from "./SingleSignOnPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const grafana = { id: "client-1", name: "Grafana", redirectUris: ["https://grafana.example/cb"], createdAt: "2026-10-01T00:00:00.000Z" };

function serve({ clients = [grafana], ready = true, post = () => json({ id: "client-2" }, 201), remove = () => json({ removed: true }) }: { clients?: typeof grafana[]; ready?: boolean; post?: () => Response; remove?: () => Response } = {}) {
  const sent: Array<{ method: string; url: string; csrf: string | undefined; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET") return json({ issuer: "https://box.example", discovery: "https://box.example/.well-known/openid-configuration", clients, status: { ready, detail: ready ? null : "The signing key could not be read" } });
    sent.push({ method, url, csrf: (init?.headers as Record<string, string>)["X-BoxPilot-CSRF"], body: init?.body ? JSON.parse(String(init.body)) : null });
    return method === "POST" ? post() : remove();
  }));
  return sent;
}

describe("Single sign-on panel", () => {
  it("gives the discovery URL and issuer, and lists the registered apps", async () => {
    serve();
    render(<SingleSignOnPanel csrfToken="csrf" />);
    expect(await screen.findByText("https://box.example/.well-known/openid-configuration")).toBeTruthy();
    expect(screen.getByText("https://box.example")).toBeTruthy();
    expect(screen.getByText("client-1")).toBeTruthy();
  });

  it("registers an app with each redirect URL on its own, sent with the CSRF token", async () => {
    const sent = serve({ clients: [] });
    render(<SingleSignOnPanel csrfToken="csrf" />);
    expect(await screen.findByText('No apps use "Sign in with BoxPilot" yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("App name"), { target: { value: "Wiki" } });
    fireEvent.change(screen.getByLabelText("Redirect URLs"), { target: { value: " https://wiki.example/cb \n\nhttps://wiki.example/alt, https://wiki.example/third" } });
    fireEvent.click(screen.getByRole("button", { name: "Register app" }));
    expect(await screen.findByText("Registered Wiki.")).toBeTruthy();
    expect(sent).toEqual([{ method: "POST", url: "/api/v1/oidc/clients", csrf: "csrf", body: { name: "Wiki", redirectUris: ["https://wiki.example/cb", "https://wiki.example/alt", "https://wiki.example/third"] } }]);
    expect((screen.getByLabelText("App name") as HTMLInputElement).value).toBe("");
  });

  it("says why a registration was refused and keeps what was typed", async () => {
    serve({ post: () => json({ error: "Not a valid redirect URI: ftp://x" }, 400) });
    render(<SingleSignOnPanel csrfToken="csrf" />);
    fireEvent.change(await screen.findByLabelText("App name"), { target: { value: "Wiki" } });
    fireEvent.change(screen.getByLabelText("Redirect URLs"), { target: { value: "ftp://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Register app" }));
    expect(await screen.findByText("Not a valid redirect URI: ftp://x")).toBeTruthy();
    expect((screen.getByLabelText("App name") as HTMLInputElement).value).toBe("Wiki");
  });

  it("asks before removing an app, and Keep it leaves it registered", async () => {
    const sent = serve();
    render(<SingleSignOnPanel csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Grafana" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stops working for good/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Grafana" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed Grafana.")).toBeTruthy();
    expect(sent).toEqual([{ method: "DELETE", url: "/api/v1/oidc/clients/client-1", csrf: "csrf", body: null }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says single sign-on is not ready, and why", async () => {
    serve({ ready: false });
    render(<SingleSignOnPanel csrfToken="csrf" />);
    expect(await screen.findByText("The signing key could not be read")).toBeTruthy();
    expect(screen.getByText("not ready")).toBeTruthy();
  });
});

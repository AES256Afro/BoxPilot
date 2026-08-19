import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SignInSettings from "./SignInSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Sign-in settings", () => {
  it("offers to link the current Tailscale identity with the owner password", async () => {
    let linkBody: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/auth/identity/links")) return json({ tailscaleLogins: [], githubLogins: [], githubConfigured: false, githubClientId: "", currentTailscale: { login: "me@example.com", displayName: "Me", node: "laptop.tail.ts.net", linked: false } });
      if (url.endsWith("/auth/identity/tailscale") && init?.method === "POST") { linkBody = init.body as string; return json({ tailscaleLogins: ["me@example.com"], login: "me@example.com" }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SignInSettings csrfToken="csrf-token" />);
    const button = (await screen.findByRole("button", { name: "Link me@example.com" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Owner password for sign-in settings"), { target: { value: "correct horse battery" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText(/Tailscale identity linked/)).toBeTruthy();
    expect(JSON.parse(linkBody ?? "{}")).toEqual({ password: "correct horse battery" });
  });
});

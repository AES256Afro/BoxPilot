import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SignInSettings from "./SignInMethodsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
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
    // Disabled with its reason, read out with it rather than only in a tooltip.
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Type your password above first");
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "correct horse battery" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText(/Tailscale identity linked/)).toBeTruthy();
    expect(JSON.parse(linkBody ?? "{}")).toEqual({ password: "correct horse battery" });
  });

  const githubApi = () => {
    const polls: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/auth/identity/links")) return json({ tailscaleLogins: [], githubLogins: [], githubConfigured: true, githubClientId: "Ov23liexample", currentTailscale: null });
      if (url.endsWith("/auth/identity/github/start")) return json({ flowId: "f1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, intervalSeconds: 5 });
      if (url.endsWith("/auth/github/poll")) return new Promise<Response>((resolve) => { polls.push(resolve); });
      return json({ error: `unexpected ${url}` }, 500);
    }));
    return polls;
  };
  const startLinking = async () => {
    render(<SignInSettings csrfToken="csrf-token" />);
    fireEvent.change(await screen.findByLabelText("Your password"), { target: { value: "correct horse battery" } });
    const link = await screen.findByRole("button", { name: "Link a GitHub account" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(link); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
  };

  it("cancels a GitHub link in progress and stops polling", async () => {
    const polls = githubApi();
    await startLinking();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(polls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    // Not busy any more: with the password typed again, linking can start over.
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "correct horse battery" } });
    expect((screen.getByRole("button", { name: "Link a GitHub account" }) as HTMLButtonElement).disabled).toBe(false);
    // The answer to the poll that was already out does not schedule another.
    await act(async () => { polls[0](json({ status: "pending" })); await vi.advanceTimersByTimeAsync(20_000); });
    expect(polls).toHaveLength(1);
    expect(screen.queryByText("ABCD-1234")).toBeNull();
  });

  it("does not keep polling after it is removed mid-poll", async () => {
    const polls = githubApi();
    await startLinking();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(polls).toHaveLength(1);
    cleanup();
    await act(async () => { polls[0](json({ status: "pending" })); await vi.advanceTimersByTimeAsync(20_000); });
    expect(polls).toHaveLength(1);
  });
});

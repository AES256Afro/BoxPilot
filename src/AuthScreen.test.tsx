import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthScreen from "./AuthScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("owner authentication screen", () => {
  it("shows the server-local bootstrap command and creates an owner", async () => {
    const onAuthenticated = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ username: "operator", bootstrapToken: "server-token" });
      return new Response(JSON.stringify({ authenticated: true, owner: { id: "one", username: "operator" }, csrfToken: "csrf", expiresAt: "later" }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthScreen bootstrapRequired onAuthenticated={onAuthenticated} />);

    expect(screen.getByText(/boxpilot-owner.mjs create-bootstrap-token/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("Bootstrap token"), { target: { value: "server-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Create owner" }));

    expect(await screen.findByRole("button", { name: "Verifying..." })).toBeTruthy();
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
  });

  it("does not show bootstrap controls on an existing server", () => {
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Sign in to BoxPilot" })).toBeTruthy();
    expect(screen.queryByLabelText("Bootstrap token")).toBeNull();
  });

  it("cancels GitHub sign-in, and a poll already out does not start another", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const polls: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/auth/github/start")) return json({ flowId: "f1", userCode: "WXYZ-9876", verificationUri: "https://github.com/login/device", expiresIn: 900, intervalSeconds: 5 });
      if (url.endsWith("/auth/github/poll")) return new Promise<Response>((resolve) => { polls.push(resolve); });
      return json({ tailscale: { available: false, linked: false }, github: { configured: true }, passkey: { registered: false } });
    }));
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    const start = await screen.findByRole("button", { name: "Sign in with GitHub" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(start); await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("WXYZ-9876")).toBeTruthy();
    expect(polls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("WXYZ-9876")).toBeNull();
    expect((screen.getByRole("button", { name: "Sign in with GitHub" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { polls[0](json({ status: "pending" })); await vi.advanceTimersByTimeAsync(20_000); });
    expect(polls).toHaveLength(1);
  });
});

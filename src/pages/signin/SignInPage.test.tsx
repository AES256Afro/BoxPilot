import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthScreen, { SignInLoading, SignInUnavailable, signedOutWords } from "./SignInPage";

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

describe("signing in again after a session ended (M36)", () => {
  it("says the session ended, why, and which page signing in goes back to", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tailscale: { available: false, login: null, displayName: null, node: null, linked: false }, github: { configured: false } }), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} notice={{ reason: "expired", page: "System" }} />);
    expect(screen.getByRole("heading", { name: "Your session ended" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Your session ended: a sign-in lasts twelve hours, and restarts and updates do not end it. Sign in to go back to System.");
  });

  it("tells a session ended elsewhere from one that ran out", () => {
    expect(signedOutWords({ reason: "ended", page: null })).toMatch(/^You were signed out from somewhere else: .* Sign in to carry on.$/);
    expect(signedOutWords({ reason: "address-changed", page: null })).toMatch(/^You were signed out because this sign-in came from a different network address, .* Sign in to carry on.$/);
  });
});

describe("the sign-in page's ways in (M33.13)", () => {
  const identity = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));

  it("offers a passkey first, then GitHub, then Tailscale, then the password", async () => {
    identity({ tailscale: { available: true, login: "alex@example.com", displayName: "Alex", node: "workbook", linked: true }, github: { configured: true }, passkey: { registered: true } });
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("isSecureContext", true);
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    const ways = await screen.findByRole("group", { name: "Ways to sign in" });
    expect([...ways.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Sign in with a passkey", "Sign in with GitHub", "Continue as Alex (Tailscale)"]);
    // The first way offered is the card's main button; the password's Sign in is not.
    expect(screen.getByRole("button", { name: "Sign in with a passkey" }).className).toContain("ui-button--primary");
    expect(screen.getByRole("button", { name: "Sign in" }).className).not.toContain("ui-button--primary");
  });

  it("makes the password the main way in when it is the only one", async () => {
    identity({ tailscale: { available: false, login: null, displayName: null, node: null, linked: false }, github: { configured: false } });
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    expect(await screen.findByText(/sign-in is not set up yet/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Ways to sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" }).className).toContain("ui-button--primary");
  });

  it("says plainly when BoxPilot does not answer, with a way to try again", () => {
    render(<SignInUnavailable problem="BoxPilot is not answering" />);
    expect(screen.getByRole("heading", { name: "BoxPilot is unavailable" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("BoxPilot is not answering");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();
    render(<SignInLoading />);
    expect(screen.getByRole("heading", { name: "Loading BoxPilot..." })).toBeTruthy();
  });
});

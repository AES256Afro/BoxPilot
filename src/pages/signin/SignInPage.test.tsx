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
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "operator" } });
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
    // The GitHub set-up hint lives in Settings now (M50): the sign-in page sent viewers to a panel they cannot see.
    await screen.findByLabelText("Password");
    expect(screen.queryByText(/sign-in is not set up yet/)).toBeNull();
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

describe("the ways in, each to its end", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const session = { authenticated: true, owner: { id: "o1", username: "alex", role: "owner" }, csrfToken: "csrf", expiresAt: "2026-10-18T23:00:00Z" };
  const linked = { tailscale: { available: true, login: "alex@example.com", displayName: "Alex", node: "workbook", linked: true }, github: { configured: false }, passkey: { registered: false } };

  it("asks for the password once when Tailscale signs in from a new browser, and says when it was refused", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!url.endsWith("/auth/tailscale")) return json(linked);
      const body = JSON.parse(String(init?.body ?? "{}")); bodies.push(body);
      if (!body.password) return json({ error: "Confirm your password once in this browser", code: "device_password_required", username: "alex" }, 401);
      if (body.password !== "correct horse battery") return json({ error: "Wrong password", code: "device_password_required", username: "alex" }, 401);
      return json(session);
    }));
    const onAuthenticated = vi.fn();
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={onAuthenticated} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue as Alex (Tailscale)" }));
    const confirm = await screen.findByRole("button", { name: "Confirm and sign in" });
    expect(screen.getByText(/First time in this browser/).textContent).toContain("alex");
    // Twelve characters at least, as the server asks.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Password for alex"), { target: { value: "not the one!" } });
    fireEvent.click(confirm);
    expect((await screen.findByRole("alert")).textContent).toBe("That password was not accepted");
    fireEvent.change(screen.getByLabelText("Password for alex"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ authenticated: true, bootstrapRequired: false })));
    expect(bodies).toEqual([{}, { password: "not the one!" }, { password: "correct horse battery" }]);
    expect(screen.queryByRole("button", { name: "Confirm and sign in" })).toBeNull();
  });

  it("says why Tailscale sign-in failed when it is not a password question", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().endsWith("/auth/tailscale") ? json({ error: "This tailnet identity is linked to a disabled account" }, 403) : json(linked))));
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue as Alex (Tailscale)" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This tailnet identity is linked to a disabled account");
    expect(screen.queryByRole("button", { name: "Confirm and sign in" })).toBeNull();
  });

  it("signs in with a recovery code, says when one is refused, and goes back to the password", async () => {
    const codes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!input.toString().endsWith("/auth/passkey/recovery")) return json({ ...linked, tailscale: { available: false, linked: false } });
      const { code } = JSON.parse(String(init?.body)); codes.push(code);
      return code === "AAAAA-BBBBB-CCCCC-DDDDD" ? json(session) : json({ error: "That recovery code was used already" }, 401);
    }));
    const onAuthenticated = vi.fn();
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    const use = screen.getByRole("button", { name: "Use recovery code" });
    expect((use as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ" } });
    fireEvent.click(use);
    expect((await screen.findByRole("alert")).textContent).toBe("That recovery code was used already");
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "AAAAA-BBBBB-CCCCC-DDDDD" } });
    fireEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ authenticated: true, bootstrapRequired: false })));
    expect(codes).toEqual(["ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", "AAAAA-BBBBB-CCCCC-DDDDD"]);
    cleanup();
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Use a recovery code instead" })).toBeTruthy();
    expect(screen.queryByLabelText("Recovery code")).toBeNull();
  });

  it("says why the password was refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().endsWith("/auth/login") ? json({ error: "Wrong username or password" }, 401) : json({ tailscale: { available: false, linked: false }, github: { configured: false } }))));
    const onAuthenticated = vi.fn();
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={onAuthenticated} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alex" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong username or password");
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});

describe("GitHub sign-in to its end", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const session = { authenticated: true, owner: { id: "o1", username: "alex", role: "owner" }, csrfToken: "csrf", expiresAt: "2026-10-18T23:00:00Z" };
  function serveFlow(answers: Array<Response | (() => Response)>, start: () => Response = () => json({ flowId: "f1", userCode: "WXYZ-9876", verificationUri: "https://github.com/login/device", expiresIn: 900, intervalSeconds: 5 })) {
    let polled = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/auth/github/start")) return start();
      if (url.endsWith("/auth/github/poll")) { const next = answers[Math.min(polled, answers.length - 1)]; polled += 1; return typeof next === "function" ? next() : next.clone(); }
      return json({ tailscale: { available: false, linked: false }, github: { configured: true }, passkey: { registered: false } });
    }));
    return () => polled;
  }

  it("keeps asking at GitHub's interval while it is pending, then signs in", async () => {
    const polled = serveFlow([json({ status: "pending" }), json({ status: "pending" }), json({ status: "complete", session })]);
    const onAuthenticated = vi.fn();
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={onAuthenticated} />);
    const start = await screen.findByRole("button", { name: "Sign in with GitHub" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(start); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Waiting for you to authorize on GitHub…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://github.com/login/device" })).toBeTruthy();
    // One poll each interval GitHub gave (five seconds), never sooner.
    for (const [after, count] of [[4_999, 0], [1, 1], [4_998, 1], [2, 2], [5_000, 3]] as const) {
      await act(async () => { await vi.advanceTimersByTimeAsync(after); });
      expect(polled()).toBe(count);
    }
    expect(onAuthenticated).toHaveBeenCalledWith(session);
  });

  for (const [answer, words] of [
    [{ status: "expired" }, "The GitHub code expired; try again."],
    [{ status: "denied" }, "GitHub authorization was denied."],
    [{ status: "failed", error: "That GitHub account is not linked to a BoxPilot user" }, "That GitHub account is not linked to a BoxPilot user"],
  ] as const) {
    it(`says so and offers GitHub again when the code is ${answer.status}`, async () => {
      serveFlow([json(answer)]);
      render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
      const start = await screen.findByRole("button", { name: "Sign in with GitHub" });
      vi.useFakeTimers();
      await act(async () => { fireEvent.click(start); await vi.advanceTimersByTimeAsync(5_000); });
      expect(screen.getByRole("alert").textContent).toBe(words);
      expect(screen.queryByText("WXYZ-9876")).toBeNull();
      expect((screen.getByRole("button", { name: "Sign in with GitHub" }) as HTMLButtonElement).disabled).toBe(false);
    });
  }

  it("says why when GitHub sign-in cannot start", async () => {
    serveFlow([], () => json({ error: "Too many GitHub sign-ins are waiting; try again in a minute" }, 429));
    render(<AuthScreen bootstrapRequired={false} onAuthenticated={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many GitHub sign-ins are waiting; try again in a minute");
    expect((screen.getByRole("button", { name: "Sign in with GitHub" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

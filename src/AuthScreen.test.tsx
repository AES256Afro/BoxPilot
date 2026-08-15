import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthScreen from "./AuthScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    expect(screen.getByRole("heading", { name: "Sign in to Bigbox" })).toBeTruthy();
    expect(screen.queryByLabelText("Bootstrap token")).toBeNull();
  });
});

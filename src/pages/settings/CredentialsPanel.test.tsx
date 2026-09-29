import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CredentialsPanel from "./CredentialsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Credentials panel", () => {
  it("lists names and dates only, and stages saving through the ordinary approval path", async () => {
    let staged: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/credentials.inspect/inspect") return json({ operation: "credentials.inspect", result: { credentials: [{ name: "ntfy-token", createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-26T09:30:00.000Z" }] } });
      if (url === "/api/v1/operations/credentials.set/jobs") { staged = JSON.parse(String(init?.body)); return json({ job: { id: "j1", state: "awaiting_approval", title: "Save a credential", risk: "medium", steps: [], approvals: [] }, approval: { tier: "medium", confirmText: null } }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CredentialsPanel csrfToken="csrf" />);
    expect(await screen.findByText("ntfy-token")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: "hook" } });
    fireEvent.change(screen.getByLabelText("Credential value"), { target: { value: "tk_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => { if (!staged) throw new Error("not yet"); });
    expect(staged).toEqual({ parameters: { name: "hook", value: "tk_secret" } });
    // The value input is a password field; nothing in the list view ever shows a value.
    expect((screen.getByLabelText("Credential value") as HTMLInputElement).type).toBe("password");
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PeopleSettings from "./PeopleSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("people settings", () => {
  it("lists accounts and adds an operator with the owner's password", async () => {
    let posted: string | undefined;
    const people = [{ id: "o1", username: "admin", role: "owner", createdAt: "2026-08-01T00:00:00Z" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/people") && init?.method === "POST") { posted = init.body as string; people.push({ id: "o2", username: "sam", role: "operator", createdAt: "2026-08-21T00:00:00Z" }); return json({ account: people[1] }, 201); }
      if (url.endsWith("/api/v1/people")) return json({ people, roles: ["owner", "operator", "viewer"] });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PeopleSettings csrfToken="csrf" />);
    expect(await screen.findByText("admin")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New user name"), { target: { value: "sam" } });
    fireEvent.change(screen.getByLabelText("New account password"), { target: { value: "sams long password" } });
    fireEvent.change(screen.getByLabelText("Your owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(await screen.findByText("sam")).toBeTruthy();
    expect(JSON.parse(posted ?? "{}")).toEqual({ username: "sam", newPassword: "sams long password", role: "operator", password: "correct horse battery" });
  });

  it("asks for the owner password in a masked field, never a native prompt", async () => {
    // window.prompt showed the owner password in clear text and froze every script on the page
    // while open — including the harness that reviews these pages, which is how it was found.
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ method: options?.method ?? "GET", url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
      if (!options?.method || options.method === "GET") return { ok: true, json: async () => ({ people: [{ id: "p2", username: "sam", role: "viewer", createdAt: "2026-08-01T00:00:00Z" }] }) };
      return { ok: true, json: async () => ({}) };
    }));
    const promptSpy = vi.fn();
    vi.stubGlobal("prompt", promptSpy);
    render(<PeopleSettings csrfToken="csrf" />);
    await screen.findByText("sam");

    fireEvent.click(screen.getByText("Disable"));
    expect(promptSpy).not.toHaveBeenCalled();
    // the confirmation names the person and takes the password masked
    expect(screen.getByText(/They keep their history/)).toBeTruthy();
    const field = screen.getByLabelText("Your password, to confirm this change") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "owner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable sam" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && (call.body as { password?: string })?.password === "owner-secret")).toBe(true));
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PasswordSettings from "./PasswordSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("password settings", () => {
  it("posts the current and new password and clears the form on success", async () => {
    let posted: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { posted = init?.body as string; return new Response(JSON.stringify({ changed: true }), { status: 200, headers: { "Content-Type": "application/json" } }); }));
    render(<PasswordSettings csrfToken="csrf" />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old password here" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new password here!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Password changed/)).toBeTruthy();
    expect(JSON.parse(posted ?? "{}")).toEqual({ currentPassword: "old password here", newPassword: "new password here!" });
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });

  it("shows the server's error when the current password is wrong", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Current password is wrong" }), { status: 401, headers: { "Content-Type": "application/json" } })));
    render(<PasswordSettings csrfToken="csrf" />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "wrong password!!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new password here!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Current password is wrong")).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApprovalsPanel from "./ApprovalsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function serve(put: (body: { approvalMode: string; password: string }) => Response) {
  const sent: Array<{ body: { approvalMode: string; password: string }; csrf: string | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      sent.push({ body, csrf: (init.headers as Record<string, string>)["X-BoxPilot-CSRF"] });
      return put(body);
    }
    return json({ approvalMode: "tiered", modes: ["tiered", "always-password"], elevationTtlMs: 15 * 60_000 });
  }));
  return sent;
}

describe("Approvals panel", () => {
  it("shows the current mode and the elevated window, and asks for nothing until the choice changes", async () => {
    serve(() => json({}));
    render(<ApprovalsPanel csrfToken="csrf" />);
    expect(await screen.findByText("A password unlocks high-risk approvals for 15 minutes.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Tiered/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText("Owner password")).toBeNull();
  });

  it("changes the mode only with the owner's password, sent with the CSRF token, then clears it", async () => {
    const onChange = vi.fn();
    const sent = serve((body) => json({ approvalMode: body.approvalMode, modes: [] }));
    render(<ApprovalsPanel csrfToken="csrf" onChange={onChange} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Always ask/ }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "too short" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "owner password 1" } });
    fireEvent.click(save);
    expect(await screen.findByText("Every approval will ask for your password.")).toBeTruthy();
    expect(sent).toEqual([{ body: { approvalMode: "always-password", password: "owner password 1" }, csrf: "csrf" }]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Owner password")).toBeNull();
    // Choosing again starts from an empty field: the password is not kept in the page.
    fireEvent.click(screen.getByRole("radio", { name: /Tiered/ }));
    expect((screen.getByLabelText("Owner password") as HTMLInputElement).value).toBe("");
  });

  it("keeps the old mode and says why when the password is refused, and Cancel puts the choice back", async () => {
    const onChange = vi.fn();
    serve(() => json({ error: "Owner password required to change the approval mode" }, 401));
    render(<ApprovalsPanel csrfToken="csrf" onChange={onChange} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Always ask/ }));
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "wrong password 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Owner password required to change the approval mode")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect((screen.getByRole("radio", { name: /Tiered/ }) as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByLabelText("Owner password")).toBeNull();
  });

  it("says so when the mode cannot be read, and offers no choice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ approvalMode: "none" })));
    render(<ApprovalsPanel csrfToken="csrf" />);
    expect(await screen.findByText("Could not read the approval mode")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Tiered/ }).matches(":disabled")).toBe(true);
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fail2banPanel from "./Fail2banPanel";
import type { PendingOperation } from "./ApproveDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
function setup(result: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().endsWith("/operations/fail2ban.inspect/inspect") ? json({ operation: "fail2ban.inspect", result }) : json({ error: "unexpected" }))));
  const start = vi.fn<(operation: PendingOperation) => void>();
  render(<Fail2banPanel start={start} refreshKey={0} />);
  return start;
}

describe("fail2ban panel", () => {
  it("offers to install when missing", async () => {
    const start = setup({ installed: false, running: null, configured: false, config: { managed: false, maxRetry: null, findTimeMinutes: null, banTimeMinutes: null, ignoreLan: true, ignore: [], sshd: false }, currentlyBanned: null, totalBanned: null });
    fireEvent.click(await screen.findByRole("button", { name: "Install fail2ban" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "apt.install", parameters: { packages: ["fail2ban"] } }));
  });

  it("shows the live thresholds and bans, applies changes, and turns off", async () => {
    const start = setup({ installed: true, running: true, configured: true, config: { managed: true, maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 120, ignoreLan: true, ignore: ["127.0.0.1/8", "::1", "100.64.0.0/10", "192.168.1.0/24"], sshd: true }, currentlyBanned: 2, totalBanned: 9 });
    expect(await screen.findByText("On · 2 banned now")).toBeTruthy();
    expect((screen.getByLabelText("Max retries") as HTMLInputElement).value).toBe("3");
    fireEvent.change(screen.getByLabelText("Ban time"), { target: { value: "240" } });
    fireEvent.click(screen.getByLabelText(/never ban my LAN/));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "fail2ban.apply", parameters: { enabled: true, maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 240, ignoreLan: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off protection" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "fail2ban.apply", parameters: { enabled: false } }));
  });
});

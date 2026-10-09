import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HeartbeatPanel, { addressProblem, onThisServer } from "./HeartbeatPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = () => Date.parse("2026-09-30T10:00:00.000Z");
const url = "https://hc-ping.com/5a3f1c2e-0000-4000-8000-00000000abcd";
const intervals = [1, 2, 5, 10, 15, 30, 60];
const off = { configured: false, host: null, installed: true, enabled: false, intervalMinutes: null, last: null, intervals };
const on = { configured: true, host: "hc-ping.com", installed: true, enabled: true, intervalMinutes: 5, last: { at: "2026-09-30T09:58:00.000Z", ok: true, status: 200, ms: 140, error: null }, intervals };
const topology = { addresses: [{ address: "192.168.50.20" }, { address: "100.101.102.103" }], tailscale: { dnsName: "homebox.tail0a1b.ts.net" } };

function serve(state: unknown) {
  const staged: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input.toString();
    if (target === "/api/v1/operations/heartbeat.inspect/inspect") return json({ operation: "heartbeat.inspect", result: state });
    if (target === "/api/v1/network/topology") return json(topology);
    const match = target.match(/\/operations\/([a-z0-9.-]+)\/jobs$/);
    if (match) {
      staged[match[1]] = JSON.parse(String(init?.body));
      const risk = match[1] === "heartbeat.test" ? "low" : "medium";
      return json({ job: { id: "j1", type: `op:${match[1]}`, state: "awaiting_approval", title: match[1], risk, steps: [], approvals: [] }, approval: { tier: risk, confirmText: null } }, 201);
    }
    return json({ error: `unexpected ${target}` }, 500);
  }));
  render(<HeartbeatPanel csrfToken="csrf" now={now} />);
  return staged;
}

describe("the heartbeat", () => {
  it("is off until turned on, and says what it is for", async () => {
    serve(off);
    expect(await screen.findByText(/nothing on it can tell you/)).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Turn on" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Turned off without forgetting the address, it said "Leave empty to keep the saved one" and then
  // would not turn on until the address was pasted again.
  it("turns back on with the saved address when it was turned off and kept", async () => {
    const staged = serve({ ...off, configured: true, host: "hc-ping.com" });
    expect(await screen.findByText(/Leave empty to keep the saved one \(hc-ping\.com\)/)).toBeTruthy();
    const turnOn = screen.getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(false);
    fireEvent.click(turnOn);
    await waitFor(() => expect(staged["heartbeat.set"]).toEqual({ parameters: { enabled: true, intervalMinutes: 5 } }));
  });

  it("stages turning it on with the address as the secret it is, and the interval", async () => {
    const staged = serve(off);
    fireEvent.change(await screen.findByLabelText("Ping address"), { target: { value: url } });
    expect((screen.getByLabelText("Ping address") as HTMLInputElement).type).toBe("password");
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(staged["heartbeat.set"]).toEqual({ parameters: { enabled: true, intervalMinutes: 10, url } }));
  });

  it("keeps the address and the interval typed when turning it on fails, and when the page reads again", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const target = input.toString();
      if (target === "/api/v1/operations/heartbeat.inspect/inspect") { reads += 1; return json({ operation: "heartbeat.inspect", result: off }); }
      if (target === "/api/v1/network/topology") return json(topology);
      if (target.endsWith("/operations/heartbeat.set/jobs")) return json({ job: { id: "j1", type: "op:heartbeat.set", state: "awaiting_approval", title: "Turn the heartbeat on", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
      if (target.endsWith("/jobs/j1/approve")) return json({ job: { id: "j1", state: "applying" }, elevatedUntil: null }, 202);
      if (target.endsWith("/jobs/j1")) return json({ job: { id: "j1", type: "op:heartbeat.set", title: "Turn the heartbeat on", state: "failed", risk: "medium", error: "curl: (6) Could not resolve host", result: null, steps: [], approvals: [] } });
      return json({ error: `unexpected ${target}` }, 500);
    }));
    render(<HeartbeatPanel csrfToken="csrf" now={now} />);
    fireEvent.change(await screen.findByLabelText("Ping address"), { target: { value: url } });
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    await waitFor(() => expect(reads).toBeGreaterThan(1), { timeout: 4000 });
    expect((screen.getByLabelText("Ping address") as HTMLInputElement).value).toBe(url);
    expect((screen.getByLabelText("How often") as HTMLSelectElement).value).toBe("10");
  });

  it("refuses an address it cannot use, and warns about one on this very server", async () => {
    serve(off);
    const field = await screen.findByLabelText("Ping address");
    fireEvent.change(field, { target: { value: "ftp://example.com/x" } });
    expect(await screen.findByText("It must start with https:// or http://")).toBeTruthy();
    fireEvent.change(field, { target: { value: "http://192.168.50.20:3001/api/push/Ab12Cd34" } });
    expect(await screen.findByText("That address is this server")).toBeTruthy();
  });

  it("shows where it pings, how often and how the last one went, never the address", async () => {
    const staged = serve(on);
    expect(await screen.findByText("hc-ping.com")).toBeTruthy();
    expect(screen.getByText("5 minutes")).toBeTruthy();
    expect(screen.getByText("taken 2 minutes ago")).toBeTruthy();
    expect(document.body.textContent).not.toContain("5a3f1c2e");
    fireEvent.click(screen.getByRole("button", { name: "Send a test ping" }));
    await waitFor(() => expect(staged["heartbeat.test"]).toEqual({ parameters: {} }));
  });

  it("keeps the saved address when changed without a new one, and can forget it when turned off", async () => {
    const staged = serve(on);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(staged["heartbeat.set"]).toEqual({ parameters: { enabled: true, intervalMinutes: 15 } }));
  });

  it("stages turning it off, forgetting the address when asked", async () => {
    const staged = serve(on);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByLabelText("Also forget the saved address"));
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(staged["heartbeat.set"]).toEqual({ parameters: { enabled: false, forget: true } }));
  });

  it("checks an address the way the server does", () => {
    expect(addressProblem(url)).toBeUndefined();
    expect(addressProblem("https://user:pw@example.com/")).toMatch(/user name or password/);
    expect(onThisServer("http://localhost:3001/api/push/x", [])).toBe(true);
    expect(onThisServer("http://homebox:3001/api/push/x", ["homebox"])).toBe(true);
    expect(onThisServer(url, ["192.168.50.20"])).toBe(false);
  });
});

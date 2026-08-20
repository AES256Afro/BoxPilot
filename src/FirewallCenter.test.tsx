import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FirewallCenter from "./FirewallCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const report = {
  installed: true,
  enabled: false,
  defaults: { incoming: "drop", outgoing: "accept", routed: "reject" },
  rules: [
    { action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: "BoxPilot keeps SSH reachable", family: "v4" },
    { action: "allow", protocol: "tcp", port: 8096, app: null, direction: "in", interface: null, comment: "Jellyfin", family: "both" },
  ],
};

describe("Firewall center", () => {
  it("shows state and stages enabling as a high-risk change with the lockout guard in the preview", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/firewall.inspect/inspect")) return json({ operation: "firewall.inspect", result: report });
      if (url.endsWith("/operations/firewall.set/jobs")) { staged = init?.body as string; return json({ job: { id: "job-f", type: "op:firewall.set", title: "Turn the firewall on or off", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FirewallCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Disabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByText(/keeping SSH \(22\/tcp\) and the/)).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { enabled: true } });
  });

  it("lists rules, hides Delete for the SSH rule, and stages a deletion", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/firewall.inspect/inspect")) return json({ operation: "firewall.inspect", result: report });
      if (url.endsWith("/operations/firewall.rule.delete/jobs")) { staged = init?.body as string; return json({ job: { id: "job-d", type: "op:firewall.rule.delete", title: "Delete a firewall rule", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FirewallCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Jellyfin")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    const sshRow = rows.find((row) => row.textContent?.includes("22"));
    expect(sshRow?.textContent).not.toContain("Delete");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { action: "allow", port: 8096, protocol: "tcp" } });
  });

  it("offers to install ufw when it is missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/firewall.inspect/inspect")) return json({ operation: "firewall.inspect", result: { installed: false, enabled: null, defaults: null, rules: [] } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FirewallCenter csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Install ufw" })).toBeTruthy();
  });
});

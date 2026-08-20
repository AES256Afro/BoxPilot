import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UpdatesCenter from "./UpdatesCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Updates center", () => {
  it("lists upgradable packages and upgrades selected ones through the approval dialog", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let jobPolls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) {
        return json({ operation: "apt.upgradable.inspect", result: { count: 2, securityCount: 1, rebootRequired: true, upgradable: [
          { name: "htop", suite: "noble", candidate: "3.3.0-4", installed: "3.2.2-2", architecture: "amd64" },
          { name: "libssl3t64", suite: "noble-security", candidate: "3.0.13-0ubuntu3.5", installed: "3.0.13-0ubuntu3.4", architecture: "amd64" },
        ] } });
      }
      if (url.endsWith("/operations/apt.upgrade/jobs")) {
        return json({ job: { id: "job-1", type: "op:apt.upgrade", title: "Install package updates", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
      }
      if (url.endsWith("/jobs/job-1/approve")) return json({ job: { id: "job-1", state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/jobs/job-1")) {
        jobPolls += 1;
        return json({ job: { id: "job-1", type: "op:apt.upgrade", title: "Install package updates", state: jobPolls > 1 ? "completed" : "applying", risk: "medium", error: null, result: { upgraded: true }, steps: [{ name: "verify", state: "completed", detail: "Install package updates completed", createdAt: "2026-08-19T12:00:00.000Z" }], approvals: [] } });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UpdatesCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("htop")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("noble-security")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select htop"));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade selected (1)" }));

    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.queryByLabelText("Approval password")).toBeNull();
    const confirm = await screen.findByRole("button", { name: "Confirm and run" });
    fireEvent.click(confirm);
    expect(await screen.findByText(/Completed\./, {}, { timeout: 6000 })).toBeTruthy();

    const staged = calls.find((call) => call.url.endsWith("/operations/apt.upgrade/jobs"));
    expect(staged?.init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf-token" });
    expect(staged?.init?.body).toBe(JSON.stringify({ parameters: { packages: ["htop"] } }));
    const approved = calls.find((call) => call.url.endsWith("/jobs/job-1/approve"));
    expect(approved?.init?.body).toBe("{}");
  }, 10000);

  it("asks for the password when the policy requires it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/inspect")) return json({ operation: "apt.upgradable.inspect", result: { count: 0, securityCount: 0, rebootRequired: false, upgradable: [] } });
      if (url.endsWith("/operations/apt.remove/jobs")) return json({ job: { id: "job-2", type: "op:apt.remove", title: "Remove packages", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: true, elevated: false, mode: "always-password", reason: "always-password mode" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UpdatesCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("Everything is up to date.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Package names"), { target: { value: "htop" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const input = await screen.findByLabelText("Approval password");
    const button = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "correct horse battery" } });
    expect(button.disabled).toBe(false);
  });

  it("shows the automatic-updates toggle and stages curated tool installs", async () => {
    let stagedUnattended: string | undefined;
    let stagedInstall: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ operation: "apt.upgradable.inspect", result: { count: 0, securityCount: 0, rebootRequired: false, upgradable: [] } });
      if (url.endsWith("/operations/apt.unattended.inspect/inspect")) return json({ operation: "apt.unattended.inspect", result: { installed: false, enabled: false } });
      if (url.endsWith("/operations/packages.curated.inspect/inspect")) return json({ operation: "packages.curated.inspect", result: { packages: [
        { name: "htop", installed: true, version: "3.3.0-4" },
        { name: "restic", installed: false, version: null },
      ] } });
      if (url.endsWith("/operations/apt.unattended.set/jobs")) { stagedUnattended = init?.body as string; return json({ job: { id: "job-u", type: "op:apt.unattended.set", title: "Change automatic security updates", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      if (url.endsWith("/operations/apt.install/jobs")) { stagedInstall = init?.body as string; return json({ job: { id: "job-i", type: "op:apt.install", title: "Install packages", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UpdatesCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Security upgrades wait for you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(stagedUnattended ?? "{}")).toEqual({ parameters: { enabled: true } });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.getByText("backup engine")).toBeTruthy();
    const curatedInstall = screen.getAllByRole("button", { name: "Install" }).find((button) => !(button as HTMLButtonElement).disabled);
    fireEvent.click(curatedInstall as HTMLElement);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(stagedInstall ?? "{}")).toEqual({ parameters: { packages: ["restic"] } });
  });
});

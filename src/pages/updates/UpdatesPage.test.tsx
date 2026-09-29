import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UpdatesPage from "./UpdatesPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const staged = (id: string, type: string) => json({ job: { id, type: `op:${type}`, title: type, state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);

const twoUpdates = { count: 2, securityCount: 1, rebootRequired: true, upgradable: [
  { name: "htop", suite: "noble", candidate: "3.3.0-4", installed: "3.2.2-2", architecture: "amd64" },
  { name: "libssl3t64", suite: "noble-security", candidate: "3.0.13-0ubuntu3.5", installed: "3.0.13-0ubuntu3.4", architecture: "amd64" },
] };

describe("Updates page", () => {
  it("says what waits first: the verdict, the counts and the strip, with the explanation behind the toggle", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ result: twoUpdates });
      if (url.endsWith("/operations/apt.unattended.inspect/inspect")) return json({ result: { installed: true, enabled: false } });
      return json({ error: "no" }, 500);
    }));
    render(<UpdatesPage csrfToken="csrf-token" />);
    expect(await screen.findByText("htop")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Updates" })).toBeTruthy();
    expect(screen.getByText("1 security update").closest(".ui-chip")?.getAttribute("data-status")).toBe("warning");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("2 upgradable · 1 security · reboot required · automatic updates off");
    expect(screen.getByText("Required")).toBeTruthy();
    const about = screen.getByRole("button", { name: "About Updates" });
    expect(about.getAttribute("aria-expanded")).toBe("false");
    // The security update carries its mark and its word.
    const row = screen.getByText("libssl3t64").closest("tr")!;
    expect(row.getAttribute("data-status")).toBe("warning");
    expect(within(row).getByText("security")).toBeTruthy();
  });

  it("routes the systemd manager to its own approval action and preserves normal service restarts", async () => {
    const calls: Array<{ url: string; body?: BodyInit | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, body: init?.body });
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ result: { count: 0, upgradable: [], servicesNeedingRestart: ["systemd-manager", "cron.service", "systemd-user"] } });
      if (url.endsWith("/operations/packages.curated.inspect/inspect")) return json({ result: { packages: [] } });
      if (url.endsWith("/operations/apt.unattended.inspect/inspect")) return json({ result: { installed: false, enabled: false } });
      if (url.endsWith("/jobs")) return json({ job: { id: "job-manager", state: "awaiting_approval", risk: "medium", steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false } }, 201);
      return json({ error: "unexpected request" }, 500);
    }));
    render(<UpdatesPage csrfToken="csrf-token" />);
    const refresh = await screen.findByRole("button", { name: "Refresh systemd manager" });
    expect(refresh.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(refresh);
    expect(await screen.findByText("systemctl daemon-reexec")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Confirm and run" })).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/operations/system.manager.reexec/jobs"))?.body).toBe(JSON.stringify({ parameters: {} }));
    expect(screen.queryByRole("button", { name: "Restart systemd-manager" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restart cron.service" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart systemd-user" })).toBeNull();
    expect(screen.getByText("Reboot the server to refresh this process.")).toBeTruthy();
  });

  it("lists upgradable packages and upgrades selected ones through the approval dialog", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let jobPolls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ operation: "apt.upgradable.inspect", result: twoUpdates });
      if (url.endsWith("/operations/apt.upgrade/jobs")) return json({ job: { id: "job-1", type: "op:apt.upgrade", title: "Install package updates", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
      if (url.endsWith("/jobs/job-1/approve")) return json({ job: { id: "job-1", state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/jobs/job-1")) {
        jobPolls += 1;
        return json({ job: { id: "job-1", type: "op:apt.upgrade", title: "Install package updates", state: jobPolls > 1 ? "completed" : "applying", risk: "medium", error: null, result: { upgraded: true }, steps: [{ name: "verify", state: "completed", detail: "Install package updates completed", createdAt: "2026-08-19T12:00:00.000Z" }], approvals: [] } });
      }
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<UpdatesPage csrfToken="csrf-token" />);

    expect(await screen.findByText("htop")).toBeTruthy();
    expect(screen.getByText("noble-security")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select all packages"));
    expect(screen.getByRole("button", { name: "Upgrade selected (2)" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select all packages"));
    expect(screen.getByRole("button", { name: "Upgrade selected (0)" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select htop"));
    const upgrade = screen.getByRole("button", { name: "Upgrade selected (1)" });
    expect(upgrade.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(upgrade);

    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.queryByLabelText("Approval password")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText(/Completed\./, {}, { timeout: 6000 })).toBeTruthy();

    const stagedCall = calls.find((call) => call.url.endsWith("/operations/apt.upgrade/jobs"));
    expect(stagedCall?.init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf-token" });
    expect(stagedCall?.init?.body).toBe(JSON.stringify({ parameters: { packages: ["htop"] } }));
    expect(calls.find((call) => call.url.endsWith("/jobs/job-1/approve"))?.init?.body).toBe("{}");
  }, 10000);

  it("installs any package by name from its own tab, and asks for the password when the policy requires it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/inspect")) return json({ operation: "apt.upgradable.inspect", result: { count: 0, securityCount: 0, rebootRequired: false, upgradable: [] } });
      if (url.endsWith("/operations/apt.remove/jobs")) return json({ job: { id: "job-2", type: "op:apt.remove", title: "Remove packages", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: true, elevated: false, mode: "always-password", reason: "always-password mode" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<UpdatesPage csrfToken="csrf-token" />);
    expect(await screen.findByText("Everything is up to date.")).toBeTruthy();
    expect(screen.getByText("Up to date").closest(".ui-chip")?.getAttribute("data-status")).toBe("good");
    fireEvent.click(screen.getByRole("tab", { name: "Install" }));
    expect(window.location.search).toBe("?tab=install");
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ operation: "apt.upgradable.inspect", result: { count: 0, securityCount: 0, rebootRequired: false, upgradable: [] } });
      if (url.endsWith("/operations/apt.unattended.inspect/inspect")) return json({ operation: "apt.unattended.inspect", result: { installed: false, enabled: false } });
      if (url.endsWith("/operations/packages.curated.inspect/inspect")) return json({ operation: "packages.curated.inspect", result: { packages: [
        { name: "htop", installed: true, version: "3.3.0-4" },
        { name: "restic", installed: false, version: null },
      ] } });
      if (url.endsWith("/operations/apt.unattended.set/jobs")) { stagedUnattended = init?.body as string; return staged("job-u", "apt.unattended.set"); }
      if (url.endsWith("/operations/apt.install/jobs")) { stagedInstall = init?.body as string; return staged("job-i", "apt.install"); }
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<UpdatesPage csrfToken="csrf-token" />);

    expect(await screen.findByText("Security upgrades wait for you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on automatic updates" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(stagedUnattended ?? "{}")).toEqual({ parameters: { enabled: true } });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    fireEvent.click(screen.getByRole("tab", { name: /Common tools/ }));
    expect(screen.getByText("backup engine")).toBeTruthy();
    expect(screen.getByText("installed 3.3.0-4")).toBeTruthy();
    // Each tool's button names its package, so a screen reader's list of buttons is not twenty "Install"s.
    expect(screen.getByRole("button", { name: "Remove htop" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install restic" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(stagedInstall ?? "{}")).toEqual({ parameters: { packages: ["restic"] } });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("tab", { name: "Install" }));
    expect(screen.getByRole("button", { name: "Remove unused packages" }).getAttribute("data-risk")).toBe("medium");
  });

  it("gives a viewer what waits and no buttons that would run anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ result: twoUpdates });
      if (url.endsWith("/operations/apt.unattended.inspect/inspect")) return json({ result: { installed: true, enabled: true } });
      return json({ error: "no" }, 500);
    }));
    render(<UpdatesPage csrfToken="csrf-token" role="viewer" />);
    expect(await screen.findByText("htop")).toBeTruthy();
    expect(document.querySelectorAll("button[data-risk]").length).toBe(0);
    expect(screen.queryByLabelText("Select htop")).toBeNull();
  });

  it("says when updates could not be read, and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<UpdatesPage csrfToken="csrf-token" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The helper is not answering")).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    expect(verdict?.textContent).toContain("Not read");
    expect(verdict?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

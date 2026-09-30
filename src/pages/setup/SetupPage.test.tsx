import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellHostProvider } from "../../shell/TopBarSlot";
import { Autoinstall } from "./Autoinstall";
import SetupPage from "./SetupPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const setupState = {
  firstRun: true, installedApps: 0,
  profiles: [{
    id: "home-server", name: "Home server", icon: "🏠", description: "Media and monitoring.", remaining: 2, blocked: 0,
    steps: [
      { id: "prerequisite-docker", kind: "prerequisite", title: "Install Docker Engine", status: "done", detail: "installed 28.0.0-1", job: null },
      { id: "app-jellyfin", kind: "app", title: "Install Jellyfin", status: "ready", detail: "with default settings", job: { operationId: "app.install", parameters: { id: "jellyfin", values: {} } } },
      { id: "schedule-database-backup", kind: "schedule", title: "Back up the database nightly", status: "ready", detail: "daily", job: null, schedule: { operationId: "controller.backup.create", parameters: {}, frequency: "daily", minute: 15, hour: 3, weekday: null } },
    ],
  }, {
    id: "dns-appliance", name: "DNS appliance", icon: "🛡️", description: "AdGuard Home for the whole network.", remaining: 0, blocked: 0, steps: [],
  }],
};

describe("Setup", () => {
  it("greets the server by name and offers each profile with what is already in place", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(setupState)));
    render(<ShellHostProvider value="homebox"><SetupPage csrfToken="csrf" onDone={vi.fn()} /></ShellHostProvider>);
    expect(await screen.findByRole("heading", { level: 2, name: "What should homebox become?" })).toBeTruthy();
    expect(screen.getByText("Nothing set up yet").closest(".ui-chip")?.getAttribute("data-status")).toBe("neutral");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("2 profiles · 1 already in place · 0 apps installed");
    const home = screen.getByRole("button", { name: /Home server/ });
    expect(within(home).getByText("2 steps to run")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /DNS appliance/ })).getByText("Everything is in place")).toBeTruthy();
  });

  it("shows a profile's steps with their tiers and runs the rest through jobs and schedules", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${init.body}` : ""}`);
      if (url.endsWith("/api/v1/setup")) return json(setupState);
      if (url.endsWith("/operations/app.install/jobs")) return json({ job: { id: "job-1" }, approval: { tier: "medium", passwordRequired: false } }, 201);
      if (url.endsWith("/jobs/job-1/approve")) return json({ job: { id: "job-1", state: "applying" } }, 202);
      if (url.endsWith("/jobs/job-1")) return json({ job: { id: "job-1", state: "completed", error: null } });
      if (url.endsWith("/api/v1/schedules")) return json({ schedule: { id: "s1" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    }));
    const onDone = vi.fn();
    render(<SetupPage csrfToken="csrf" onDone={onDone} />);
    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    expect(screen.getByText("installed 28.0.0-1")).toBeTruthy();
    const jellyfin = screen.getByText("Install Jellyfin").closest("li") as HTMLElement;
    expect(jellyfin.querySelector(".ui-tag--tier")?.textContent).toBe("Med risk");
    const nightly = screen.getByText("Back up the database nightly").closest("li") as HTMLElement;
    expect(within(nightly).getByText("schedule")).toBeTruthy();
    const install = screen.getByRole("button", { name: /Install everything \(2\)/ });
    expect(install.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(install);
    expect(await screen.findByText("All done")).toBeTruthy();
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
      'POST /api/v1/operations/app.install/jobs {"parameters":{"id":"jellyfin","values":{}}}',
      "POST /api/v1/jobs/job-1/approve {}",
      'POST /api/v1/schedules {"operationId":"controller.backup.create","parameters":{},"frequency":"daily","minute":15,"hour":3,"weekday":null}',
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Go to Home" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("asks for the owner password once when approval demands it, then continues", async () => {
    let approvals = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/setup")) return json(setupState);
      if (url.endsWith("/operations/app.install/jobs")) return json({ job: { id: "job-1" } }, 201);
      if (url.endsWith("/jobs/job-1/approve")) { approvals += 1; const body = JSON.parse(String(init?.body)); return body.password ? json({ job: { id: "job-1" } }, 202) : json({ error: "Enter the owner password to run this" }, 401); }
      if (url.endsWith("/jobs/job-1")) return json({ job: { id: "job-1", state: "completed", error: null } });
      if (url.endsWith("/api/v1/schedules")) return json({ schedule: { id: "s1" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<SetupPage csrfToken="csrf" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    fireEvent.click(screen.getByRole("button", { name: /Install everything \(2\)/ }));
    const passwordInput = await screen.findByLabelText(/Owner password/);
    expect(passwordInput.getAttribute("type")).toBe("password");
    fireEvent.change(passwordInput, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("All done")).toBeTruthy();
    expect(approvals).toBe(2);
  });

  it("says when a step fails, and offers to retry or skip it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/setup")) return json(setupState);
      if (url.endsWith("/operations/app.install/jobs")) return json({ error: "The catalog is not reachable" }, 503);
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<SetupPage csrfToken="csrf" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    fireEvent.click(screen.getByRole("button", { name: /Install everything/ }));
    expect(await screen.findByText("A step failed")).toBeTruthy();
    expect(screen.getByText("The catalog is not reachable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip and continue" })).toBeTruthy();
  });

  it("tags an app step, and the batch, with the tier its manifest raises it to", async () => {
    const dns = { ...setupState, profiles: [{ ...setupState.profiles[0], steps: [
      { id: "app-adguard-home", kind: "app", title: "Install AdGuard Home", status: "ready", detail: "with default settings", risk: "high", job: { operationId: "app.install", parameters: { id: "adguard-home", values: {} } } },
      setupState.profiles[0].steps[1],
    ] }, setupState.profiles[1]] };
    vi.stubGlobal("fetch", vi.fn(async () => json(dns)));
    render(<SetupPage csrfToken="csrf" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    expect((screen.getByText("Install AdGuard Home").closest("li") as HTMLElement).querySelector(".ui-tag--tier")?.textContent).toBe("High risk");
    expect((screen.getByText("Install Jellyfin").closest("li") as HTMLElement).querySelector(".ui-tag--tier")?.textContent).toBe("Med risk");
    expect(screen.getByRole("button", { name: /Install everything/ }).getAttribute("data-risk")).toBe("high");
  });

  it("lets a viewer read the profiles and run nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(setupState)));
    render(<SetupPage csrfToken="csrf" role="viewer" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    expect(screen.getByText("Install Jellyfin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install everything/ })).toBeNull();
  });

  it("keeps the new-server tab in the address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(setupState)));
    render(<SetupPage csrfToken="csrf" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Prepare a new server" }));
    expect(window.location.search).toBe("?mode=new");
    expect(screen.getByText("For another machine")).toBeTruthy();
  });
});

describe("preparing a new server", () => {
  it("suggests the release this build is, not one frozen in the source", () => {
    // The placeholder read v0.62.5 more than a hundred releases later. It is the one field where
    // copying the example verbatim installs something ancient on a server being built from scratch.
    render(<Autoinstall csrfToken="csrf-token" />);
    const field = screen.getByPlaceholderText(/^v\d+\.\d+\.\d+ \(current\)$/) as HTMLInputElement;
    expect(field.placeholder).toContain(__BOXPILOT_VERSION__);
    expect(field.value).toBe(`v${__BOXPILOT_VERSION__}`);
  });

  it("imports GitHub keys, posts the request without keeping the password, and shows the user-data", async () => {
    let posted: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/ssh-keys/github/octocat")) return json({ user: "octocat", keys: ["ssh-ed25519 AAAAC3 octocat"] });
      if (url.endsWith("/api/v1/setup/autoinstall")) { posted = init?.body as string; return json({ userData: "#cloud-config\nautoinstall:\n  version: 1\n", metaData: "instance-id: boxpilot-garage-box\n", ref: "v0.62.5", filename: "garage-box-autoinstall" }); }
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<Autoinstall csrfToken="csrf" />);
    fireEvent.change(screen.getByLabelText(/^Hostname/), { target: { value: "garage-box" } });
    fireEvent.change(screen.getByLabelText(/^User name/), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("GitHub user for keys"), { target: { value: "octocat" } });
    fireEvent.click(screen.getByRole("button", { name: "Import keys from GitHub" }));
    expect(((await screen.findByDisplayValue("ssh-ed25519 AAAAC3 octocat")) as HTMLTextAreaElement).tagName).toBe("TEXTAREA");
    fireEvent.submit(screen.getByRole("button", { name: "Generate autoinstall files" }).closest("form") as HTMLFormElement);
    expect(await screen.findByLabelText("Generated user-data")).toBeTruthy();
    expect(JSON.parse(posted ?? "{}")).toMatchObject({ hostname: "garage-box", username: "owner", password: "correct horse battery", sshKeys: ["ssh-ed25519 AAAAC3 octocat"], network: { mode: "dhcp" }, disk: { layout: "lvm" } });
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).value).toBe("");
  });
});

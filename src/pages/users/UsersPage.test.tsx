import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsersPage from "./UsersPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const job = (id: string, risk: string) => ({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });

const report = {
  users: [
    { name: "root", uid: 0, shell: "/bin/bash", sudo: true, keyCount: 0 },
    { name: "alex", uid: 1000, shell: "/bin/bash", sudo: true, keyCount: 2 },
    { name: "pat", uid: 1001, shell: "/bin/bash", sudo: false, keyCount: 0 },
  ],
  sshd: { passwordAuthentication: true, keyboardInteractive: false, pubkeyAuthentication: true, permitRootLogin: "prohibit-password", port: 22 },
  sshActive: true,
};

/** The users read, and every staged operation recorded by its id. */
function mockFetch(result: unknown, staged: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith("/operations/users.inspect/inspect")) return json({ operation: "users.inspect", result });
    const match = url.match(/\/operations\/([a-z.-]+)\/jobs$/);
    if (match) { staged[match[1]] = JSON.parse(String(init?.body)); return json(job(match[1], match[1] === "users.add" ? "medium" : "high"), 201); }
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Users & SSH page", () => {
  it("says first whether SSH takes passwords, then lists the accounts with their tiers", async () => {
    mockFetch(report);
    render(<UsersPage csrfToken="csrf" />);
    expect(await screen.findByText("Password login on")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Users & SSH" })).toBeTruthy();
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("3 accounts · 2 with sudo · 2 keys · port 22 · root login prohibit-password");
    const table = screen.getByRole("table", { name: "Accounts that can sign in" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("code")?.textContent)).toEqual(["root", "alex", "pat"]);
    // root keeps its sudo: there is no button to take it away.
    expect(within(rows[0]).queryByRole("button", { name: /sudo/ })).toBeNull();
    expect(within(rows[2]).getByRole("button", { name: "Grant sudo to pat" }).getAttribute("data-risk")).toBe("high");
    expect(screen.getByRole("button", { name: "Turn off password login" }).getAttribute("data-risk")).toBe("high");
  });

  it("imports keys from GitHub in a sheet, closing it before the approval opens", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(report, staged);
    render(<UsersPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Import keys for alex" }));
    const sheet = await screen.findByRole("dialog", { name: "Import keys for alex" });
    const importButton = within(sheet).getByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("From a GitHub account"), { target: { value: "alex-gh" } });
    // A GitHub name wins, so the paste box is set aside while one is typed.
    expect((within(sheet).getByLabelText("Or paste public keys") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(importButton);
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Import keys for alex" })).toBeNull();
    await waitFor(() => expect(staged["users.keys.import"]).toEqual({ parameters: { username: "alex", githubUser: "alex-gh" } }));
  });

  it("adds a user from a sheet, refusing a name useradd would refuse", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(report, staged);
    render(<UsersPage csrfToken="csrf" />);
    await screen.findByText("Password login on");
    fireEvent.click(screen.getByRole("button", { name: "Add a user…" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a user" });
    const name = within(sheet).getByLabelText(/Username/);
    fireEvent.change(name, { target: { value: "9lives" } });
    expect(within(sheet).getByText(/starting with a letter/)).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Add user" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Sam" } });
    expect((name as HTMLInputElement).value).toBe("sam");
    const add = within(sheet).getByRole("button", { name: "Add user" });
    expect(add.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(add);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["users.add"]).toEqual({ parameters: { username: "sam" } }));
  });

  it("keeps the new user's name when adding it fails, so the sheet opens again with it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/users.inspect/inspect")) return json({ operation: "users.inspect", result: report });
      if (url.endsWith("/operations/users.add/jobs")) return json({ ...job("users.add", "medium"), approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
      if (url.endsWith("/jobs/job-users.add/approve")) return json({ job: { id: "job-users.add", state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/jobs/job-users.add")) return json({ job: { id: "job-users.add", type: "op:users.add", title: "Add sam", state: "failed", risk: "medium", error: "useradd: user 'sam' already exists", result: null, steps: [], approvals: [] } });
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<UsersPage csrfToken="csrf" />);
    await screen.findByText("Password login on");
    fireEvent.click(screen.getByRole("button", { name: "Add a user…" }));
    fireEvent.change(within(await screen.findByRole("dialog", { name: "Add a user" })).getByLabelText(/Username/), { target: { value: "sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText(/already exists/, {}, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a user…" }));
    expect((within(await screen.findByRole("dialog", { name: "Add a user" })).getByLabelText(/Username/) as HTMLInputElement).value).toBe("sam");
  });

  it("stages turning password login off as high risk, and will not while nobody has a key", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(report, staged);
    render(<UsersPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off password login" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByLabelText("Approval password")).toBeTruthy();
    await waitFor(() => expect(staged["ssh.password-auth.set"]).toEqual({ parameters: { enabled: false } }));
    cleanup();

    mockFetch({ ...report, users: report.users.map((user) => ({ ...user, keyCount: 0 })) });
    render(<UsersPage csrfToken="csrf" />);
    const button = await screen.findByRole("button", { name: "Turn off password login" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Import a key before turning passwords off/)).toBeTruthy();
  });

  it("says when root can sign in with a password", async () => {
    mockFetch({ ...report, sshd: { ...report.sshd, permitRootLogin: "yes" } });
    render(<UsersPage csrfToken="csrf" />);
    expect(await screen.findByText("Root can sign in over SSH with a password.")).toBeTruthy();
  });

  it("gives an operator the accounts without the high-risk actions, and tells a viewer who reads them", async () => {
    mockFetch(report);
    render(<UsersPage csrfToken="csrf" role="operator" />);
    const table = await screen.findByRole("table", { name: "Accounts that can sign in" });
    await within(table).findByText("alex");
    expect(within(table).queryAllByRole("button").filter((button) => !button.classList.contains("ui-table__sort"))).toEqual([]);
    expect(screen.queryByRole("button", { name: "Turn off password login" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add a user…" })).toBeTruthy();
    cleanup();

    const fetchMock = mockFetch(report);
    render(<UsersPage csrfToken="csrf" role="viewer" />);
    expect(screen.getByText("Reading accounts needs an operator")).toBeTruthy();
    expect(screen.getByText("Operators only")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when the accounts could not be read, and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<UsersPage csrfToken="csrf" />);
    expect((await screen.findByRole("alert")).textContent).toContain("The helper is not answering");
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

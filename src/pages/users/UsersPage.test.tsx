import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsersPage from "./UsersPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const job = (id: string, risk: string) => ({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });

const report = {
  users: [
    { name: "root", uid: 0, shell: "/bin/bash", sudo: true, keyCount: 0, rootEquivalent: true },
    { name: "alex", uid: 1000, shell: "/bin/bash", sudo: true, keyCount: 2, rootEquivalent: true },
    { name: "pat", uid: 1001, shell: "/bin/bash", sudo: false, keyCount: 0, rootEquivalent: false },
  ],
  sshd: { passwordAuthentication: true, keyboardInteractive: false, pubkeyAuthentication: true, permitRootLogin: "prohibit-password", port: 22 },
  sshActive: true,
  keyAdmins: ["alex"],
  keyOnlyProblem: null,
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

  it("says these are the server's accounts, and takes the owner to where BoxPilot's own people are", async () => {
    mockFetch(report);
    const opened = vi.fn();
    const listener = (event: Event) => opened((event as CustomEvent).detail);
    window.addEventListener("boxpilot:open-view", listener);
    const { unmount } = render(<UsersPage csrfToken="csrf-token" role="owner" />);
    expect(await screen.findByText("These are accounts on the server itself")).toBeTruthy();
    expect(screen.getByText("To let someone sign in to BoxPilot, use Settings, People.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open People" }));
    expect(opened).toHaveBeenCalledWith({ view: "settings", options: { tab: "people" } });
    unmount();
    // People is the owner's: anyone else gets the words, and no button to a panel they cannot open.
    render(<UsersPage csrfToken="csrf-token" role="operator" />);
    expect(await screen.findByText("Who may sign in to BoxPilot is the owner's to change, under Settings, People.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open People" })).toBeNull();
    window.removeEventListener("boxpilot:open-view", listener);
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
    // Enter in the field: the sheet's form is submitted, and Add user is its button.
    const form = name.closest("form") as HTMLFormElement;
    expect((add as HTMLButtonElement).form).toBe(form);
    fireEvent.submit(form);
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
    expect(await screen.findByText(/already exists/)).toBeTruthy();
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

    mockFetch({ ...report, users: report.users.map((user) => ({ ...user, keyCount: 0 })), keyAdmins: [] });
    render(<UsersPage csrfToken="csrf" />);
    const button = await screen.findByRole("button", { name: "Turn off password login" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Import a key for an administrator before turning passwords off/)).toBeTruthy();
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
    // Locking pat is medium; locking alex, an administrator, is high and is not offered.
    expect(within(table).queryAllByRole("button").filter((button) => !button.classList.contains("ui-table__sort")).map((button) => button.getAttribute("aria-label"))).toEqual(["Lock pat"]);
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

  // M90 (audit s1-06 Function #3): "Key-only login" while keyboard-interactive still took the password.
  it("does not call it key-only while keyboard-interactive still asks for the password", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch({ ...report, sshd: { ...report.sshd, passwordAuthentication: false, keyboardInteractive: true } }, staged);
    render(<UsersPage csrfToken="csrf" />);
    expect(await screen.findByText("Passwords via keyboard-interactive")).toBeTruthy();
    expect(screen.queryByText("Key-only login")).toBeNull();
    expect(screen.getByText(/keyboard-interactive login still asks for the password/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off password login" }));
    await waitFor(() => expect(staged["ssh.password-auth.set"]).toEqual({ parameters: { enabled: false } }));
  });

  it("will not turn passwords off when the only keys are root's (PermitRootLogin no) or on an account without sudo", async () => {
    mockFetch({ ...report, users: [{ ...report.users[0], keyCount: 1 }, { ...report.users[1], keyCount: 0 }, { ...report.users[2], keyCount: 2 }], sshd: { ...report.sshd, permitRootLogin: "no" }, keyAdmins: [] });
    render(<UsersPage csrfToken="csrf" />);
    expect(((await screen.findByRole("button", { name: "Turn off password login" })) as HTMLButtonElement).disabled).toBe(true);
  });

  // M90 review: a docker (or lxd, libvirt, wheel, sudoers.d) member is root in all but name, and the
  // server raises locking it to high; the page offers it to the owner, at high, and not to an operator.
  it("treats an account that is root in all but name as an administrator when locking it", async () => {
    const dockerPat = { ...report, users: report.users.map((user) => (user.name === "pat" ? { ...user, rootEquivalent: true } : user)) };
    mockFetch(dockerPat);
    render(<UsersPage csrfToken="csrf" />);
    expect((await screen.findByRole("button", { name: "Lock pat" })).getAttribute("data-risk")).toBe("high");
    cleanup();
    mockFetch(dockerPat);
    render(<UsersPage csrfToken="csrf" role="operator" />);
    await within(await screen.findByRole("table", { name: "Accounts that can sign in" })).findByText("pat");
    expect(screen.queryByRole("button", { name: "Lock pat" })).toBeNull();
  });

  // M90 review: the server says why passwords cannot go off (AuthenticationMethods, sudo without a
  // password); the page shows that, and does not offer the switch.
  it("shows why turning passwords off would be refused", async () => {
    const problem = "This server's SSH configuration asks for more than a key to sign in (AuthenticationMethods publickey,keyboard-interactive).";
    mockFetch({ ...report, keyOnlyProblem: problem });
    render(<UsersPage csrfToken="csrf" />);
    expect(((await screen.findByRole("button", { name: "Turn off password login" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(problem)).toBeTruthy();
  });

  // M90 (audit s1-06 Function #7): an account could be added, never locked or removed.
  it("locks an account, and removes one with the home folder only when that is ticked and called out", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(report, staged);
    render(<UsersPage csrfToken="csrf" />);
    const table = await screen.findByRole("table", { name: "Accounts that can sign in" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).queryByRole("button", { name: /Lock|Remove/ })).toBeNull();
    expect(within(rows[1]).getByRole("button", { name: "Lock alex" }).getAttribute("data-risk")).toBe("high");
    const lock = within(rows[2]).getByRole("button", { name: "Lock pat" });
    expect(lock.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(lock);
    await waitFor(() => expect(staged["users.lock"]).toEqual({ parameters: { username: "pat" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    fireEvent.click(within(rows[2]).getByRole("button", { name: "Remove pat" }));
    const sheet = await screen.findByRole("dialog", { name: "Remove pat" });
    fireEvent.click(within(sheet).getByLabelText("Also remove the home folder"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove…" }));
    expect(await screen.findByText(/The home folder is deleted too/)).toBeTruthy();
    await waitFor(() => expect(staged["users.remove"]).toEqual({ parameters: { username: "pat", removeHome: true } }));
  });

  it("offers to unlock a locked account", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch({ ...report, users: report.users.map((user) => (user.name === "pat" ? { ...user, locked: true } : user)) }, staged);
    render(<UsersPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock pat" }));
    await waitFor(() => expect(staged["users.unlock"]).toEqual({ parameters: { username: "pat" } }));
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsersCenter from "./UsersCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const report = {
  users: [
    { name: "root", uid: 0, shell: "/bin/bash", sudo: true, keyCount: 0 },
    { name: "alex", uid: 1000, shell: "/bin/bash", sudo: true, keyCount: 2 },
    { name: "pat", uid: 1001, shell: "/bin/bash", sudo: false, keyCount: 0 },
  ],
  sshd: { passwordAuthentication: true, keyboardInteractive: false, pubkeyAuthentication: true, permitRootLogin: "prohibit-password", port: 22 },
  sshActive: true,
};

describe("Users center", () => {
  it("lists accounts and stages a GitHub key import through the dialog", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/users.inspect/inspect")) return json({ operation: "users.inspect", result: report });
      if (url.endsWith("/operations/users.keys.import/jobs")) { staged = init?.body as string; return json({ job: { id: "job-k", type: "op:users.keys.import", title: "Import SSH keys", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UsersCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("alex")).toBeTruthy();
    expect(screen.getAllByText("sudo")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Import keys" })[1]);
    fireEvent.change(screen.getByLabelText("GitHub username"), { target: { value: "alex-gh" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { username: "alex", githubUser: "alex-gh" } });
  });

  it("stages turning off password login as a high-risk change", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/users.inspect/inspect")) return json({ operation: "users.inspect", result: report });
      if (url.endsWith("/operations/ssh.password-auth.set/jobs")) { staged = init?.body as string; return json({ job: { id: "job-s", type: "op:ssh.password-auth.set", title: "Change SSH password login", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UsersCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByLabelText("Approval password")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { enabled: false } });
  });

  it("keeps the password-off button disabled when nobody has a key", async () => {
    const keyless = { ...report, users: report.users.map((user) => ({ ...user, keyCount: 0 })) };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/users.inspect/inspect")) return json({ operation: "users.inspect", result: keyless });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UsersCenter csrfToken="csrf-token" />);
    const button = await screen.findByRole("button", { name: "Turn off" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Import a key before turning passwords off/)).toBeTruthy();
  });
});

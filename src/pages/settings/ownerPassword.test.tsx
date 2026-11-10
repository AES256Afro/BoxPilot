import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../ownerPassword";
import ApprovalsPanel from "./ApprovalsPanel";
import NotificationsPanel from "./NotificationsPanel";
import PeoplePanel from "./PeoplePanel";

/*
 * The owner's password on a settings change (ownerPassword.tsx): none inside the window a password
 * already opened, the field back when the server says the window has lapsed, and always in
 * always-password mode.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const lapsed = () => json({ error: "Owner password required", code: "reauthentication_required" }, 401);
const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString();
const until = (iso: string) => `No password needed until ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;

const people = [
  { id: "o1", username: "admin", role: "owner", createdAt: "2026-08-01T00:00:00Z" },
  { id: "p2", username: "sam", role: "viewer", createdAt: "2026-08-01T00:00:00Z" },
  { id: "p3", username: "old", role: "disabled", createdAt: "2026-08-01T00:00:00Z" },
];

interface Sent { method: string; url: string; body: Record<string, unknown> }

/** The session as the shell hands it to a page: elevated until a time, or not; signed in as admin. */
function Session({ elevatedUntil, children }: { elevatedUntil: string | null; children: ReactNode }) {
  return <SessionProvider value={{ elevatedUntil, accountId: "o1" }}>{children}</SessionProvider>;
}

/** Answers the reads; every change is recorded and answered by `change`. */
function serve({ mode = "tiered", change }: { mode?: string; change: (sent: Sent, earlier: Sent[]) => Response }) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (method !== "GET") { const entry = { method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} }; const answer = change(entry, [...sent]); sent.push(entry); return answer; }
    if (url.endsWith("/settings/approval-mode")) return json({ approvalMode: mode, modes: ["tiered", "always-password"], elevationTtlMs: 15 * 60_000 });
    if (url.endsWith("/api/v1/people")) return json({ people });
    if (url.endsWith("/settings/notifications")) return json({ configured: false, kind: null, url: null, topic: null, hasToken: false });
    if (url.endsWith("/settings/watch")) return json({ targetConfigured: false, activeCount: 0, conditions: [] });
    if (url.includes("/api/v1/catalog")) return json({ applications: [], host: {} });
    return json({ error: `unexpected ${url}` }, 500);
  }));
  return sent;
}

describe("People, inside the window a password already opened", () => {
  it("asks for no password, says until when, and sends none", async () => {
    const elevatedUntil = inTenMinutes();
    const sent = serve({ change: (entry) => (entry.method === "POST" ? json({ account: {} }, 201) : json({ account: {} })) });
    render(<Session elevatedUntil={elevatedUntil}><PeoplePanel csrfToken="csrf" /></Session>);
    await screen.findByText("sam");
    // Adding someone: the owner's password is not among the fields.
    await waitFor(() => expect(screen.queryByLabelText("Your owner password")).toBeNull());
    expect(within(screen.getByRole("form", { name: "Add a person" })).getByText(until(elevatedUntil))).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New user name"), { target: { value: "kim" } });
    fireEvent.change(screen.getByLabelText("New account password"), { target: { value: "kims long password" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "POST", url: "/api/v1/people", body: { username: "kim", newPassword: "kims long password", role: "operator" } });
    // A role, a disable and a re-enable confirm with one press.
    fireEvent.change(screen.getByRole("combobox", { name: "Role for sam" }), { target: { value: "operator" } });
    expect(screen.queryByLabelText("Your password, to confirm this change")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make sam an operator" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ method: "PUT", url: "/api/v1/people/p2", body: { role: "operator" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Disable sam" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual({ method: "DELETE", url: "/api/v1/people/p2", body: {} });
  });

  it("shows the field when the server says the window has lapsed, and sends the change again with the password", async () => {
    const sent = serve({ change: (entry) => (entry.body.password ? json({ account: {} }) : lapsed()) });
    const bar = vi.fn();
    window.addEventListener("boxpilot:auth-changed", bar);
    render(<Session elevatedUntil={inTenMinutes()}><PeoplePanel csrfToken="csrf" /></Session>);
    await screen.findByText("sam");
    await waitFor(() => expect(screen.queryByLabelText("Your owner password")).toBeNull());
    fireEvent.change(screen.getByRole("combobox", { name: "Role for sam" }), { target: { value: "operator" } });
    fireEvent.click(screen.getByRole("button", { name: "Make sam an operator" }));
    const field = await screen.findByLabelText("Your password, to confirm this change");
    expect(screen.getAllByText("Type your password to continue.").length).toBeGreaterThan(0);
    // Not an error: nothing was refused but the missing password. The bar reads the session again.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bar).toHaveBeenCalled();
    window.removeEventListener("boxpilot:auth-changed", bar);
    expect((screen.getByRole("button", { name: "Make sam an operator" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Make sam an operator" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((entry) => entry.body)).toEqual([{ role: "operator" }, { role: "operator", password: "correct horse battery" }]);
    await waitFor(() => expect(screen.queryByLabelText("Your password, to confirm this change")).toBeNull());
  });

  it("always asks where approvals are set to ask every time, window or not", async () => {
    const sent = serve({ mode: "always-password", change: () => json({ account: {} }) });
    render(<Session elevatedUntil={inTenMinutes()}><PeoplePanel csrfToken="csrf" /></Session>);
    await screen.findByText("sam");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url.toString().endsWith("/settings/approval-mode"))).toBe(true));
    expect(screen.getByLabelText("Your owner password")).toBeTruthy();
    expect(screen.queryByText(/No password needed until/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[1]);
    fireEvent.change(screen.getByLabelText("Your password, to confirm this change"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable sam" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ password: "correct horse battery" });
  });

  it("asks as before once the window's time has passed, and on a page drawn without the session", async () => {
    serve({ change: () => json({ account: {} }) });
    render(<Session elevatedUntil={new Date(Date.now() - 1000).toISOString()}><PeoplePanel csrfToken="csrf" /></Session>);
    await screen.findByText("sam");
    expect(screen.getByLabelText("Your owner password")).toBeTruthy();
    cleanup();
    render(<PeoplePanel csrfToken="csrf" />);
    await screen.findByText("sam");
    expect(screen.getByLabelText("Your owner password")).toBeTruthy();
  });
});

describe("a new password for someone else", () => {
  const open = async () => {
    await screen.findByText("sam");
    // Each other person's row has it; the owner's own does not, nor a disabled account's.
    expect(screen.queryByRole("button", { name: "Set a new password for admin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set a new password for old" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set a new password for sam" }));
    return screen.findByRole("dialog", { name: "Set a new password" });
  };

  it("takes it twice, twelve characters or more, with the owner's password, and says how many sessions ended", async () => {
    const sent = serve({ change: () => json({ account: { id: "p2", username: "sam", role: "viewer" }, sessionsEnded: 3 }) });
    render(<Session elevatedUntil={null}><PeoplePanel csrfToken="csrf" /></Session>);
    const sheet = await open();
    const set = within(sheet).getByRole("button", { name: "Set the password" }) as HTMLButtonElement;
    fireEvent.change(within(sheet).getByLabelText("New password"), { target: { value: "too short" } });
    expect(within(sheet).getByText("At least 12 characters.")).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("New password"), { target: { value: "sams new password" } });
    fireEvent.change(within(sheet).getByLabelText("New password, again"), { target: { value: "sams new passwor" } });
    expect(within(sheet).getByText("The two do not match.")).toBeTruthy();
    expect(set.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("New password, again"), { target: { value: "sams new password" } });
    expect(set.disabled).toBe(true); // the owner's own is still wanted
    fireEvent.change(within(sheet).getByLabelText("Your owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(set);
    expect(await screen.findByText("sam has a new password and was signed out everywhere (3 sessions).")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent).toEqual([{ method: "POST", url: "/api/v1/people/p2/password", body: { newPassword: "sams new password", password: "correct horse battery" } }]);
  });

  it("asks for no owner password inside the window, then for it when the window has lapsed; a refusal stays in the sheet", async () => {
    const sent = serve({ change: (entry, earlier) => (!entry.body.password ? lapsed() : earlier.length === 1 ? json({ error: "The password must be at least 12 characters", code: "invalid_password" }, 400) : json({ account: { username: "sam" }, sessionsEnded: 1 })) });
    render(<Session elevatedUntil={inTenMinutes()}><PeoplePanel csrfToken="csrf" /></Session>);
    const sheet = await open();
    await waitFor(() => expect(within(sheet).queryByLabelText("Your owner password")).toBeNull());
    expect(within(sheet).getByText(/^No password needed until/)).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("New password"), { target: { value: "sams new password" } });
    fireEvent.change(within(sheet).getByLabelText("New password, again"), { target: { value: "sams new password" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Set the password" }));
    const own = await within(sheet).findByLabelText("Your owner password");
    expect(within(sheet).getByText("Type your password to continue.")).toBeTruthy();
    expect((within(sheet).getByLabelText("New password") as HTMLInputElement).value).toBe("sams new password");
    fireEvent.change(own, { target: { value: "correct horse battery" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Set the password" }));
    expect(await within(sheet).findByText("The password must be at least 12 characters")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Set the password" }));
    expect(await screen.findByText("sam has a new password and was signed out everywhere (1 session).")).toBeTruthy();
    expect(sent.map((entry) => entry.body)).toEqual([{ newPassword: "sams new password" }, { newPassword: "sams new password", password: "correct horse battery" }, { newPassword: "sams new password", password: "correct horse battery" }]);
  });
});

describe("the approval mode and where alerts go, inside the window", () => {
  it("changes the approval mode without the password, and asks for it once the window has lapsed", async () => {
    const elevatedUntil = inTenMinutes();
    const sent = serve({ change: (entry, earlier) => (earlier.length === 0 || entry.body.password ? json({ approvalMode: entry.body.approvalMode, modes: [] }) : lapsed()) });
    render(<Session elevatedUntil={elevatedUntil}><ApprovalsPanel csrfToken="csrf" /></Session>);
    fireEvent.click(await screen.findByRole("radio", { name: /Always ask/ }));
    await waitFor(() => expect(screen.queryByLabelText("Owner password")).toBeNull());
    expect(screen.getByText(new RegExp(until(elevatedUntil).replace(/[.]/g, "\\.")))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Every approval will ask for your password.")).toBeTruthy();
    expect(sent[0].body).toEqual({ approvalMode: "always-password" });
    // Back again, and this time the server wants the password.
    fireEvent.click(screen.getByRole("radio", { name: /Tiered/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const field = await screen.findByLabelText("Owner password");
    expect(screen.getByText("Type your password to continue.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Tiered approvals are on.")).toBeTruthy();
    expect(sent.map((entry) => entry.body)).toEqual([{ approvalMode: "always-password" }, { approvalMode: "tiered" }, { approvalMode: "tiered", password: "correct horse battery" }]);
  });

  it("saves where alerts go without the password, and asks for it once the window has lapsed", async () => {
    const elevatedUntil = inTenMinutes();
    const saved = { configured: true, kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot", hasToken: false };
    const sent = serve({ change: (entry, earlier) => (entry.url.endsWith("/test") ? json({ ok: true }) : earlier.length > 0 || entry.body.password ? json(saved) : lapsed()) });
    render(<Session elevatedUntil={elevatedUntil}><NotificationsPanel csrfToken="csrf" /></Session>);
    fireEvent.change(await screen.findByLabelText("Server URL"), { target: { value: "http://127.0.0.1:8093" } });
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "boxpilot" } });
    await waitFor(() => expect(screen.queryByLabelText("Owner password")).toBeNull());
    expect(screen.getByText(until(elevatedUntil))).toBeTruthy();
    expect(screen.queryByText("Type your password to save.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The window had lapsed: the field, and the same target sent again with the password.
    const field = await screen.findByLabelText("Owner password");
    expect(screen.getByText("Type your password to continue.")).toBeTruthy();
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("http://127.0.0.1:8093");
    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved/)).toBeTruthy();
    const puts = sent.filter((entry) => entry.method === "PUT").map((entry) => entry.body);
    expect(puts).toEqual([{ target: { kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" } }, { target: { kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" }, password: "correct horse battery" }]);
  });
});

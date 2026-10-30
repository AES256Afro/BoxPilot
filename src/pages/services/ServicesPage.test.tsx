import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ServicesPage from "./ServicesPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const units = [
  { unit: "docker.service", description: "Docker Application Container Engine", load: "loaded", active: "active", sub: "running", enabled: "enabled", critical: false },
  { unit: "ssh.service", description: "OpenBSD Secure Shell server", load: "loaded", active: "active", sub: "running", enabled: "enabled", critical: true },
  { unit: "nginx.service", description: "A high performance web server", load: "loaded", active: "failed", sub: "failed", enabled: "enabled", critical: false },
  { unit: "fstrim.timer", description: "Discard unused filesystem blocks once a week", load: "loaded", active: "active", sub: "waiting", enabled: "enabled", critical: false },
  { unit: "getty@tty1.service", description: "Getty on tty1", load: "loaded", active: "active", sub: "running", enabled: "enabled", critical: false },
];
const list = { operation: "service.list", result: { counts: { total: units.length, active: 4, failed: 1 }, units } };

describe("Services page", () => {
  it("puts the verdict and the counts first, then the units with the failed ones at the top", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().endsWith("/operations/service.list/inspect") ? json(list) : json({ error: "unexpected" }, 500))));
    render(<ServicesPage csrfToken="csrf-token" />);
    expect(await screen.findByText("docker.service")).toBeTruthy();
    // The name is the page's one h1, drawn in place without a shell.
    expect(screen.getByRole("heading", { level: 1, name: "Services" })).toBeTruthy();
    expect(screen.getByText("1 failed").closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("5 units · 4 active · 1 failed · 1 timer · 1 protected");
    // What the page is for waits behind the info toggle.
    const about = screen.getByRole("button", { name: "About Services" });
    expect(about.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(about);
    expect(screen.getByText(/cannot be stopped or disabled from here/).closest("[hidden]")).toBeNull();

    const table = screen.getByRole("table", { name: "System services and timers" });
    const rows = within(table).getAllByRole("row").slice(1);
    // Common units, failed first: getty is not one of them.
    expect(rows[0].textContent).toContain("nginx.service");
    expect(rows[0].getAttribute("data-status")).toBe("danger");
    expect(table.textContent).not.toContain("getty@tty1.service");
    fireEvent.click(screen.getByRole("radio", { name: /All/ }));
    expect(within(table).getByText("getty@tty1.service")).toBeTruthy();
  });

  it("filters by name across every unit, and clears with Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(list)));
    render(<ServicesPage csrfToken="csrf-token" />);
    await screen.findByText("docker.service");
    const search = screen.getByRole("searchbox", { name: "Filter units" });
    fireEvent.change(search, { target: { value: "getty" } });
    const table = screen.getByRole("table", { name: "System services and timers" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual([expect.stringContaining("getty@tty1.service")]);
    // A search overrides the scope, so no scope is chosen while it is there.
    expect(screen.getAllByRole("radio").every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(within(table).getByText("No units match")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("hides Stop for protected units, shows each action's tier, and stages a restart through the dialog", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/service.list/inspect")) return json(list);
      if (url.endsWith("/operations/service.action/jobs")) { staged = init?.body as string; return json({ job: { id: "job-s", type: "op:service.action", title: "Control a system service", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ServicesPage csrfToken="csrf-token" />);
    expect(await screen.findByText("docker.service")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    const sshRow = rows.find((row) => row.textContent?.includes("ssh.service"));
    expect(sshRow?.textContent).not.toContain("Stop");
    expect(sshRow?.textContent).toContain("protected");
    const dockerRow = rows.find((row) => row.textContent?.includes("docker.service"));
    expect(dockerRow?.textContent).toContain("Stop");
    const restart = screen.getByRole("button", { name: "Restart docker.service" });
    expect(restart.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(restart);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { unit: "docker.service", action: "restart" } });
  });

  it("gives a viewer the units and no actions, and no journal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(list)));
    render(<ServicesPage csrfToken="csrf-token" role="viewer" />);
    const table = await screen.findByRole("table", { name: "System services and timers" });
    await within(table).findByText("docker.service");
    expect(within(table).queryAllByRole("button").filter((button) => !button.classList.contains("ui-table__sort"))).toEqual([]);
  });

  it("opens the journal in a sheet, closes it on Escape and gives focus back to its button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/service.list/inspect")) return json({ operation: "service.list", result: { counts: { total: 1, active: 1, failed: 0 }, units: [units[0]] } });
      return json({ operation: "service.journal", result: { lines: ["started docker"] } });
    }));
    render(<ServicesPage csrfToken="csrf-token" />);
    const opener = await screen.findByRole("button", { name: "Journal of docker.service" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "docker.service" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(await within(dialog).findByText("started docker")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // A journal that answered late was put in whatever sheet was open then: another unit's, or it
  // reopened one already closed.
  it("never shows a late journal in a closed sheet or another unit's", async () => {
    const answers = new Map<string, () => void>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/service.list/inspect")) return json(list);
      const unit = (JSON.parse(String(init?.body)) as { parameters: { unit: string } }).parameters.unit;
      return new Promise<Response>((resolve) => { answers.set(unit, () => resolve(json({ operation: "service.journal", result: { lines: [`journal of ${unit}`] } }))); });
    }));
    render(<ServicesPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Journal of docker.service" }));
    let dialog = await screen.findByRole("dialog", { name: "docker.service" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(answers.has("docker.service")).toBe(true));
    answers.get("docker.service")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Journal of nginx.service" }));
    dialog = await screen.findByRole("dialog", { name: "nginx.service" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Journal of fstrim.timer" }));
    dialog = await screen.findByRole("dialog", { name: "fstrim.timer" });
    await waitFor(() => expect(answers.has("nginx.service")).toBe(true));
    answers.get("nginx.service")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("dialog", { name: "fstrim.timer" }).textContent).not.toContain("journal of nginx.service");
    await waitFor(() => expect(answers.has("fstrim.timer")).toBe(true));
    answers.get("fstrim.timer")!();
    expect(await within(dialog).findByText("journal of fstrim.timer")).toBeTruthy();
  });

  it("says when the list could not be read, and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<ServicesPage csrfToken="csrf-token" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The helper is not answering")).toBeTruthy();
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

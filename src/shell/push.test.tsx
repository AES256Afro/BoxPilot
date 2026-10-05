import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceLabel, pushSupport } from "../pwa/push";
import { DeepLinkApproval, approvalFromUrl, takeApprovalFromLocation } from "./DeepLinkApproval";
import { PushPanel } from "./PushPanel";
import { SessionControls } from "./SessionControls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.history.replaceState(null, "", "/"); });

const id = "0f8b3c1e-1111-4222-8333-444455556666";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const staged = { id, type: "op:app.update", title: "Update an app", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [], parameters: { id: "jellyfin" }, createdAt: "2026-09-29T07:00:00Z", recovery: { reason: "Pulls the new image." } };

describe("an approval opened from a push (M25.2)", () => {
  it("takes only a job id from the address, and leaves Today under it", () => {
    expect(approvalFromUrl(`https://homebox.example/?approve=${id}`)).toBe(id);
    expect(approvalFromUrl("https://homebox.example/?approve=../../x")).toBeNull();
    expect(approvalFromUrl("not a url")).toBeNull();
    window.history.replaceState(null, "", `/?approve=${id.toUpperCase()}`);
    expect(takeApprovalFromLocation()).toBe(id);
    expect(window.location.search).toBe("?view=today");
    expect(takeApprovalFromLocation()).toBeNull();
  });

  it("opens the ordinary dialog at the job's own tier: a push approves nothing by itself", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === `/api/v1/jobs/${id}`) return json({ job: staged });
      if (url === `/api/v1/jobs/${id}/approval`) return json({ tier: "high", passwordRequired: true, elevated: false, mode: "tiered", confirmText: "jellyfin" });
      return json({ error: `unexpected ${url}` }, 404);
    });
    vi.stubGlobal("fetch", fetch);
    render(<DeepLinkApproval jobId={id} csrfToken="csrf" onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "Update an app" });
    expect(await within(dialog).findByText("High risk")).toBeTruthy();
    // The password and the typed confirmation, as for any high-risk job; nothing sent until then.
    expect(within(dialog).getByLabelText("Approval password")).toBeTruthy();
    expect(within(dialog).getByLabelText("Typed confirmation")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: /Approve and run/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetch.mock.calls.some((call) => ((call as unknown[])[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("says so when the job is no longer waiting, or is not this account's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ job: { ...staged, state: "completed" } })));
    render(<DeepLinkApproval jobId={id} csrfToken="csrf" onClose={vi.fn()} />);
    expect(await screen.findByText(/no longer waiting for approval: it is completed/)).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Job not found", code: "job_not_found" }, 404)));
    render(<DeepLinkApproval jobId={id} csrfToken="csrf" onClose={vi.fn()} />);
    expect(await screen.findByText(/no such job waiting for this account/)).toBeTruthy();
  });
});

const status = (role: string) => ({
  canSubscribe: role !== "viewer", publicKey: "BNf-key", problem: null,
  devices: [{ id: "phone-1", label: "iPhone", service: "Apple", createdAt: "2026-09-26T07:00:00Z", lastSentAt: "2026-09-29T06:00:00Z", lastError: null }],
  settings: { tiers: { low: false, medium: true, high: true }, quietHours: { enabled: false, start: "22:00", end: "07:00" }, ntfy: "fallback", openAt: role === "owner" ? "https://homebox.example.ts.net" : null, timeZone: "Europe/London" },
});

describe("approvals on your phone", () => {
  it("lists this account's devices, and lets the owner choose the tiers, quiet hours and ntfy", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "PUT" ? json(JSON.parse(String(init.body))) : json(status("owner"))));
    vi.stubGlobal("fetch", fetch);
    render(<PushPanel csrfToken="csrf" role="owner" />);
    const panel = await screen.findByRole("region", { name: "Approvals on your phone" });
    expect(within(panel).getByRole("list", { name: "Your devices with pushes on" }).textContent).toContain("iPhone");
    expect(within(panel).getByText(/Tapping it opens BoxPilot at the approval/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Low risk" }));
    fireEvent.click(within(panel).getByRole("switch", { name: /Quiet hours/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/settings/push", expect.objectContaining({ method: "PUT" })));
    const sent = JSON.parse(String(fetch.mock.calls.find(([url]) => url === "/api/v1/settings/push")![1]!.body));
    expect(sent).toEqual({ tiers: { low: true, medium: true, high: true }, quietHours: { enabled: true, start: "22:00", end: "07:00" }, ntfy: "fallback" });
  });

  it("keeps unsaved choices through a test push or a removed device, and takes the saved ones after Save", async () => {
    // Every action read the status again and reset the choices to the stored ones.
    let stored = status("owner").settings;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/push/test") return json({ devices: 1, delivered: 1 });
      if (url === "/api/v1/settings/push" && init?.method === "PUT") { stored = { ...stored, ...JSON.parse(String(init.body)) }; return json(stored); }
      if (url.startsWith("/api/v1/push/subscriptions/")) return json({ removed: true });
      return json({ ...status("owner"), settings: stored });
    });
    vi.stubGlobal("fetch", fetch);
    render(<PushPanel csrfToken="csrf" role="owner" />);
    const panel = await screen.findByRole("region", { name: "Approvals on your phone" });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Low risk" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Send a test" }));
    expect(await within(panel).findByText("Sent to 1 of 1 device.")).toBeTruthy();
    expect((within(panel).getByRole("checkbox", { name: "Low risk" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Remove iPhone" }));
    expect(await within(panel).findByText("Removed.")).toBeTruthy();
    expect((within(panel).getByRole("checkbox", { name: "Low risk" }) as HTMLInputElement).checked).toBe(true);
    expect((within(panel).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByText("Saved.")).toBeTruthy();
    expect(stored.tiers.low).toBe(true);
    expect((within(panel).getByRole("checkbox", { name: "Low risk" }) as HTMLInputElement).checked).toBe(true);
    await vi.waitFor(() => expect((within(panel).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("shows an operator their devices but not the owner's choices, and a viewer nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(status("operator"))));
    render(<PushPanel csrfToken="csrf" role="operator" />);
    await screen.findByRole("region", { name: "Approvals on your phone" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json(status("viewer"))));
    const { container } = render(<PushPanel csrfToken="csrf" role="viewer" />);
    await vi.waitFor(() => expect(container.textContent).toBe(""));
  });

  it("tells an iPhone in a Safari tab to add BoxPilot to its Home Screen first", async () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 });
    expect(pushSupport()).toBe("install-first");
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...status("owner"), devices: [] })));
    render(<PushPanel csrfToken="csrf" role="owner" />);
    expect(await screen.findByText("Add BoxPilot to your Home Screen first")).toBeTruthy();
    expect(screen.getByText(/tap Share, then Add to Home Screen/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on for this device" })).toBeNull();
  });

  it("names a device by its kind only", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X)")).toBe("iPad");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 16)")).toBe("Android");
    expect(deviceLabel("curl/8")).toBe("This device");
  });

  it("turns this device's pushes off when signing out here", async () => {
    window.localStorage.setItem("boxpilot:push-device", "phone-1");
    const fetch = vi.fn(async () => json({ removed: true }));
    vi.stubGlobal("fetch", fetch);
    const onSignedOut = vi.fn();
    render(<SessionControls authStatus={{ bootstrapRequired: false, authenticated: true, owner: { id: "o1", username: "alex", role: "owner" }, csrfToken: "csrf", expiresAt: null }} csrfToken="csrf" onRefresh={vi.fn()} onSignedOut={onSignedOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalled());
    const urls = fetch.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls).toEqual(["/api/v1/push/subscriptions/phone-1", "/api/v1/auth/logout"]);
    expect(window.localStorage.getItem("boxpilot:push-device")).toBeNull();
  });
});

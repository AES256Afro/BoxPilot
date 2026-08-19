import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ServicesCenter from "./ServicesCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Services center", () => {
  it("lists units, hides Stop for protected units, and stages a restart through the dialog", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/service.list/inspect")) return json({ operation: "service.list", result: { counts: { total: 2, active: 2, failed: 0 }, units: [
        { unit: "docker.service", description: "Docker Application Container Engine", load: "loaded", active: "active", sub: "running", enabled: "enabled", critical: false },
        { unit: "ssh.service", description: "OpenBSD Secure Shell server", load: "loaded", active: "active", sub: "running", enabled: "enabled", critical: true },
      ] } });
      if (url.endsWith("/operations/service.action/jobs")) { staged = init?.body as string; return json({ job: { id: "job-s", type: "op:service.action", title: "Control a system service", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ServicesCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("docker.service")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    const sshRow = rows.find((row) => row.textContent?.includes("ssh.service"));
    expect(sshRow?.textContent).not.toContain("Stop");
    const dockerRow = rows.find((row) => row.textContent?.includes("docker.service"));
    expect(dockerRow?.textContent).toContain("Stop");
    fireEvent.click(screen.getAllByRole("button", { name: "Restart" })[0]);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { unit: "docker.service", action: "restart" } });
  });
});

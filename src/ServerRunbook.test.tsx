import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ServerRunbook from "./ServerRunbook";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ownerStatus = {
  audience: "owner", canDownload: true, version: "9.9.9-test", checkedAt: "2026-09-28T13:00:00.000Z",
  lastDownload: { at: "2026-09-28T10:00:00.000Z", version: "9.9.9-test", fingerprint: "0123456789abcdef" },
  outOfDate: { since: "2026-09-28T12:00:00.000Z", change: "Install Immich", more: 1 }, changes: 2,
};
const preview = {
  audience: "owner", version: "9.9.9-test", generatedAt: "2026-09-28T13:00:00.000Z", fingerprint: "fedcba9876543210",
  markdown: "# Runbook: homeserver\n\n## 1. This server\n",
  comparison: { downloadedAt: "2026-09-28T10:00:00.000Z", matches: false, changedSections: ["Apps", "Automation"] },
};

describe("Document this server", () => {
  it("says the downloaded copy is out of date since the first change, and previews the document", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/runbook/status")) return json(ownerStatus);
      if (url.endsWith("/runbook")) return json(preview);
      return json({ error: "unexpected" }, 500);
    }));
    render(<ServerRunbook />);
    expect(await screen.findByText(/Out of date since: Install Immich .*, and 1 more change\./)).toBeTruthy();
    expect(screen.getByText("out of date")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download runbook (.md)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview runbook" }));
    expect(await screen.findByText(/# Runbook: homeserver/)).toBeTruthy();
    expect(screen.getByText(/fingerprint fedcba9876543210\. It differs from the copy downloaded .* in: Apps, Automation\./)).toBeTruthy();
  });

  it("downloads the owner's copy as a file and checks again whether it is up to date", async () => {
    let downloaded = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/runbook/status")) return json(downloaded ? { ...ownerStatus, lastDownload: { ...ownerStatus.lastDownload, at: "2026-09-28T13:00:00.000Z" }, outOfDate: null, changes: 0 } : ownerStatus);
      if (url.endsWith("/runbook/download")) {
        downloaded = true;
        return new Response("# Runbook: homeserver\n", { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="boxpilot-runbook-homeserver-2026-09-28.md"' } });
      }
      return json({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:boxpilot-runbook");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<ServerRunbook />);
    fireEvent.click(await screen.findByRole("button", { name: "Download runbook (.md)" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created).toHaveBeenCalled();
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe("boxpilot-runbook-homeserver-2026-09-28.md");
    expect(await screen.findByText(/Nothing that changes it has happened since\./)).toBeTruthy();
    expect(screen.getByText("up to date")).toBeTruthy();
  });

  it("lets an operator preview but not download, and tells a viewer it needs an operator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...ownerStatus, audience: "operator", canDownload: false, lastDownload: null, outOfDate: null, changes: 0 })));
    render(<ServerRunbook />);
    expect(await screen.findByText("The owner has not downloaded it yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview runbook" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download runbook (.md)" })).toBeNull();
    expect(screen.getByText(/Only the owner can download it/)).toBeTruthy();
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "This needs the owner or operator role", code: "forbidden" }, 403)));
    render(<ServerRunbook />);
    expect(await screen.findByText(/needs an operator/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview runbook" })).toBeNull();
  });

  it("says so when the preview cannot be put together", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().endsWith("/runbook/status") ? json(ownerStatus) : json({ error: "The runbook could not be put together. Try again in a moment.", code: "runbook_unavailable" }, 503))));
    render(<ServerRunbook />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview runbook" }));
    expect(await screen.findByText("Runbook not ready")).toBeTruthy();
  });
});

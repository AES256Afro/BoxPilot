import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RestoreDatabase from "./RestoreDatabase";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const copies = [
  { kind: "backup", id: "10000000-0000-4000-8000-000000000001", createdAt: "2026-11-24T02:00:00.000Z", sizeBytes: 4 * 1024 ** 2, checksumSha256: "a".repeat(64) },
  { kind: "snapshot", id: "20261125T100000Z", createdAt: "2026-11-20T02:00:00.000Z", sizeBytes: 3 * 1024 ** 2, checksumSha256: "b".repeat(64) },
];

function mockFetch() {
  const bodies: Record<string, string> = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith("/operations/host.database.sources/inspect")) return json({ result: { copies } });
    const match = url.match(/\/operations\/([a-z.-]+)\/jobs$/);
    if (match) {
      bodies[match[1]] = init?.body as string;
      return json({ job: { id: "job-1", type: `op:${match[1]}`, title: match[1], state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201);
    }
    return json({ error: `unexpected ${url}` }, 404);
  }));
  return bodies;
}

// M91: a database backup, or the copy a snapshot restore staged, could only be read in the browser.
describe("Restore the database copy", () => {
  it("lists both kinds of copy and puts one back as the owner's high-risk action, typed out by its id", async () => {
    const bodies = mockFetch();
    render(<RestoreDatabase csrfToken="csrf-token" role="owner" />);
    expect(await screen.findByText("Database backup")).toBeTruthy();
    expect(screen.getByText(/^From the snapshot restored /)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /^Restore the database copy of / });
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("data-risk")).toBe("high");
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(JSON.parse(bodies["host.database.restore"] ?? "{}")).toEqual({ parameters: { kind: "snapshot", id: "20261125T100000Z" } }));
  });

  it("offers no restore to an operator, and shows nothing to a viewer", async () => {
    mockFetch();
    const { unmount } = render(<RestoreDatabase csrfToken="csrf-token" role="operator" />);
    expect(await screen.findByText("Database backup")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Restore the database copy of / })).toBeNull();
    unmount();
    const { container } = render(<RestoreDatabase csrfToken="csrf-token" role="viewer" />);
    expect(container.textContent).toBe("");
  });
});

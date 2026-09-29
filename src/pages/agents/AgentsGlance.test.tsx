import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsGlance } from "./AgentsGlance";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const glance = { enabled: true, paused: false, runnerOnline: true, digest: { agentId: "a", agentName: "Server Keeper", runId: "r", at: "2026-09-29T05:31:00Z", excerpt: "All well: backups ran, nothing failed.", state: "completed" }, cardsWaiting: 2 };

describe("Agents at a glance on Home and Ops", () => {
  it("shows the latest digest and the cards waiting, and opens the section", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(glance)));
    const onOpen = vi.fn();
    render(<AgentsGlance variant="ops" role="operator" onOpen={onOpen} now={() => Date.parse("2026-09-29T09:31:00Z")} />);
    expect(await screen.findByText("All well: backups ran, nothing failed.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Agents" }).textContent).toContain("2 cards wait for you");
    fireEvent.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("shows nothing to a viewer, and asks nothing for them", () => {
    const fetchMock = vi.fn(async () => json(glance));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AgentsGlance variant="home" role="viewer" onOpen={() => undefined} />);
    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the runner is stopped, over the cards and this morning's digest, and what waits for it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...glance, runnerOnline: false, queued: 1 })));
    render(<AgentsGlance variant="ops" role="owner" onOpen={() => undefined} now={() => Date.parse("2026-09-29T09:31:00Z")} />);
    const panel = await screen.findByRole("region", { name: "Agents" });
    await waitFor(() => expect(panel.textContent).toContain("Nothing runs until the runner starts: 1 run waits for it."));
    const chip = within(panel).getByText("Runner stopped").closest("[data-status]");
    expect(chip?.getAttribute("data-status")).toBe("warning");
    expect(panel.textContent).not.toContain("2 cards ·");
    expect(within(panel).queryByText("2 cards")).toBeNull();
    cleanup();

    render(<AgentsGlance variant="home" role="operator" onOpen={() => undefined} now={() => Date.parse("2026-09-29T09:31:00Z")} />);
    expect(await screen.findByText("Runner stopped")).toBeTruthy();
    expect(screen.getByText(/Nothing runs until the runner starts/)).toBeTruthy();
  });

  it("says nothing of the runner while it answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...glance, queued: 0 })));
    render(<AgentsGlance variant="home" role="owner" onOpen={() => undefined} now={() => Date.parse("2026-09-29T09:31:00Z")} />);
    expect(await screen.findByText("Running cool")).toBeTruthy();
    expect(screen.queryByText(/Nothing runs until/)).toBeNull();
  });

  it("shows nothing on a server where Agents were never turned on", async () => {
    const fetchMock = vi.fn(async () => json({ ...glance, enabled: false, digest: null, cardsWaiting: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AgentsGlance variant="home" role="owner" onOpen={() => undefined} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

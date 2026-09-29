import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZulipState } from "./api";
import { ZulipPanel } from "./ZulipPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = Date.parse("2026-09-29T10:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const channels = { findings: "agent-findings", logs: "agent-logs", knowledge: "agent-knowledge", files: "agent-files" };
const base: ZulipState = {
  connected: false, site: null, realm: null, botEmail: null, channels, notPrivate: [], connectedAt: null, boxpilotUrl: null,
  lastPost: null, lastError: null, files: { lastPollAt: null, lastIngest: null, lastError: null }, counts: {}, recent: [], active: true,
  app: { installed: false, running: false, port: null }, canChange: true,
};
const connected: ZulipState = {
  ...base, connected: true, site: "https://homebox.tail1234.ts.net:8543", realm: "Our house", botEmail: "boxpilot-agents-bot@homebox.tail1234.ts.net", connectedAt: ago(90),
  boxpilotUrl: "https://homebox.tail1234.ts.net", app: { installed: true, running: true, port: 8543 },
  lastPost: { at: ago(3), channel: "agent-logs", topic: "Server Keeper" }, files: { lastPollAt: ago(1), lastIngest: { at: ago(20), title: "router notes" }, lastError: null },
  counts: { sent: 12, queued: 1, failed: 0 },
  recent: [{ id: "p1", kind: "findings", channel: "agent-findings", topic: "Server Keeper", state: "sent", error: null, createdAt: ago(4), sentAt: ago(3), agentName: "Server Keeper", preview: "**Server Keeper** · answered a question" }],
};

function serve(state: ZulipState, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, method: init?.method ?? "GET" });
    return extra(url, init) ?? (url === "/api/v1/agents/zulip" ? json(state) : json({ error: "unexpected" }, 500));
  }));
  return calls;
}

describe("the team chat panel", () => {
  it("says Zulip is not installed, and where to get it", async () => {
    serve(base);
    render(<ZulipPanel csrfToken="csrf" role="owner" now={now} onStart={() => {}} refreshKey={0} />);
    expect(await screen.findByText("Not installed")).toBeTruthy();
    expect((screen.getByRole("link", { name: "App catalog" }) as HTMLAnchorElement).getAttribute("href")).toBe("?view=catalog&app=zulip");
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    for (const name of ["#agent-findings", "#agent-logs", "#agent-knowledge", "#agent-files"]) expect(screen.getByText(name)).toBeTruthy();
  });

  it("stages Connect at its tier, with the address the owner opened BoxPilot at", async () => {
    serve({ ...base, app: { installed: true, running: true, port: 8543 } });
    const onStart = vi.fn();
    render(<ZulipPanel csrfToken="csrf" role="owner" now={now} onStart={onStart} refreshKey={0} />);
    const connect = await screen.findByRole("button", { name: "Connect the agents" });
    expect(connect.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(connect);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ operationId: "agents.zulip.connect", parameters: { boxpilotUrl: window.location.origin } }));
    expect(screen.getByText(/Create your organization from its sheet in the App catalog first/)).toBeTruthy();
  });

  it("shows the connection, the last post, what came in from #agent-files and the last posts; and reads #agent-files now", async () => {
    let polled = false;
    const calls = serve(connected, (url, init) => (url === "/api/v1/agents/zulip/poll" && init?.method === "POST" ? (polled = true, json({ messages: 2, added: 1 })) : undefined));
    render(<ZulipPanel csrfToken="csrf" role="owner" now={now} onStart={() => {}} refreshKey={0} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect((screen.getByRole("link", { name: "homebox.tail1234.ts.net:8543" }) as HTMLAnchorElement).href).toBe("https://homebox.tail1234.ts.net:8543/");
    expect(screen.getByText("#agent-logs › Server Keeper")).toBeTruthy();
    expect(screen.getByText("Added “router notes”")).toBeTruthy();
    expect(screen.getByText("12 sent · 1 waiting · 0 failed")).toBeTruthy();
    const table = screen.getByRole("table", { name: "The last posts" });
    expect(within(table).getByText("**Server Keeper** · answered a question")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" }).getAttribute("data-risk")).toBe("low");
    fireEvent.click(screen.getByRole("button", { name: "Check #agent-files now" }));
    expect(await screen.findByText("Read 2 new messages; 1 added to Knowledge.")).toBeTruthy();
    expect(polled).toBe(true);
    expect(calls.filter((call) => call.url === "/api/v1/agents/zulip")).toHaveLength(2);
  });

  it("says when the last post failed, and that posting waits while Agents are paused", async () => {
    serve({ ...connected, active: false, lastError: { at: ago(2), message: "Zulip refused the bot's key; connect Zulip again" }, notPrivate: ["agent-files"] });
    render(<ZulipPanel csrfToken="csrf" role="owner" now={now} onStart={() => {}} refreshKey={0} />);
    expect(await screen.findByText("Connected, last post failed")).toBeTruthy();
    expect(screen.getByText("Zulip refused the bot's key; connect Zulip again")).toBeTruthy();
    expect(screen.getByText("Waiting while Agents are off or paused")).toBeTruthy();
    expect(screen.getByText(/#agent-files was already there and public/)).toBeTruthy();
  });

  it("gives an operator the connection and no buttons", async () => {
    serve({ ...connected, canChange: false, recent: [], boxpilotUrl: null });
    render(<ZulipPanel csrfToken="csrf" role="operator" now={now} onStart={() => {}} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

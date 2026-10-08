import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudState } from "./api";
import { ClaudePanel } from "./ClaudePanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = Date.parse("2026-10-08T12:00:00Z");

const off: CloudState = { connected: false, model: "claude-opus-5-5", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], capUsd: null, connectedAt: null, gateway: "off", month: null, spentUsd: null, calls: null, problem: null };
const on: CloudState = { ...off, connected: true, capUsd: 20, connectedAt: new Date(now - 3_600_000).toISOString(), gateway: "answering", month: "2026-10", spentUsd: 17.5, calls: 42 };

function serve(state: CloudState) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString() === "/api/v1/agents/cloud" ? json(state) : json({ error: "unexpected" }, 500))));
}

const key = `sk-ant-api03-${"k".repeat(40)}`;

describe("the Claude panel", () => {
  it("lets the owner connect with a key and a cap, staged at high risk, and holds what is not a key", async () => {
    serve(off);
    const onStart = vi.fn();
    render(<ClaudePanel role="owner" owner now={now} onStart={onStart} refreshKey={0} />);
    expect(await screen.findByText("Not connected")).toBeTruthy();
    const connect = screen.getByRole("button", { name: "Connect Claude" }) as HTMLButtonElement;
    expect(connect.getAttribute("data-risk")).toBe("high");
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-proj-not-anthropic" } });
    expect(screen.getByText(/starts sk-ant-/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: ` ${key} ` } });
    fireEvent.change(screen.getByLabelText("Monthly cap, in dollars"), { target: { value: "25" } });
    fireEvent.click(connect);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ operationId: "agents.cloud.connect", parameters: { key, capUsd: 25 } }));
  });

  it("shows the month against the cap, warns near it, and offers a new cap and Disconnect", async () => {
    serve(on);
    const onStart = vi.fn();
    render(<ClaudePanel role="owner" owner now={now} onStart={onStart} refreshKey={0} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("$17.50 of $20")).toBeTruthy();
    expect(screen.getByText(/42 calls/)).toBeTruthy();
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    fireEvent.change(screen.getByLabelText("New monthly cap, in dollars"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Change the cap" }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ operationId: "agents.cloud.cap", parameters: { capUsd: 40 } }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "agents.cloud.disconnect" }));
  });

  it("says when the gateway is not answering, and shows an operator the state without the owner's controls", async () => {
    serve({ ...on, gateway: "not answering", spentUsd: null, problem: "The model gateway is not answering; agents run on the local model until it does" });
    render(<ClaudePanel role="operator" owner={false} now={now} onStart={() => {}} refreshKey={0} />);
    expect(await screen.findByText("Gateway not answering")).toBeTruthy();
    expect(screen.getByText("The gateway is not answering")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change the cap" })).toBeNull();
  });
});

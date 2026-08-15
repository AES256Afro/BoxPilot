import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemLogs from "./SystemLogs";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("redacted system logs", () => {
  it("renders the fixed BoxPilot source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ source: "boxpilot", entries: [{ timestamp: "2026-08-15T19:00:00Z", unit: "boxpilot.service", priority: 6, message: "BoxPilot listening" }] }), { status: 200 })));
    render(<SystemLogs />);
    expect(await screen.findByText("BoxPilot listening")).toBeTruthy();
    expect(screen.getByText("boxpilot.service")).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RuntimeHealth from "./RuntimeHealth";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("waits for a manual check and keeps web metrics visible when the helper is down", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ web: { checkedAt: "2026-09-07T12:00:00Z", version: "1.114.0", processMemory: { rss: 1048576, heapUsed: 524288, external: 0 }, cpu: { percentOfOneCore: null }, cgroup: { fileCacheBytes: 4294967296, anonymousBytes: 1048576, oomKills: null } }, helper: null, helperAvailable: false, transport: null })));
  vi.stubGlobal("fetch", fetchMock);
  render(<RuntimeHealth />);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check resource use" }));
  expect(await screen.findByText(/The helper did not answer/)).toBeTruthy();
  expect(screen.getByText("JavaScript heap used")).toBeTruthy();
  expect(screen.getByText("Linux file cache")).toBeTruthy();
  expect(screen.getByText("4,096 MiB")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

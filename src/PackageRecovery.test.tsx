import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PackageRecovery from "./PackageRecovery";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("checks only on request, exposes the package diagnosis and offers a reviewed repair", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { status: "needs-repair", repairAvailable: true, checkedAt: "2026-09-07T12:00:00Z", locks: { available: true, holders: [] }, audit: { ok: true, detail: "example is not configured" }, simulation: null } })));
  vi.stubGlobal("fetch", fetchMock);
  render(<PackageRecovery csrfToken="test" />);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check package recovery" }));
  expect(await screen.findByRole("button", { name: "Review package repair" })).toBeTruthy();
  expect(screen.getByText("example is not configured")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/operations/apt.health.inspect/inspect");
});
it("keeps repair unavailable while another updater owns a lock", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { status: "busy", repairAvailable: false, checkedAt: "2026-09-07T12:00:00Z", locks: { available: true, holders: [{ pid: 42, file: "/var/lib/dpkg/lock" }] }, audit: null, simulation: null } }))));
  render(<PackageRecovery csrfToken="test" />);
  fireEvent.click(screen.getByRole("button", { name: "Check package recovery" }));
  expect(await screen.findByText("Another package manager is running")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review package repair" })).toBeNull();
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ControllerDoctor from "./ControllerDoctor";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("offers independent console recovery without running a scan on page load", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ result: { checkedAt: "2026-09-07T12:00:00Z", checks: [{ id: "space", title: "Free space", status: "warning", detail: "820 MiB available", next: "Review Storage" }] } })));
  vi.stubGlobal("fetch", request);
  render(<ControllerDoctor />);
  expect(request).not.toHaveBeenCalled();
  expect(screen.getByText(/sudo sh.*boxpilot-doctor/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check BoxPilot installation" }));
  expect(await screen.findByText("1 installation check needs attention")).toBeTruthy();
  expect(screen.getByText("Review Storage")).toBeTruthy();
});
it("keeps an incomplete inspector response from crashing Repair Center", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: {} }))));
  render(<ControllerDoctor />);
  fireEvent.click(screen.getByRole("button", { name: "Check BoxPilot installation" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("incomplete data"));
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DnsCheckPanel from "./DnsCheckPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reply = (result: Record<string, unknown>) => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result }) })));
};
const base = {
  address: "192.168.1.10", answering: true, blocking: true,
  control: { domain: "example.com", addresses: [], error: "ESERVFAIL" },
  probe: { domain: "doubleclick.net", addresses: ["0.0.0.0"], error: null },
};

describe("what the DNS check tells the owner", () => {
  it("does not raise an alarm when the blocking simply lives on the router", async () => {
    // The owner's own case: a blocker on the router answers everything, so this one is idle.
    // Nothing is broken, and showing it as an error sends them to fix a network that works.
    reply({ ...base, resolving: false, intercepted: true, interceptorBlocking: true, reason: "Your network's DNS is being handled somewhere else, and whatever is handling it blocks ads too. Local names for your apps are the one thing it costs you." });
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/DNS is handled elsewhere/)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Local names for your apps/)).toBeTruthy();
  });

  it("does raise one when the interception is breaking lookups", async () => {
    reply({ ...base, resolving: false, intercepted: true, interceptorBlocking: false, reason: "Something between this server and the internet is answering every DNS query itself." });
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/DNS is being intercepted/)).toBeTruthy());
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("says plainly when everything works", async () => {
    reply({ ...base, resolving: true, control: { domain: "example.com", addresses: ["93.184.216.34"], error: null }, intercepted: false, interceptorBlocking: null, reason: null });
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/Devices pointed at/)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cannot be run without an address to run it against", () => {
    render(<DnsCheckPanel csrfToken="csrf" lanAddress={null} />);
    expect((screen.getByText("Check") as HTMLButtonElement).disabled).toBe(true);
  });
});

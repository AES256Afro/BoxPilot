import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DnsCheckPanel from "./DnsCheckPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The panel asks two things: whether the blocker works, and who is using it. They differ. */
const reply = (result: Record<string, unknown>, clients: Record<string, unknown> | null = null) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ result: String(url).includes("dns.blocker.clients") ? clients ?? { available: false, reason: null, platform: null, clients: [], self: 0 } : result }),
  })));
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

describe("whether anything is actually using the blocker", () => {
  const working = {
    address: "192.168.1.10", answering: true, resolving: true, blocking: true, intercepted: false, interceptorBlocking: null, reason: null,
    control: { domain: "example.com", addresses: ["93.184.216.34"], error: null },
    probe: { domain: "doubleclick.net", addresses: ["0.0.0.0"], error: null },
  };

  it("says so when nothing on the network has asked it, and what to do", async () => {
    // Healthy, answering, blocking — and every device still pointed somewhere else. Nothing the
    // blocker can say about itself distinguishes this from working, which is the long evening.
    reply(working, { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true }, clients: [], self: 12 });
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/nothing is using it/)).toBeTruthy());
    expect(screen.getByText(/Point your router's DHCP at/)).toBeTruthy();
    expect(screen.getByText(/only this server's own checks \(12\)/)).toBeTruthy();
  });

  it("counts the devices when there are some", async () => {
    reply(working, { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true }, clients: [{ address: "192.168.1.31", queries: 812 }, { address: "192.168.1.44", queries: 40 }], self: 3 });
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/2 devices using it/)).toBeTruthy());
    expect(screen.getByText(/192\.168\.1\.31 \(812\)/)).toBeTruthy();
  });

  it("says it does not know rather than claiming nobody uses it", async () => {
    // An unreadable log is not evidence of an unused blocker, and saying so would be an invented
    // alarm of exactly the kind this codebase has shipped before.
    reply(working, { available: false, reason: "Could not read Pi-hole's query log.", platform: null, clients: [], self: 0 });
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/not known/)).toBeTruthy());
    expect(screen.queryByText(/nothing is using it/)).toBeNull();
  });

  it("still reports the check when asking who uses it fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("dns.blocker.clients")
      ? Promise.reject(new Error("network"))
      : { ok: true, json: async () => ({ result: working }) })));
    render(<DnsCheckPanel csrfToken="csrf" lanAddress="192.168.1.10" />);
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(screen.getByText(/Devices pointed at/)).toBeTruthy());
  });
});

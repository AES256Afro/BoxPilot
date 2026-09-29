import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkPage from "./NetworkPage";
import { json, mockFetch, now, topology } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("Network page", () => {
  it("puts the verdict and the facts first: gateway, address, resolvers and Tailscale", async () => {
    mockFetch();
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("LAN and tailnet")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Network and DNS" })).toBeTruthy();
    const strip = document.querySelector(".network-strip") as HTMLElement;
    expect(within(strip).getByText("192.168.1.1")).toBeTruthy();
    expect(within(strip).getByText("192.168.1.10")).toBeTruthy();
    expect(within(strip).getByText("94.140.14.49 + 94.140.14.59")).toBeTruthy();
    expect(within(strip).getByText("Connected")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("5 of 5 read · 1 on the LAN · 2 of 3 on the tailnet"));
    // What the page is for waits behind the info toggle.
    expect(screen.getByRole("button", { name: "About Network and DNS" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("says when there is no way out, and when some of the network could not be read", async () => {
    mockFetch({ "/api/v1/network/topology": { ...topology, defaultRoutes: [] } });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect((await screen.findByText("No default route")).closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    cleanup();
    mockFetch({ "/api/v1/network/topology": { ...topology, collectors: { ...topology.collectors, listeners: false } } });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect((await screen.findByText("1 not read")).closest(".ui-chip")?.getAttribute("data-status")).toBe("warning");
  });

  it("lists the ways to reach BoxPilot, and how to trust its certificate, in a sheet", async () => {
    mockFetch();
    render(<NetworkPage csrfToken="csrf" now={now} />);
    const reach = await screen.findByRole("region", { name: "Reach BoxPilot" });
    await within(reach).findByText("https://homebox.lan:8443");
    expect(within(reach).getByText("install certificate")).toBeTruthy();
    expect(within(reach).getByRole("button", { name: "Copy https://homebox.lan:8443" })).toBeTruthy();
    expect(reach.textContent).toContain("tailscale serve --bg http://127.0.0.1:8787");
    fireEvent.click(within(reach).getByRole("button", { name: "Trust the certificate…" }));
    const sheet = await screen.findByRole("dialog", { name: "Trust BoxPilot's certificate" });
    expect(within(sheet).getByText("Firefox")).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: "Download the certificate" }).getAttribute("href")).toBe("/api/v1/tls/ca.crt");
  });

  it("offers LAN access and HTTPS to the owner, each with its tier, staging the owner-only operation", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch({}, staged);
    render(<NetworkPage csrfToken="csrf" now={now} />);
    const toggle = await screen.findByRole("button", { name: "Turn on LAN access" });
    expect(toggle.getAttribute("data-risk")).toBe("medium");
    expect(screen.getByRole("button", { name: "Set up HTTPS on the LAN" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.click(toggle);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["system.web.lan.set"]).toEqual({ parameters: { enabled: true } }));
    cleanup();

    // An operator sees the state but not the owner's switches.
    mockFetch();
    render(<NetworkPage csrfToken="csrf" role="operator" now={now} />);
    await screen.findByRole("region", { name: "LAN access" });
    expect(screen.queryByRole("button", { name: "Turn on LAN access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up HTTPS on the LAN" })).toBeNull();
  });

  it("wakes a device on the LAN with a low-risk operation", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch({}, staged);
    render(<NetworkPage csrfToken="csrf" now={now} />);
    const devices = await screen.findByRole("region", { name: "Devices on your LAN" });
    expect(await within(devices).findByText("aa:bb:cc:dd:ee:ff")).toBeTruthy();
    const wake = within(devices).getByRole("button", { name: "Wake 192.168.1.50" });
    expect(wake.getAttribute("data-risk")).toBe("low");
    fireEvent.click(wake);
    expect(await screen.findByText("Low risk")).toBeTruthy();
    await waitFor(() => expect(staged["network.wake"]).toEqual({ parameters: { mac: "aa:bb:cc:dd:ee:ff" } }));
  });

  it("opens a tab from the address, and keeps the chosen tab in it", async () => {
    window.history.replaceState(null, "", "/?view=network&tab=tailnet");
    mockFetch();
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect(screen.getByRole("tab", { name: /Tailnet/ }).getAttribute("aria-selected")).toBe("true");
    const devices = await screen.findByRole("table", { name: "Every device on your tailnet" });
    expect(within(devices).getByText("this server")).toBeTruthy();
    expect(within(devices).getByText("last seen 3 hours ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Names & DNS/ }));
    expect(window.location.search).toBe("?view=network&tab=dns");
  });

  it("says what failed when the topology cannot be read, and offers to try again", async () => {
    mockFetch({ "/api/v1/network/topology": json({ error: "The helper is not answering" }, 503) });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect((await screen.findByRole("alert")).textContent).toContain("The helper is not answering");
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not take a reply of another shape for a network", async () => {
    mockFetch({ "/api/v1/network/topology": { status: "ok" } });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect((await screen.findByRole("alert")).textContent).toContain("shape this page cannot read");
  });
});

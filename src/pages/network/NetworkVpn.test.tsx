import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkPage from "./NetworkPage";
import { mockFetch, now } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const route = "/api/v1/settings/vpn-profile";
const lists = { providers: ["mullvad", "protonvpn"], protocols: ["wireguard", "openvpn"] };
const saved = { configured: true, provider: "mullvad", type: "wireguard", wireguardAddresses: "10.64.222.21/32", countries: "Sweden", portForwarding: "off", dot: "on", blockMalicious: "on", blockAds: "on", blockSurveillance: "off", dnsAddress: "", outboundSubnets: "192.168.0.0/16", hasWireguardKey: true, hasOpenvpnPassword: false, updatedAt: "2026-08-14T12:00:00.000Z" };

function openVpn(profile: unknown, staged: Record<string, unknown> = {}, role = "owner") {
  window.history.replaceState(null, "", "/?view=network&tab=vpn");
  const fetchMock = mockFetch({ [route]: { profile, ...lists } }, staged);
  render(<NetworkPage csrfToken="csrf" role={role} now={now} />);
  return fetchMock;
}

describe("the Network page's VPN tab", () => {
  it("shows the saved profile without its key, and what it blocks", async () => {
    openVpn(saved);
    const panel = await screen.findByRole("region", { name: "VPN profile" });
    expect(await within(panel).findByText("Stored")).toBeTruthy();
    expect(within(panel).getByText("Sweden")).toBeTruthy();
    expect(within(panel).getByText("Block ads")).toBeTruthy();
    expect(within(panel).queryByText("Block trackers")).toBeNull();
    expect(within(panel).getByText("2 days ago")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Remove" }).getAttribute("data-risk")).toBe("medium");
  });

  it("changes the profile in a sheet, keeping the stored key unless a new one is typed", async () => {
    const staged: Record<string, unknown> = {};
    openVpn(saved, staged);
    fireEvent.click(await screen.findByRole("button", { name: "Change…" }));
    const sheet = await screen.findByRole("dialog", { name: "Change the VPN profile" });
    expect((within(sheet).getByLabelText(/WireGuard private key/) as HTMLInputElement).value).toBe("");
    fireEvent.change(within(sheet).getByLabelText(/Preferred countries/), { target: { value: "Netherlands" } });
    fireEvent.click(within(sheet).getByLabelText("Block trackers"));
    const save = within(sheet).getByRole("button", { name: "Save profile" });
    expect(save.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(save);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["vpn.profile.set"]).toMatchObject({ parameters: { provider: "mullvad", type: "wireguard", countries: "Netherlands", blockSurveillance: "on", dot: "on" } }));
    expect((staged["vpn.profile.set"] as { parameters: Record<string, string> }).parameters.wireguardPrivateKey).toBeUndefined();
  });

  it("will not save a new WireGuard profile without its key", async () => {
    openVpn({ configured: false });
    fireEvent.click(await screen.findByRole("button", { name: "Set up a VPN profile…" }));
    const sheet = await screen.findByRole("dialog", { name: "Set up a VPN profile" });
    const save = within(sheet).getByRole("button", { name: "Save profile" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText(/WireGuard private key/), { target: { value: "placeholder-key" } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("is the owner's alone: anyone else is told so, and the profile is not asked for", async () => {
    const fetchMock = openVpn(saved, {}, "operator");
    expect(await screen.findByText("The VPN profile is the owner's")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === route)).toBe(false);
  });
});

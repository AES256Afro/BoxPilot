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

  // The sheet closed before the approval opened, and the finished job emptied the key: a cancelled
  // approval or a failed save left nothing of what was typed.
  it("puts the sheet back as it was filled in, key and all, when the save is cancelled or fails", async () => {
    window.history.replaceState(null, "", "/?view=network&tab=vpn");
    mockFetch({
      [route]: { profile: { configured: false }, ...lists },
      "/api/v1/jobs/job-vpn.profile.set/approve": () => new Response(JSON.stringify({ job: { id: "job-vpn.profile.set", state: "applying" }, elevatedUntil: null }), { status: 202, headers: { "Content-Type": "application/json" } }),
      "/api/v1/jobs/job-vpn.profile.set": () => new Response(JSON.stringify({ job: { id: "job-vpn.profile.set", type: "op:vpn.profile.set", title: "Save the VPN profile", state: "failed", risk: "medium", error: "The provider refused the key", result: {}, steps: [], approvals: [] } }), { headers: { "Content-Type": "application/json" } }),
      "/api/v1/jobs/job-vpn.profile.set/output": { jobId: "job-vpn.profile.set", state: "failed", output: "", live: false },
    });
    render(<NetworkPage csrfToken="csrf" role="owner" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up a VPN profile…" }));
    let sheet = await screen.findByRole("dialog", { name: "Set up a VPN profile" });
    fireEvent.change(within(sheet).getByLabelText(/WireGuard private key/), { target: { value: "placeholder-key" } });
    fireEvent.change(within(sheet).getByLabelText(/Preferred countries/), { target: { value: "Netherlands" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    sheet = await screen.findByRole("dialog", { name: "Set up a VPN profile" });
    expect((within(sheet).getByLabelText(/WireGuard private key/) as HTMLInputElement).value).toBe("placeholder-key");
    expect((within(sheet).getByLabelText(/Preferred countries/) as HTMLInputElement).value).toBe("Netherlands");
    // Approved, and the job fails: the same again.
    fireEvent.click(within(sheet).getByRole("button", { name: "Save profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }, { timeout: 4000 }));
    sheet = await screen.findByRole("dialog", { name: "Set up a VPN profile" });
    expect((within(sheet).getByLabelText(/WireGuard private key/) as HTMLInputElement).value).toBe("placeholder-key");
    expect((within(sheet).getByLabelText(/Preferred countries/) as HTMLInputElement).value).toBe("Netherlands");
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

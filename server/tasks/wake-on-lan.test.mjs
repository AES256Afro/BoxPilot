import { describe, expect, it, vi } from "vitest";
import { appliedLinkFile, defaultLinkSettings, inspectWakeOnLan, linkFileFor, linkSettings, parseEthtoolWake, parseProperties, renderLinkFile, wakeOnLanSet } from "./wake-on-lan.mjs";

const defaultLink = "# SPDX-License-Identifier: MIT-0\n[Match]\nOriginalName=*\n\n[Link]\nNamePolicy=keep kernel database onboard slot path\nAlternativeNamesPolicy=database onboard slot path\nMACAddressPolicy=persistent\n";
const netplanLink = "[Match]\nPermanentMACAddress=02:00:00:00:00:02\n\n[Link]\nName=eth0\nWakeOnLan=off\n";

/**
 * A server in memory: its /sys/class/net, what ethtool says and remembers, which .link file udev
 * applied at boot and which it would apply now (the first by name among those that exist).
 */
function server({ ports = { enp5s0: { mac: "02:00:00:00:00:01", driver: "r8169", supports: "pumbg" } }, wifi = [], virtual = ["docker0"], bootLink = "/usr/lib/systemd/network/99-default.link", runtimeLinks = ["/usr/lib/systemd/network/99-default.link"], ethtool = true } = {}) {
  const files = { "/usr/lib/systemd/network/99-default.link": defaultLink, "/run/systemd/network/10-netplan-enp5s0.link": netplanLink };
  const wake = Object.fromEntries(Object.keys(ports).map((name) => [name, "d"]));
  const calls = [];
  const winner = () => [...runtimeLinks, ...Object.keys(files).filter((file) => file.startsWith("/etc/systemd/network/"))].sort((a, b) => a.split("/").at(-1).localeCompare(b.split("/").at(-1)))[0];
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").at(-1);
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "ethtool") {
      if (!ethtool) return { ok: false, code: null, stdout: "", stderr: "spawn ENOENT" };
      if (args[0] === "--version") return { ok: true, stdout: "ethtool version 6.7", stderr: "" };
      if (args[0] === "-s") { wake[args[1]] = args[3]; return { ok: true, stdout: "", stderr: "" }; }
      return { ok: true, stdout: `Settings for ${args[0]}:\n\tSupports Wake-on: ${ports[args[0]].supports}\n\tWake-on: ${wake[args[0]]}\n`, stderr: "" };
    }
    if (name === "udevadm" && args[0] === "info") return { ok: true, stdout: `INTERFACE=${args.at(-1).split("/").at(-1)}\nID_NET_LINK_FILE=${bootLink}\nID_NET_NAME=enp5s0`, stderr: "" };
    if (name === "udevadm" && args[0] === "test-builtin") return { ok: true, stdout: `ID_NET_LINK_FILE=${winner()}`, stderr: `enp5s0: Config file ${winner()} is applied\nenp5s0: Using static MAC address.` };
    return { ok: true, stdout: "", stderr: "" };
  });
  const sysfs = {};
  for (const [name, port] of Object.entries(ports)) Object.assign(sysfs, { [`/sys/class/net/${name}/type`]: "1\n", [`/sys/class/net/${name}/address`]: `${port.mac}\n`, [`/sys/class/net/${name}/operstate`]: "up\n" });
  for (const name of [...wifi, ...virtual]) Object.assign(sysfs, { [`/sys/class/net/${name}/type`]: "1\n", [`/sys/class/net/${name}/address`]: "02:00:00:00:00:09\n" });
  const readText = async (file) => sysfs[file] ?? files[file] ?? null;
  const list = async (directory) => {
    if (directory === "/sys/class/net") return ["lo", ...Object.keys(ports), ...wifi, ...virtual];
    if (wifi.some((name) => directory === `/sys/class/net/${name}/wireless`)) return [];
    throw new Error("ENOENT");
  };
  const link = async (file) => {
    const match = /^\/sys\/class\/net\/([^/]+)\/device(\/driver)?$/.exec(file);
    if (match && (ports[match[1]] || wifi.includes(match[1]))) return match[2] ? `../../bus/pci/drivers/${ports[match[1]]?.driver ?? "iwlwifi"}` : "../../0000:05:00.0";
    throw new Error("ENOENT");
  };
  const inspect = ({ run: runner }) => inspectWakeOnLan({ run: runner, readText, list, link });
  const fileSystem = { readText, writeFile: vi.fn(async (file, content) => { files[file] = content; }), remove: vi.fn(async (file) => { delete files[file]; }) };
  return { run, calls, files, wake, inspect, fileSystem };
}

describe("reading a port's wake-on and link files", () => {
  it("parses ethtool, udev's properties and which file udev applied", () => {
    expect(parseEthtoolWake("Settings for eth0:\n\tSupports Wake-on: pumbg\n\tWake-on: g\n")).toEqual({ supports: "pumbg", current: "g", supportsMagic: true, magicOn: true });
    expect(parseEthtoolWake("\tSupports Wake-on: d\n\tWake-on: d\n")).toMatchObject({ supportsMagic: false, magicOn: false });
    expect(parseEthtoolWake("Cannot get wake-on-lan settings: Operation not permitted")).toMatchObject({ supports: null, supportsMagic: false });
    expect(parseProperties("INTERFACE=eth0\nID_NET_LINK_FILE=/usr/lib/systemd/network/99-default.link\n")).toMatchObject({ ID_NET_LINK_FILE: "/usr/lib/systemd/network/99-default.link" });
    // As systemd 255 (24.04) and 259 (26.04) print it.
    expect(appliedLinkFile("eth0: Config file /run/systemd/network/10-netplan-eth0.link is applied\neth0: Could not set WakeOnLan to off, ignoring")).toBe("/run/systemd/network/10-netplan-eth0.link");
    expect(appliedLinkFile("ID_NET_LINK_FILE=/usr/lib/systemd/network/99-default.link\nID_NET_LINK_FILE_DROPINS (removed)")).toBe("/usr/lib/systemd/network/99-default.link");
  });

  it("copies the [Link] settings of the file that applies, without its WakeOnLan", () => {
    expect(linkSettings(defaultLink)).toEqual([...defaultLinkSettings]);
    expect(linkSettings(netplanLink)).toEqual(["Name=eth0"]);
    const file = renderLinkFile({ name: "enp5s0", mac: "02:00:00:00:00:01", source: "/usr/lib/systemd/network/99-default.link" });
    expect(file).toContain("[Match]\nMACAddress=02:00:00:00:00:01\n\n[Link]\nNamePolicy=keep kernel database onboard slot path\nAlternativeNamesPolicy=database onboard slot path\nMACAddressPolicy=persistent\nWakeOnLan=magic\n");
    expect(file.startsWith("# Managed by BoxPilot")).toBe(true);
    expect(() => renderLinkFile({ name: "bad name", mac: "02:00:00:00:00:01" })).toThrow("Invalid");
    expect(linkFileFor("enp5s0")).toBe("/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link");
  });

  it("lists wired ports with a device behind them, not Wi-Fi, bridges or loopback", async () => {
    const host = server({ wifi: ["wlp2s0"] });
    const found = await host.inspect({ run: host.run });
    expect(found).toEqual({ ethtool: true, ports: [{ name: "enp5s0", mac: "02:00:00:00:00:01", driver: "r8169", up: true, supports: "pumbg", current: "d", supportsMagic: true, magicOn: false, linkFile: "/usr/lib/systemd/network/99-default.link", keptByBoxPilot: false }] });
  });

  it("says when ethtool is missing rather than calling every port unable to wake", async () => {
    const host = server({ ethtool: false });
    await expect(host.inspect({ run: host.run })).resolves.toMatchObject({ ethtool: false, ports: [{ name: "enp5s0", supports: null }] });
  });
});

describe("turning Wake-on-LAN on and off", () => {
  it("writes BoxPilot's file, has udev confirm it applies, and turns wake-on on now", async () => {
    const host = server();
    const result = await wakeOnLanSet({ interface: "enp5s0", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem });
    expect(result).toEqual({ interface: "enp5s0", enabled: true, mac: "02:00:00:00:00:01", wakeOn: "g", linkFile: "/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link" });
    expect(host.files["/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link"]).toContain("WakeOnLan=magic");
    const order = (call) => host.calls.indexOf(call);
    expect(order("udevadm control --reload")).toBeLessThan(order("udevadm test-builtin net_setup_link /sys/class/net/enp5s0"));
    expect(order("ethtool -s enp5s0 wol g")).toBeGreaterThan(order("udevadm test-builtin net_setup_link /sys/class/net/enp5s0"));
  });

  it("refuses a port netplan's file decides, before writing, when udev said so at boot", async () => {
    const host = server({ bootLink: "/run/systemd/network/10-netplan-enp5s0.link", runtimeLinks: ["/run/systemd/network/10-netplan-enp5s0.link"] });
    await expect(wakeOnLanSet({ interface: "enp5s0", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem })).rejects.toThrow('It is netplan\'s: add "wakeonlan: true"');
    expect(host.fileSystem.writeFile).not.toHaveBeenCalled();
  });

  it("undoes its file when netplan's, generated since boot, is the one udev applies now", async () => {
    // The runners' case: udev applied systemd's default at boot, and cloud-init's netplan file since.
    const host = server({ runtimeLinks: ["/run/systemd/network/10-netplan-enp5s0.link", "/usr/lib/systemd/network/99-default.link"] });
    await expect(wakeOnLanSet({ interface: "enp5s0", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem })).rejects.toThrow("/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link was removed again");
    expect(host.files["/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link"]).toBeUndefined();
    expect(host.wake.enp5s0).toBe("d");
    expect(host.calls.filter((call) => call.startsWith("udevadm test-builtin"))).toHaveLength(2);
  });

  it("refuses a port that cannot wake on a magic packet, one that is not there, and a file it did not write", async () => {
    const unable = server({ ports: { enp5s0: { mac: "02:00:00:00:00:01", driver: "mlx5_core", supports: "d" } } });
    await expect(wakeOnLanSet({ interface: "enp5s0", enabled: true }, { run: unable.run, inspect: unable.inspect, files: unable.fileSystem })).rejects.toThrow("cannot wake on a magic packet (ethtool says Supports Wake-on: d)");
    const host = server();
    await expect(wakeOnLanSet({ interface: "eth9", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem })).rejects.toThrow("is not a wired network port");
    await expect(wakeOnLanSet({ interface: "docker0", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem })).rejects.toThrow("is not a wired network port");
    host.files["/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link"] = "[Match]\nMACAddress=02:00:00:00:00:01\n";
    await expect(wakeOnLanSet({ interface: "enp5s0", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem })).rejects.toThrow("was not written by BoxPilot");
    await expect(wakeOnLanSet({ interface: "../etc", enabled: true })).rejects.toThrow("network port name");
  });

  it("turns it off: the file removed and wake-on cleared", async () => {
    const host = server();
    await wakeOnLanSet({ interface: "enp5s0", enabled: true }, { run: host.run, inspect: host.inspect, files: host.fileSystem });
    const result = await wakeOnLanSet({ interface: "enp5s0", enabled: false }, { run: host.run, inspect: host.inspect, files: host.fileSystem });
    expect(result).toEqual({ interface: "enp5s0", enabled: false, wakeOn: "d", removed: true });
    expect(host.files["/etc/systemd/network/50-boxpilot-wake-on-lan-enp5s0.link"]).toBeUndefined();
  });
});

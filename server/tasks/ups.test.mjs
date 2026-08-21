import { describe, expect, it, vi } from "vitest";
import { renderNutConfig, upsSetup, validateUpsSetup } from "./ups.mjs";
import { classifyUsbDevice, detectUsbUps } from "../ups-detect.mjs";

function fakeRun({ driverFails = false, statusAfter = 1 } = {}) {
  let probes = 0;
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("upsdrvctl")) return driverFails ? { ok: false, stdout: "", stderr: "Driver failed to start (exit status=1)" } : { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("upsc")) { probes += 1; return probes >= statusAfter ? { ok: true, stdout: "battery.charge: 97\nups.model: Back-UPS ES 700G\nups.status: OL CHRG\n", stderr: "" } : { ok: false, stdout: "", stderr: "Error: Connection failure" }; }
    if (args[0] === "-l") return { ok: true, stdout: "ups\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}
function fakeFiles(existing = {}) {
  const state = { files: { ...existing }, copies: [] };
  return {
    state,
    readFile: vi.fn(async (path) => { if (path in state.files) return state.files[path]; throw new Error("ENOENT"); }),
    writeFile: vi.fn(async (path, content, options) => { state.files[path] = content; state.files[`${path}#mode`] = options?.mode; }),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async (from, to) => { state.copies.push(to); }),
    chmod: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
  };
}

describe("UPS detection", () => {
  it("recognises UPS makers by USB vendor id and by name, ignoring everything else", () => {
    expect(classifyUsbDevice({ idVendor: "051d", idProduct: "0002", manufacturer: "American Power Conversion", product: "Back-UPS ES 700G FW:871.O4 .I USB FW:O4" })).toMatchObject({ driver: "usbhid-ups", confidence: "vendor-id", manufacturer: "American Power Conversion" });
    expect(classifyUsbDevice({ idVendor: "0665", idProduct: "5161", manufacturer: null, product: null })).toMatchObject({ driver: "nutdrv_qx", manufacturer: "PowerWalker / BlueWalker" });
    expect(classifyUsbDevice({ idVendor: "abcd", idProduct: "0001", manufacturer: "Acme", product: "Smart-UPS clone" })).toMatchObject({ driver: "usbhid-ups", confidence: "name" });
    expect(classifyUsbDevice({ idVendor: "03f0", idProduct: "134a", manufacturer: "PixArt", product: "HP USB Optical Mouse" })).toBeNull();
  });

  it("walks sysfs and lists only UPS devices", async () => {
    const tree = {
      "/sys/bus/usb/devices/1-2/idVendor": "0764", "/sys/bus/usb/devices/1-2/idProduct": "0501", "/sys/bus/usb/devices/1-2/product": "CP1500PFCLCD",
      "/sys/bus/usb/devices/1-3/idVendor": "03f0", "/sys/bus/usb/devices/1-3/idProduct": "134a", "/sys/bus/usb/devices/1-3/product": "HP USB Optical Mouse",
    };
    const found = await detectUsbUps({ list: async () => ["1-2", "1-3", "usb1"], read: async (file) => { if (file in tree) return `${tree[file]}\n`; throw new Error("ENOENT"); } });
    expect(found).toEqual([{ vendorId: "0764", productId: "0501", manufacturer: "CyberPower", product: "CP1500PFCLCD", driver: "usbhid-ups", confidence: "vendor-id", sysfs: "1-2" }]);
  });
});

describe("UPS setup task", () => {
  it("validates and renders a standalone NUT configuration bound to loopback", () => {
    expect(validateUpsSetup({})).toBeNull();
    expect(validateUpsSetup({ driver: "magic" })).toContain("driver");
    expect(validateUpsSetup({ vendorId: "zz" })).toContain("vendorId");
    const files = renderNutConfig({ name: "ups", driver: "usbhid-ups", vendorId: "051d", description: "APC Back-UPS", monitorPassword: "pw123" });
    expect(files["nut.conf"]).toContain("MODE=standalone");
    expect(files["ups.conf"]).toContain("[ups]\n\tdriver = usbhid-ups\n\tport = auto\n\tvendorid = 051d\n\tdesc = \"APC Back-UPS\"");
    expect(files["upsd.conf"]).toContain("LISTEN 127.0.0.1 3493");
    expect(files["upsd.users"]).toContain("[upsmon]\n\tpassword = pw123\n\tupsmon primary");
    expect(files["upsmon.conf"]).toContain("MONITOR ups@localhost 1 upsmon pw123 primary");
    expect(files["upsmon.conf"]).toContain('SHUTDOWNCMD "/sbin/shutdown -h +0"');
    expect(renderNutConfig({ monitorPassword: "x", shutdownAtLowBattery: false })["upsmon.conf"]).toContain('SHUTDOWNCMD "/bin/true"');
  });

  it("writes the files with safe modes, keeps originals, starts the driver and services, and verifies a status", async () => {
    const files = fakeFiles({ "/etc/nut/nut.conf": "MODE=none\n" });
    const run = fakeRun({ statusAfter: 2 });
    const result = await upsSetup({ name: "ups", driver: "usbhid-ups", vendorId: "051d", description: "APC" }, { run, files, secret: () => "generated-pw", wait: async () => {} });
    expect(result).toMatchObject({ configured: true, name: "ups", status: "OL CHRG", batteryChargePercent: 97, model: "Back-UPS ES 700G" });
    expect(files.state.copies).toEqual(["/etc/nut/nut.conf.before-boxpilot"]);
    expect(files.state.files["/etc/nut/upsd.users#mode"]).toBe(0o640);
    expect(files.state.files["/etc/nut/upsmon.conf"]).toContain("generated-pw");
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain("upsdrvctl start");
    expect(calls).toContain("systemctl restart nut-server");
    expect(calls).toContain("systemctl restart nut-monitor");
    expect(calls.filter((call) => call === "upsc ups@localhost")).toHaveLength(2);
  });

  it("fails clearly when the driver cannot start or NUT is missing", async () => {
    await expect(upsSetup({}, { run: fakeRun({ driverFails: true }), files: fakeFiles(), secret: () => "x", wait: async () => {} })).rejects.toThrow("plugged into USB");
    const missing = fakeFiles();
    missing.access = vi.fn(async () => { throw new Error("ENOENT"); });
    await expect(upsSetup({}, { run: fakeRun(), files: missing })).rejects.toThrow("not installed");
  });
});

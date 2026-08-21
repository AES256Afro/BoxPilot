/**
 * Find a UPS on USB without privileges: every USB device exposes idVendor/idProduct (and
 * usually manufacturer/product) under /sys/bus/usb/devices. Matching is by vendor id against
 * the makers NUT's usbhid-ups and nutdrv_qx drivers support, so the setup task can pick the
 * driver without the owner knowing what NUT is.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const knownUpsVendors = Object.freeze({
  "051d": { maker: "APC", driver: "usbhid-ups" },
  "0764": { maker: "CyberPower", driver: "usbhid-ups" },
  "0463": { maker: "Eaton / MGE", driver: "usbhid-ups" },
  "09ae": { maker: "Tripp Lite", driver: "usbhid-ups" },
  "050d": { maker: "Belkin", driver: "usbhid-ups" },
  "10af": { maker: "Liebert / Vertiv", driver: "usbhid-ups" },
  "06da": { maker: "Phoenixtec / Liebert", driver: "usbhid-ups" },
  "0d9f": { maker: "Powercom", driver: "usbhid-ups" },
  "2341": { maker: "Salicru", driver: "usbhid-ups" },
  "0665": { maker: "PowerWalker / BlueWalker", driver: "nutdrv_qx" },
  "0001": { maker: "Megatec-compatible", driver: "nutdrv_qx" },
  "04b4": { maker: "Riello / generic Cypress", driver: "nutdrv_qx" },
  "04d8": { maker: "Riello (Microchip)", driver: "riello_usb" },
  "0925": { maker: "Lakeview / generic", driver: "nutdrv_qx" },
});

export function classifyUsbDevice({ idVendor, idProduct, manufacturer = null, product = null }) {
  const vendor = String(idVendor ?? "").toLowerCase();
  const known = knownUpsVendors[vendor];
  const looksLikeUps = /ups|uninterruptible|back-?ups|smart-?ups|power ?walker|cyber ?power|eaton|tripp/i.test(`${manufacturer ?? ""} ${product ?? ""}`);
  if (!known && !looksLikeUps) return null;
  return {
    vendorId: vendor,
    productId: String(idProduct ?? "").toLowerCase(),
    manufacturer: manufacturer?.trim() || known?.maker || null,
    product: product?.trim() || null,
    driver: known?.driver ?? "usbhid-ups",
    confidence: known ? "vendor-id" : "name",
  };
}

export async function detectUsbUps({ sysfsRoot = "/sys/bus/usb/devices", list = readdir, read = (file) => readFile(file, "utf8") } = {}) {
  let entries = [];
  try { entries = await list(sysfsRoot); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    const base = path.join(sysfsRoot, entry);
    const attribute = async (name) => read(path.join(base, name)).then((text) => text.trim(), () => null);
    const idVendor = await attribute("idVendor");
    if (!idVendor) continue;
    const device = classifyUsbDevice({ idVendor, idProduct: await attribute("idProduct"), manufacturer: await attribute("manufacturer"), product: await attribute("product") });
    if (device) found.push({ ...device, sysfs: entry });
  }
  return found;
}

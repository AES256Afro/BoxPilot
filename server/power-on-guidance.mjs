/**
 * Power back on after an outage (M39.6): what to change in the firmware so the server starts by
 * itself when the power comes back. BoxPilot cannot change the firmware, so this is words: the
 * setting, where each common maker puts it, and why "last state" is not enough.
 *
 * `powerOnGuidance()` is the hook the power-loss notice calls (it says the server lost power and
 * was off for a while; this says how to make it come back by itself). It is pure: pass the board's
 * maker as the kernel reports it (readBoardVendor, from /sys/class/dmi/id) and the steps for that
 * maker come first; without one, every maker's steps are there.
 */
import { readFile } from "node:fs/promises";

/**
 * Where the setting lives, by maker. Menu names drift between firmware versions, so each says
 * "usually" in the words around it; the setting's own name is what to look for.
 */
export const firmwarePaths = Object.freeze([
  { id: "asus", maker: "ASUS", key: "Del or F2", path: ["Advanced", "APM Configuration", "Restore AC Power Loss"], value: "Power On", match: /asus/i },
  { id: "msi", maker: "MSI", key: "Del", path: ["Settings", "Advanced", "Power Management Setup", "Restore after AC Power Loss"], value: "Power On", match: /micro-star|\bmsi\b/i },
  { id: "gigabyte", maker: "Gigabyte", key: "Del", path: ["Settings", "Platform Power", "AC BACK"], value: "Always On", match: /gigabyte/i },
  { id: "asrock", maker: "ASRock", key: "F2 or Del", path: ["Advanced", "Chipset Configuration", "Restore On AC/Power Loss"], value: "Power On", match: /asrock/i },
  { id: "dell", maker: "Dell", key: "F2", path: ["Power Management", "AC Recovery"], value: "Power On", match: /\bdell\b/i },
  { id: "hp", maker: "HP", key: "F10", path: ["Advanced", "Power-On Options", "After Power Loss"], value: "Power On", match: /\bhp\b|hewlett/i },
  { id: "lenovo", maker: "Lenovo", key: "F1", path: ["Power", "After Power Loss"], value: "Power On", match: /lenovo/i },
  { id: "intel", maker: "Intel NUC", key: "F2", path: ["Power", "Secondary Power Settings", "After Power Failure"], value: "Power On", match: /^intel/i },
]);

/** The maker a DMI vendor string names ("ASUSTeK COMPUTER INC." is asus), or null. */
export function makerOf(vendor) {
  const text = String(vendor ?? "").trim();
  if (!text) return null;
  return firmwarePaths.find((entry) => entry.match.test(text))?.id ?? null;
}

/** One maker's step as a sentence: "ASUS: press Del or F2 while it starts, then Advanced › … › Restore AC Power Loss, and choose Power On." */
export function stepFor(entry) {
  return `${entry.maker}: press ${entry.key} while it starts, then ${entry.path.join(" › ")}, and choose ${entry.value}.`;
}

/**
 * The guidance: a title, why it matters, the steps (this board's maker first when it is known),
 * and what else helps. Plain words for whoever is standing at the server with a keyboard.
 */
export function powerOnGuidance({ boardVendor = null, upsConfigured = false } = {}) {
  const maker = makerOf(boardVendor);
  const ordered = maker ? [...firmwarePaths.filter((entry) => entry.id === maker), ...firmwarePaths.filter((entry) => entry.id !== maker)] : [...firmwarePaths];
  return {
    id: "power-on-after-outage",
    title: "Make the server start by itself when the power comes back",
    summary: "Most boards stay off after a power cut until someone presses the button. One firmware setting changes that: set what happens after AC power loss to Power On (Gigabyte calls it Always On).",
    why: [
      "\"Last State\" is not enough: after a clean shutdown, the last state is off, so the server stays off.",
      upsConfigured
        ? "With the UPS, BoxPilot shuts the server down when the battery runs low and the UPS then switches its outlets off. When the mains returns the UPS switches them on again, and this setting is what starts the server."
        : "With a UPS, the server shuts down cleanly before the battery runs out; this setting is what starts it again once the power is back.",
    ],
    board: boardVendor ? { vendor: String(boardVendor).trim().slice(0, 80), maker } : null,
    steps: ordered.map((entry) => ({ maker: entry.maker, id: entry.id, key: entry.key, path: [...entry.path], value: entry.value, text: stepFor(entry), thisBoard: entry.id === maker })),
    other: "Another maker: look under Power, Power Management, APM or Chipset for \"AC power loss\", \"power failure\" or \"AC back\", choose Power On, then save and exit (usually F10).",
    alsoHelps: "Wake-on-LAN lets another device on your network start the server after a clean shutdown. It usually needs \"ErP\" or \"Deep Sleep\" turned off in the same firmware, and it rarely works after the power was cut outright.",
  };
}

/** The board's maker as the firmware reports it. Readable by any user; null when there is none (a VM, a board that leaves it blank). */
export async function readBoardVendor({ read = (file) => readFile(file, "utf8") } = {}) {
  for (const file of ["/sys/class/dmi/id/board_vendor", "/sys/class/dmi/id/sys_vendor"]) {
    const value = await read(file).then((text) => text.trim(), () => "");
    if (value && !/^(to be filled|default string|system manufacturer|o\.e\.m\.?)/i.test(value)) return value.slice(0, 80);
  }
  return null;
}

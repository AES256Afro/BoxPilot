import { fixedRun } from "../exec.mjs";
import { readBoardVendor } from "../power-on-guidance.mjs";
import { inspectWakeOnLan } from "./wake-on-lan.mjs";
import { inspectWatchdog } from "./watchdog.mjs";

/**
 * The power panel's root-side read (M39.4, M39.6): the hardware watchdog and each wired network
 * port's Wake-on-LAN, which need the kernel's module list and ethtool, and the board's maker for
 * the firmware guidance. Reads only; nothing is loaded, written or applied.
 */
export async function powerHardware(_parameters = {}, { run = fixedRun, watchdog = inspectWatchdog, wake = inspectWakeOnLan, board = readBoardVendor } = {}) {
  const [watchdogResult, wakeResult, vendor] = await Promise.all([
    watchdog({ run }).catch((error) => ({ state: "unreadable", usable: false, error: error.message })),
    wake({ run }).catch((error) => ({ ethtool: false, ports: [], error: error.message })),
    board().catch(() => null),
  ]);
  return { watchdog: watchdogResult, wakeOnLan: wakeResult, boardVendor: vendor };
}

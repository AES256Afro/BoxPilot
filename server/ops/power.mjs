import { defineOperation } from "./registry.mjs";
import { interfacePattern } from "../tasks/wake-on-lan.mjs";
import { rebootWatchdogSeconds, runtimeLimits } from "../tasks/watchdog.mjs";

const minutes = (value) => value * 60_000;

/**
 * Keeping the house running when the server does not (M39): the hardware watchdog (M39.4) and
 * Wake-on-LAN for the server's own port (M39.6). The UPS has its own module (ups.mjs).
 */
export function powerOperations() {
  return [
    defineOperation({
      // operator (ADR-003): it runs as root and reads what nobody else can, the wake-on setting
      // (ethtool needs CAP_NET_ADMIN) and the kernel's module list.
      id: "power.hardware.inspect", title: "Read the watchdog and Wake-on-LAN", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: minutes(1),
      description: "Whether this board has a hardware watchdog and whether it is on, whether this is a virtual machine, each wired network port's hardware address and Wake-on-LAN, and the board's maker. Read-only; nothing is loaded or changed.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("power.hardware", {}, { timeoutMs: 45_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "power.watchdog.enable", title: "Turn on the hardware watchdog", risk: "medium", timeoutMs: minutes(3),
      description: `From now on, if the server freezes it restarts by itself: systemd tells the board's watchdog timer every few seconds that all is well, and when that stops for the time chosen (${runtimeLimits.default} seconds unless you pick another), the board resets. Writes /etc/systemd/system.conf.d/90-boxpilot-watchdog.conf (RuntimeWatchdogSec, and RebootWatchdogSec=${rebootWatchdogSeconds / 60}min so a hung reboot is cut off too), loads the chipset's watchdog driver when Ubuntu has not (and keeps loading it at boot), reloads systemd and checks with systemctl show and wdctl that the watchdog is running. Refused on a virtual machine and where only the software watchdog exists. Undone if anything does not check out.`,
      parameters: { fields: { runtimeSeconds: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= runtimeLimits.min && value <= runtimeLimits.max ? null : `must be a whole number of seconds from ${runtimeLimits.min} to ${runtimeLimits.max}`) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("power.watchdog.enable", { runtimeSeconds: parameters.runtimeSeconds ?? runtimeLimits.default }, { timeoutMs: 90_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      // Low: it puts the server back as Ubuntu ships it, and nothing restarts or stops.
      id: "power.watchdog.disable", title: "Turn off the hardware watchdog", risk: "low", timeoutMs: minutes(3),
      description: "Removes the files BoxPilot wrote to turn the watchdog on, reloads systemd, and checks that it stopped pinging and the watchdog stopped. A frozen server then stays frozen until someone restarts it. Refused for a watchdog that cannot be stopped once started, which would restart the server instead.",
      parameters: { fields: {} },
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("power.watchdog.disable", {}, { timeoutMs: 90_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "power.wake-on-lan.set", title: "Set Wake-on-LAN for this server", risk: "medium", timeoutMs: minutes(3),
      description: "On: another device on your network (the router, a phone app, another computer) can switch this server on after a clean shutdown by sending a magic packet to the port's hardware address. Writes /etc/systemd/network/50-boxpilot-wake-on-lan-<port>.link with the port's current naming rules and WakeOnLan=magic, checks with udev that it is the file that applies, and turns wake-on on now with ethtool. Off: removes that file and turns wake-on off. The firmware may also need Wake-on-LAN (\"Power On By PCI-E\") on and ErP off; after the power is cut outright most boards cannot be woken.",
      parameters: { fields: { interface: { type: "string", maxLength: 15, pattern: interfacePattern }, enabled: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("power.wake-on-lan.set", { interface: parameters.interface, enabled: parameters.enabled }, { timeoutMs: 90_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}

import type { Status } from "../ui/types";
import type { ChecklistFacts, ServiceFact, SmartDiskFact, SmartFacts, UpsFact } from "./facts";

/*
 * What the Classic overview showed and Home and Ops now do (M33.8): each drive's SMART health, the
 * UPS, the key services and the setup checklist, as a status and the words for it. Pure, so the
 * wording is tested without drawing a page. Nothing here is "good" about a reading that was not
 * made: a drive that could not be read, or a UPS nobody set up, is unknown or neutral.
 */

/** A drive's health in a word and a status. */
export function diskHealth(disk: SmartDiskFact): { status: Status; label: string } {
  if (disk.reason === "usb-bridge-unsupported") return { status: "unknown", label: "no SMART" };
  if (disk.reason === "asleep") return { status: "unknown", label: "asleep, not read" };
  if (disk.health === "healthy") return { status: "good", label: "healthy" };
  if (disk.health === "unavailable" || !disk.health) return { status: "unknown", label: "not read" };
  if (disk.health === "critical" || disk.health === "failing") return { status: "danger", label: disk.health };
  return { status: "warning", label: disk.health };
}

/** One line under a drive: what was read, or why it could not be. */
export function diskDetail(disk: SmartDiskFact): string {
  if (disk.reason === "usb-bridge-unsupported") return "Its USB enclosure does not pass SMART through";
  if (disk.reason === "asleep") return disk.lastHealth ? `Asleep at the last check; last read awake: ${disk.lastHealth}` : "Asleep at the last check, and not yet read awake";
  const parts = [
    disk.temperature === null ? null : `${disk.temperature}°C`,
    disk.wear === null ? null : `${disk.wear}% of its life used`,
    disk.mediaErrors === null ? null : `${disk.mediaErrors} media error${disk.mediaErrors === 1 ? "" : "s"}`,
    disk.viaBridge ? "read through its USB bridge" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No figures reported";
}

/** Disk health as a whole: the panel's count and its words. */
export function smartSummary(smart: SmartFacts | null): { status: Status; label: string } {
  if (!smart) return { status: "unknown", label: "not read" };
  if (!smart.available) return { status: "unknown", label: "not read" };
  const healths = smart.disks.map(diskHealth);
  if (healths.some((health) => health.status === "danger")) return { status: "danger", label: `${healths.filter((health) => health.status === "danger").length} failing` };
  if (healths.some((health) => health.status === "warning")) return { status: "warning", label: `${healths.filter((health) => health.status === "warning").length} to look at` };
  if (smart.stale) return { status: "warning", label: "stale" };
  const good = healths.filter((health) => health.status === "good").length;
  if (healths.length === 0) return { status: "neutral", label: "no drives" };
  return good === healths.length ? { status: "good", label: `${good} healthy` } : { status: "unknown", label: `${good} of ${healths.length} read` };
}

/** Why disk health could not be read at all, in words. */
export function smartUnreadReason(smart: SmartFacts | null): string {
  if (!smart) return "This server did not say how its drives are.";
  if (!smart.readAt) return "No disk health reading yet. Install smartmontools to read it.";
  return `Disk health could not be read${smart.reason ? ` (${smart.reason.replaceAll("-", " ")})` : ""}.`;
}

/** The UPS as a status, a short label, and a headline. */
export function upsSummary(ups: UpsFact | null): { status: Status; label: string; headline: string } {
  if (!ups) return { status: "unknown", label: "not read", headline: "This server did not say whether a UPS is set up" };
  if (ups.state === "low-battery") return { status: "danger", label: "battery low", headline: "The UPS battery is low" };
  if (ups.state === "forced-shutdown") return { status: "danger", label: "shutting down", headline: "The UPS reports a forced shutdown" };
  if (ups.state === "on-battery") return { status: "warning", label: "on battery", headline: "The UPS is on battery: the mains power is off" };
  if (ups.state === "bypass") return { status: "warning", label: "bypass", headline: "The UPS is in bypass: the battery is not protecting this server" };
  if (ups.state === "online") return { status: "good", label: "on mains", headline: "The UPS is on mains power" };
  if (ups.configured && !ups.available) return { status: "warning", label: "not answering", headline: "A UPS is set up but is not answering" };
  if (ups.reason === "nut-client-not-installed") return { status: "neutral", label: "not set up", headline: "No UPS is set up (the NUT client is not installed)" };
  return { status: "neutral", label: "not set up", headline: "No UPS is set up" };
}

/** A key service's state in words: its sub-state while active, "failed", or what systemd says. */
export function serviceState(service: ServiceFact): { status: Status; label: string } {
  if (service.active === "active") return { status: "good", label: service.sub || "active" };
  if (service.active === "failed") return { status: "danger", label: "failed" };
  if (service.active === "activating" || service.active === "deactivating" || service.active === "reloading") return { status: "warning", label: service.active };
  return { status: "neutral", label: service.sub || service.active || "unknown" };
}

/** The setup checklist as a count: how many essentials are in place, and whether any could not be checked. */
export function checklistSummary(checklist: ChecklistFacts | null): { status: Status; label: string } {
  if (!checklist) return { status: "unknown", label: "not read" };
  const essentials = checklist.items.filter((item) => !item.optional);
  const done = essentials.filter((item) => item.done).length;
  const unchecked = essentials.filter((item) => !item.done && item.known === false).length;
  if (essentials.length === 0) return { status: "neutral", label: `${checklist.done}/${checklist.total}` };
  if (done === essentials.length) return { status: "good", label: `${done}/${essentials.length}` };
  return { status: unchecked ? "unknown" : "neutral", label: `${done}/${essentials.length}` };
}

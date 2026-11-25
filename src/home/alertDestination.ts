import { viewLabel, type ViewName } from "../data";

/*
 * Where a watched condition or a piece of news leads (M88): one answer for the bell's "Open …"
 * (src/shell/NotificationCentre.tsx), Home's, Ops' and Today's rows (src/home/needs.ts) and
 * Settings' list of watched conditions. They used to decide it apart and send the same alert to
 * different pages. Each family goes where its own message says the fix is
 * (server/health-alerts.mjs, schedule-freshness.mjs, hosted-domains.mjs, agents/service.mjs).
 */

interface AlertDestination {
  view: ViewName;
  /** The tab on that page the alert is about, when it is about one. */
  tab?: string;
  /** The button's words: "Open Repair". */
  label: string;
}

const to = (view: ViewName, tab?: string, label = `Open ${viewLabel(view)}`): AlertDestination => ({ view, ...(tab ? { tab } : {}), label });

/** The family of a condition or notice key: "storage.mount.full:/mnt/media" is "storage.mount.full". */
const familyOf = (key: string): string => key.split(":")[0];

export function alertDestination(family: string): AlertDestination {
  const name = familyOf(family);
  // "Free space under System, Housekeeping, or grow the disk under Storage."
  if (name === "storage.root.full") return to("system", "housekeeping", "Open Housekeeping");
  // "Storage, Mounts shows what fills it."
  if (name === "storage.mount.full") return to("storage", "mounts", "Open Mounts");
  // "Reconnect it from the Repair page" / "Open Repair to reconnect it".
  if (name === "storage.mount.detached" || name === "storage.mount.readonly") return to("repairs");
  if (name === "drive.reconnected" || name.startsWith("storage.") || name.startsWith("smart.")) return to("storage");
  // "Open the app's Logs tab in Apps."
  if (name.startsWith("docker.")) return to("catalog");
  // "Open Services in BoxPilot"; BoxPilot's own restart is made from Services too (sweep 5).
  if (name === "system.services" || name === "boxpilot.restart") return to("services");
  // "Restart the server from System, Power when convenient." A power cut's advice is a UPS, set up there too.
  if (name === "system.reboot" || name === "power.ups" || name === "power.lost") return to("system", "power", "Open the Power tab");
  // "Check it on the Automations page."
  if (name === "schedule.overdue") return to("automations", "schedules", "Open Schedules");
  if (name === "schedule.failed") return to("system", "schedules", "Open Schedules");
  if (name === "flow.failed") return to("automations");
  if (name === "release.available") return to("system", "updates", "Open the BoxPilot update");
  if (name === "signin.new") return to("settings", "account");
  if (name === "report.weekly") return to("settings", "notifications");
  // Repair has no findings for hosted names or agents: their own pages say what is wrong.
  if (name.startsWith("hosted.")) return to("hosted");
  if (name === "agent.important") return to("agents");
  return to("repairs");
}

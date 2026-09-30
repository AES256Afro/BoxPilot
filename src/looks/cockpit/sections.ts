import { backupOperation, runs, type Need } from "../../home/needs";
import type { Status } from "../../ui";

/*
 * Where a need is said on the cockpit (M41): the memo's section, and the annunciator lamp it lights.
 * A need belongs with its fix (a backup's Back up now is a backup whatever page Repair would send
 * you to) or else with its page.
 */

export type SectionId = "backup" | "updates" | "apps" | "net" | "storage" | "system";

export const sectionTitles: Record<SectionId, string> = { backup: "Backup", updates: "Updates", apps: "Apps", net: "Network", storage: "Storage", system: "System" };

export function sectionOf(need: Need): SectionId {
  const operation = runs(need)?.operationId ?? "";
  if (need.kind === "backup" || backupOperation.test(operation) || need.view === "backups" || need.finding?.id.startsWith("backup")) return "backup";
  if (need.kind === "updates" || need.view === "updates") return "updates";
  if (need.view === "network" || need.view === "firewall") return "net";
  if (need.view === "storage") return "storage";
  if (need.view === "catalog" || need.appId) return "apps";
  return "system";
}

/** The worst of a list of needs, as a status: good when there are none. */
export const worstOf = (list: Need[]): Status => (list.some((need) => need.severity === "danger") ? "danger" : list.some((need) => need.severity === "warning") ? "warning" : "good");

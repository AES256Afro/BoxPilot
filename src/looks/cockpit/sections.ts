import { judgeProtection } from "../../backupProtection";
import type { FactValues } from "../../home/facts";
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

/**
 * A need in the memo's few words, as the ECAM says it ("4 APPS NOT PROTECTED", "4 AVAIL · 1
 * SECURITY", "OPEN WEBUI PAUSED"). The need's own title stays its name for assistive technology and
 * its tooltip; a need with no shorter form is said by its title, cut to the line.
 */
export function terse(need: Need, facts: Pick<FactValues, "catalog" | "updates" | "protection" | "schedules">, now: number): string {
  const app = need.appId ? facts.catalog?.apps.find((entry) => entry.id === need.appId)?.name ?? need.appId : null;
  const kind = need.id.split(":")[0];
  if (need.id === "updates" && facts.updates) return `${facts.updates.count} avail · ${facts.updates.security} security`;
  if (need.id === "reboot") return "Reboot pending";
  if (need.id === "unattended") return "Auto security updates off";
  if (app && kind === "app-down") return `${app} down`;
  if (app && kind === "app-stopped") return `${app} stopped`;
  if (app && kind === "app-paused") return `${app} paused`;
  if (app && kind === "app-update") return `${app} upd ready`;
  if (app && kind === "app-unwell") return `${app} unhealthy`;
  if (app && kind === "app-vpn") return `${app} left its VPN`;
  if (app && kind === "backup-failed") return `${app} backup failed`;
  if ((need.id === "unprotected" || need.finding?.id === "backups-due") && facts.protection) {
    const schedules = (facts.schedules ?? []).map((schedule) => ({ ...schedule, parameters: schedule.parameters ?? undefined }));
    const bare = judgeProtection(facts.protection, schedules, { now }).filter((verdict) => verdict.state !== "ok").length;
    if (bare > 0) return `${bare} ${bare === 1 ? "app" : "apps"} not protected`;
  }
  if (need.id === "database") return "Database backup due";
  if (need.kind === "approval") return need.title.replace(/^Waiting for approval: /, "Approve: ");
  return need.title;
}

import { useMemo } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { judgeProtection, type AppProtection, type ProtectionVerdict } from "../../backupProtection";
import { backupGlance } from "../../home/backupGlance";
import { useFacts, valuesOf, type AppFact, type MountFact } from "../../home/facts";
import { appHealth, buildNeeds, verdictFor, verdictSources, type Need } from "../../home/needs";
import { useCheckAgain } from "../../home/useCheckAgain";
import { useNeedActions } from "../../home/useNeedActions";
import type { HomeProps } from "../../home/Home";
import type { Status } from "../../ui/types";

/*
 * What the Swiss Poster, E-Ink and Transit Map Homes read (M41): the same facts, the same list of
 * what needs you and the same verdict as the Launcher, gathered once so the three drawings differ
 * only in how they draw them. Every fix goes through useNeedActions, so through the approval
 * dialog at its tier.
 */

export interface AppRow {
  app: AppFact;
  health: { status: Status; label: string; detail: string };
  protection: AppProtection | undefined;
  /** The backup verdict for an app that holds data; undefined for one that holds none. */
  backup: ProtectionVerdict | undefined;
}

export function useHomeData({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { act, runs, dialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const again = useCheckAgain(refresh);

  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const verdict = verdictFor(needs, { hostname, checking, unread });
  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");

  // A staged or failed job opens in Activity; what BoxPilot could not tell anyone, in the
  // notification centre; anything else, the page with its detail (as Home does).
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));
  const runOf = (need: Need) => (need.finding ? runs[need.finding.id] : undefined);

  const apps = values.catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const verdicts = values.protection
    ? judgeProtection(values.protection, (values.schedules ?? []).map((schedule) => ({ ...schedule, parameters: schedule.parameters ?? undefined })), { now: clock })
    : [];
  const verdictById = new Map(verdicts.map((entry) => [entry.id, entry]));
  const rows: AppRow[] = apps.map((app) => ({ app, health: appHealth(app, protectionById.get(app.id), clock), protection: protectionById.get(app.id), backup: verdictById.get(app.id) }));
  const glance = backupGlance(values, { protection: facts.protection.state, offBox: facts.offBox.state, database: facts.database.state }, clock);

  return { facts, values, refresh, clock, needs, urgent, waiting, verdict, checking, unread, inventory, hostname, rows, glance, verdicts, act, runOf, open, dialog, again };
}

/** The drive the owner's data is on: the largest mount that is not the system disk, else the system disk. */
export function dataDrive(mounts: MountFact[]): { mount: MountFact; name: string } | null {
  const others = mounts.filter((mount) => mount.target !== "/" && mount.target !== "/boot" && !mount.target.startsWith("/boot/"));
  const pick = [...others].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0] ?? mounts.find((mount) => mount.target === "/") ?? null;
  if (!pick) return null;
  if (pick.target === "/") return { mount: pick, name: "System disk" };
  const last = pick.target.split("/").filter(Boolean).at(-1) ?? pick.target;
  return { mount: pick, name: `${last.charAt(0).toUpperCase()}${last.slice(1)} drive` };
}

/** An app's name as a sign or a short list has room for: "qBittorrent (through a VPN)" is "qBittorrent". */
export const shortName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\+.*$/, "").trim() || name;

/** An app's state in a word or two, as the posters write it under or beside its name. */
export function stateWords(row: AppRow): { words: string; attention: boolean } {
  const { app, health } = row;
  if (health.status === "danger") return { words: health.label.toLowerCase(), attention: true };
  if (health.status === "warning") {
    if (health.label === "Never backed up") return { words: "no backup", attention: true };
    const days = /^Last backup (\d+) days ago$/.exec(health.label);
    if (days) return { words: `backup ${days[1]} days`, attention: true };
    return { words: health.label.toLowerCase(), attention: true };
  }
  if (app.paused) return { words: "paused", attention: false };
  if (health.label === "Stopped") return { words: "stopped", attention: false };
  return { words: "running", attention: false };
}

const numberWords = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "3 things need a look. 2 more can wait." as "Three things need a look. Two more can wait." (E-Ink writes numbers out.) */
export function spellOut(sentence: string): string {
  return sentence.replace(/(^|[.:;]\s+|\s)(\d{1,2})(?=\s)/g, (match, before: string, digits: string) => {
    const value = Number(digits);
    if (value > 12) return match;
    const word = numberWords[value];
    const capital = before === "" || /\.\s+$/.test(before);
    return `${before}${capital ? word.charAt(0).toUpperCase() + word.slice(1) : word}`;
  });
}

/** The time as the posters print it: 07:41. */
export const clockTime = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

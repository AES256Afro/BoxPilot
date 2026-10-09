import { judgeProtection } from "../backupProtection";
import { sentenceList } from "../data";
import type { Status } from "../ui/types";
import type { FactValues, Source } from "./facts";
import { relativeTime } from "./format";

/*
 * Backups at a glance (M33.2; shared with Today, M25.3): whether each app has a recent backup,
 * whether a copy is off this server and how current it is, and when BoxPilot's own database was last
 * backed up. Home's panel and Today's section draw these three the same way from the same facts.
 */

export interface GlanceFigure {
  value: string;
  caption: string;
  status: Status;
  bar?: { value: number; max?: number };
}

export interface BackupGlance {
  apps: GlanceFigure;
  offBox: GlanceFigure;
  database: GlanceFigure;
}

type SourceState = Source<unknown>["state"];
const notRead = (state: SourceState) => (state === "failed" ? "Could not be read" : "Reading…");

export function backupGlance(
  values: Pick<FactValues, "protection" | "schedules" | "offBox" | "database">,
  states: { protection: SourceState; offBox: SourceState; database: SourceState },
  clock: number,
): BackupGlance {
  const verdicts = values.protection ? judgeProtection(values.protection, (values.schedules ?? []).map((schedule) => ({ ...schedule, parameters: schedule.parameters ?? undefined })), { now: clock }) : null;
  const recent = verdicts?.filter((verdict) => verdict.state === "ok").length ?? 0;
  const never = verdicts?.filter((verdict) => verdict.state === "never").length ?? 0;
  const stale = verdicts?.filter((verdict) => verdict.state === "stale").length ?? 0;
  const offBox = values.offBox?.verdict ?? null;
  const database = values.database;
  const databaseAge = database?.lastBackupAt ? Math.floor((clock - Date.parse(database.lastBackupAt)) / 86_400_000) : null;
  return {
    apps: {
      value: verdicts ? `${recent} of ${verdicts.length}` : "—",
      caption: !verdicts ? notRead(states.protection) : never ? `${never} never backed up` : stale ? `${stale} not backed up lately` : verdicts.length ? "Each has a recent backup" : "No app holds data to back up",
      status: !verdicts ? "unknown" : never || stale ? "warning" : "good",
      ...(verdicts && verdicts.length ? { bar: { value: recent, max: verdicts.length } } : {}),
    },
    offBox: {
      value: !offBox ? "—" : offBox.state === "none" ? "Nowhere" : offBox.state === "never" ? "Never copied" : offBox.state === "behind" ? "Behind" : offBox.state === "stale" ? `${offBox.ageDays} days old` : relativeTime(offBox.lastSyncAt, clock) ?? "Copied",
      // A recent copy that left files out (R5B4-7) is not a whole one.
      caption: !offBox ? notRead(states.offBox) : offBox.state === "ok" && offBox.skipped ? `${offBox.skipped} file${offBox.skipped === 1 ? "" : "s"} not copied` : offBox.where.length ? sentenceList(offBox.where) : "No second copy is set up",
      status: !offBox ? "unknown" : offBox.state === "ok" && !offBox.skipped ? "good" : "warning",
    },
    database: {
      value: !database ? "—" : database.lastBackupAt ? relativeTime(database.lastBackupAt, clock) ?? "—" : "Never",
      caption: !database ? notRead(states.database) : "last backed up, with a restore drill",
      status: !database ? "unknown" : databaseAge !== null && databaseAge <= 7 ? "good" : "warning",
    },
  };
}

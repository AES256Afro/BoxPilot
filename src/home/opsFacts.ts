import type { AppProtection } from "../backupProtection";
import { jobStatus, ranAgain } from "../jobStatus";
import type { Job } from "../operations";
import type { Status } from "../ui/types";
import type { AppFact, VmFacts } from "./facts";

/*
 * What Ops draws from the same facts as Home (M33.3), worked out here so it is tested without a
 * browser: the containers with their numbers, the job queue's rows and the backup matrix.
 */

export interface PerformanceApp { id: string; state: string; running: boolean; cpuPercent: number; memBytes: number; containers: number }
export interface Performance {
  cpu: { model: string; cores: number; usagePercent: number | null; load1: number; load5: number; load15: number; loadPercent: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
  temps: Array<{ label: string; celsius: number }>;
  disks: Array<{ mount: string; totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number }>;
  statsAvailable: boolean;
  apps: PerformanceApp[];
  uptimeSeconds: number;
}

/** Checks a performance answer's shape; anything else is not read, rather than read as zeroes. */
export function performanceFrom(value: unknown): Performance {
  const body = value as Partial<Performance> | null;
  if (!body?.cpu || !body.memory || !Array.isArray(body.disks) || !Array.isArray(body.apps)) throw new Error("The performance answer was incomplete");
  return { ...body, temps: Array.isArray(body.temps) ? body.temps : [], statsAvailable: Boolean(body.statsAvailable), uptimeSeconds: body.uptimeSeconds ?? 0 } as Performance;
}

export interface WorkloadRow {
  kind: "app" | "vm";
  id: string;
  name: string;
  icon: string | null;
  status: Status;
  state: string;
  cpuPercent: number | null;
  memBytes: number | null;
  reach: string;
  port: number | null;
}

/** Apps first, heaviest first, then the virtual machines; each with the one word for its state. */
export function workloads(apps: AppFact[], performance: Performance | null, vms: VmFacts | null, reach: (app: AppFact) => string): WorkloadRow[] {
  const stats = new Map((performance?.statsAvailable ? performance.apps : []).map((entry) => [entry.id, entry]));
  const rows: WorkloadRow[] = apps.map((app) => {
    const measured = stats.get(app.id);
    // Down is a problem unless the owner stopped it from BoxPilot; no container at all is a look (Home says why).
    const down = !app.running && !app.paused;
    const chosen = down && app.stoppedOnPurpose && app.status !== "restarting";
    const status: Status = down ? (app.status === "absent" ? "warning" : chosen ? "neutral" : "danger") : app.paused ? "neutral" : app.troubledSidecar || app.health === "unhealthy" ? "warning" : "good";
    const state = down ? (app.status === "restarting" ? "restarting" : app.status === "absent" ? "no container" : "stopped")
      : app.paused ? "paused" : app.troubledSidecar ? `${app.troubledSidecar.id} ${app.troubledSidecar.status === "restarting" ? "restarting" : "down"}` : app.health === "unhealthy" ? "unhealthy" : "up";
    const live = app.running || app.paused;
    return {
      kind: "app", id: app.id, name: app.name, icon: app.icon, status, state,
      cpuPercent: live && measured ? measured.cpuPercent : null, memBytes: live && measured ? measured.memBytes : null,
      reach: app.port === null ? "—" : reach(app), port: app.port,
    };
  });
  rows.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || a.name.localeCompare(b.name));
  for (const domain of vms?.domains ?? []) {
    const running = domain.state === "running";
    rows.push({
      kind: "vm", id: `vm:${domain.name}`, name: domain.name, icon: null, status: running ? "good" : "neutral",
      state: running ? "running" : domain.state, cpuPercent: null, memBytes: running ? domain.memoryBytes : null, reach: "VM", port: null,
    });
  }
  return rows;
}

/** Who can reach an app, in the one word a dense table has room for. */
export function shortReach(app: Pick<AppFact, "exposure" | "served" | "port">): string {
  if (app.port === null) return "—";
  if (app.served) return "tailnet";
  return app.exposure === "loopback" ? "local" : "LAN";
}

/** A job's pill as a status: done is good, failed is danger, still going or cut short is a look. */
export function jobState(job: Job): { status: Status; label: string } {
  const { label, tone } = jobStatus(job);
  const status: Status = tone === "status-good" ? "good" : tone === "status-danger" ? "danger" : tone === "status-warning" ? "warning" : "neutral";
  return { status, label };
}

/** What a job acted on, from its parameters: an app, a drive, a unit, a package list. */
export function jobTarget(job: Job): string {
  const parameters = job.parameters ?? {};
  for (const key of ["id", "name", "subject", "unit", "domain", "target"]) {
    const value = parameters[key];
    if (typeof value === "string" && value) return value;
  }
  const packages = parameters.packages;
  if (Array.isArray(packages) && packages.length) return packages.length === 1 ? String(packages[0]) : `${packages.length} packages`;
  return "—";
}

export type RunState = "ok" | "failed" | "running" | "waiting";
export interface BackupRun { jobId: string; state: RunState; at: string }
export interface BackupRow {
  id: string;
  name: string;
  status: Status;
  /** Newest first, at most `runs`. */
  runs: BackupRun[];
  backups: number | null;
  newestAt: string | null;
  drill: { verified: boolean; checkedAt: string | null } | null;
  summary: string;
}

const runState = (job: Job): RunState | null => {
  if (job.state === "completed") return "ok";
  if (job.state === "failed") return ranAgain(job) ? null : "failed";
  if (job.state === "applying" || job.state === "verifying") return "running";
  if (job.state === "awaiting_approval") return "waiting";
  return null;
};

/**
 * The backup matrix: every app whose data is worth keeping, with its last few backup runs from the
 * job history, how many backups exist and how old the newest is, and its last restore drill. Its
 * status is the worst of: the newest run failed (danger), never backed up or nothing in two weeks
 * (warning), otherwise good.
 */
export function backupMatrix({ protection, jobs, apps, now, runs = 5, staleAfterDays = 14 }:
  { protection: AppProtection[] | null; jobs: Job[]; apps: AppFact[]; now: number; runs?: number; staleAfterDays?: number }): BackupRow[] {
  const history = new Map<string, BackupRun[]>();
  for (const job of [...jobs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))) {
    const id = job.parameters?.id;
    if (job.type !== "op:app.backup" || typeof id !== "string") continue;
    const state = runState(job);
    if (!state) continue;
    const list = history.get(id) ?? [];
    if (list.length < runs) list.push({ jobId: job.id, state, at: job.createdAt ?? "" });
    history.set(id, list);
  }
  const byId = new Map(apps.map((app) => [app.id, app]));
  const ids = new Set([...(protection ?? []).filter((entry) => entry.protectable).map((entry) => entry.id), ...history.keys()]);
  const rows: BackupRow[] = [...ids].map((id) => {
    const known = protection?.find((entry) => entry.id === id) ?? null;
    const recent = history.get(id) ?? [];
    const newest = known?.newestAt ? Date.parse(known.newestAt) : Number.NaN;
    const ageDays = Number.isFinite(newest) ? Math.floor((now - newest) / 86_400_000) : null;
    const lastFailed = recent[0]?.state === "failed";
    const never = known !== null && (known.backups === 0 || ageDays === null);
    const stale = ageDays !== null && ageDays > staleAfterDays;
    const status: Status = lastFailed ? "danger" : never || stale ? "warning" : known ? "good" : "unknown";
    const summary = lastFailed ? "Last run failed" : never ? "No backup yet" : stale ? `${ageDays} days old` : known ? "Covered" : "Not known";
    return { id, name: byId.get(id)?.name ?? known?.name ?? id, status, runs: recent, backups: known?.backups ?? null, newestAt: known?.newestAt ?? null, drill: byId.get(id)?.drill ?? null, summary };
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

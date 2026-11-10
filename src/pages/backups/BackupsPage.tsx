import { useCallback, useEffect, useRef, useState } from "react";
import { behindBackupSchedules, judgeProtection, type AppProtection, type ProtectionVerdict, type ScheduleLike } from "../../backupProtection";
import type { ViewName } from "../../data";
import { readJson } from "../../http";
import { mirrorOperations, offBoxVerdict, offBoxWarning, type OffBoxInputs } from "../../offBox";
import { inspectOperation } from "../../operations";
import { useTailnetHosts } from "../../tailnetHosts";
import { Button, Notice, PageHeader, Tabs, mayStart, useUrlParam, type Status, type TabItem } from "../../ui";
import AppsTab from "./AppsTab";
import OffBoxTab, { type OffBoxSummary } from "./OffBoxTab";
import RecoveryTab, { type SendOff } from "./RecoveryTab";
import { recoveryOf, recoveryVerdict, sendOffOperation, serverFacts, type Rehearsal } from "./recovery";
import RestoreTab from "./RestoreTab";
import ServerTab from "./ServerTab";
import { ago, nightlySlot, syncedAt, type BackupRecord, type CloudSettings, type CloudState, type MachineSnapshotState, type ProtectionState, type RemoteMirrorState, type RemoteSettings, type RestoreReview, type RetentionStatus } from "./types";
import "./backups.css";

/*
 * Backups (M33.9), rebuilt on the kit in the console's look with every feature the Classic page
 * had. Facts first: whether anything is unprotected, a backup has stopped or nothing is copied off
 * this server, then the counts in mono, then the tabs by what the owner does: what a dead disk would
 * leave of each app (What you'd get back, the tab the page opens on), each app's data (Apps),
 * BoxPilot's database and machine snapshots (This server), copies kept elsewhere (Off-box), and
 * restoring from a snapshot (Restore). Setting a destination is a sheet. While the first tab is open
 * the header says its verdict and its counts: the question it answers is the page's.
 */

export interface BackupsPageProps {
  csrfToken: string;
  /** Who is signed in: the actions a role cannot start are left out (docs/UI-PAGES.md). */
  role?: string;
  onNavigate?: (view: ViewName) => void;
  /** The clock the first tab counts ages from, read once per read of the page; a test holds it still. */
  now?: () => number;
}

type TabId = "recover" | "apps" | "server" | "offbox" | "restore";
const tabIds: readonly TabId[] = ["recover", "apps", "server", "offbox", "restore"];

const requestJson = async <T,>(url: string, options?: RequestInit): Promise<T> => readJson<T>(await fetch(url, options));
const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The machine-snapshot state, or null unless it has the sync block the page reads. */
function asMachine(value: unknown): MachineSnapshotState | null {
  if (!isObject(value) || !isObject(value.sync) || !isObject(value.sync.mount)) return null;
  const state = value as unknown as MachineSnapshotState;
  return { ...state, snapshots: Array.isArray(state.snapshots) ? state.snapshots : [] };
}

/**
 * Each installed app's last recorded restore rehearsal, from the catalog's live rows, or null when
 * they did not come back: the verdicts ride on the live rows, so a catalog read without them (the
 * helper did not answer) says nothing about rehearsals, and is not read as "never tried".
 */
function asRehearsals(body: unknown): Record<string, Rehearsal | null> | null {
  if (!isObject(body) || !Array.isArray(body.applications) || body.liveError) return null;
  const found: Record<string, Rehearsal | null> = {};
  for (const entry of body.applications as unknown[]) {
    if (!isObject(entry) || !isObject(entry.manifest) || typeof entry.manifest.id !== "string" || !isObject(entry.live)) continue;
    found[entry.manifest.id] = isObject(entry.live.backupVerification) ? entry.live.backupVerification as Rehearsal : null;
  }
  return found;
}

export default function BackupsPage({ csrfToken, role = "owner", onNavigate, now = Date.now }: BackupsPageProps) {
  const [tab, setTab] = useUrlParam<TabId>("tab", tabIds, "recover");
  const tailnetHosts = useTailnetHosts();
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupRecord[] | null>(null);
  const [newestLocalAt, setNewestLocalAt] = useState<string | null>(null);
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [machine, setMachine] = useState<MachineSnapshotState | null>(null);
  const [remote, setRemote] = useState<RemoteMirrorState | null>(null);
  const [remoteSettings, setRemoteSettings] = useState<RemoteSettings | null>(null);
  const [cloud, setCloud] = useState<CloudState | null>(null);
  const [cloudSettings, setCloudSettings] = useState<CloudSettings | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [appProtection, setAppProtection] = useState<{ available: boolean; verdicts: ProtectionVerdict[] } | null>(null);
  const [appProtectionError, setAppProtectionError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduleLike[]>([]);
  const [restores, setRestores] = useState<RestoreReview[] | null>(null);
  const [appList, setAppList] = useState<{ available: boolean; apps: AppProtection[] } | null>(null);
  const [rehearsals, setRehearsals] = useState<Record<string, Rehearsal | null> | null>(null);
  // The clock every age on the first tab is counted from: when the page last read.
  const clock = useRef(now);
  clock.current = now;
  const [readAt, setReadAt] = useState(() => now());
  const [scheduling, setScheduling] = useState<{ busy: boolean; message: string; failed: boolean } | null>(null);

  // Every read is checked for its shape as well as its status: an answer in an unexpected shape is
  // "not read", said as such, never a crash and never an all-clear.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, protectionState, retentionState, machineState, remoteState, remoteConfig, cloudState, cloudConfig, apps, scheduleList, reviews, rehearsed] = await Promise.all([
        requestJson<{ backups?: BackupRecord[] }>("/api/v1/backups").then(
          (body) => (Array.isArray(body?.backups) ? { ok: true as const, backups: body.backups } : { ok: false as const, error: "The answer held no list of backups." }),
          (requestError: unknown) => ({ ok: false as const, error: messageOf(requestError, "The backups could not be read") })),
        requestJson<ProtectionState>("/api/v1/controller-backup-protection").then((body) => (isObject(body) ? body : null)).catch(() => null),
        requestJson<RetentionStatus>("/api/v1/controller-backup-retention").then((body) => (isObject(body) ? body : null)).catch(() => null),
        inspectOperation<MachineSnapshotState>("host.snapshot.inspect").then((body) => asMachine(body?.result)).catch(() => null),
        inspectOperation<RemoteMirrorState>("backup.remote.inspect").then((body) => (isObject(body?.result) ? body.result : null)).catch(() => null),
        requestJson<RemoteSettings>("/api/v1/settings/backup-destination").then((body) => (isObject(body) ? body : null)).catch(() => null),
        inspectOperation<CloudState>("backup.cloud.inspect").then(
          (body) => (isObject(body?.result) ? { ok: true as const, cloud: body.result } : { ok: false as const, error: "The answer held no cloud state." }),
          (requestError: unknown) => ({ ok: false as const, error: messageOf(requestError, "The cloud destination could not be read") })),
        requestJson<CloudSettings>("/api/v1/settings/cloud-destination").then((body) => (isObject(body) ? body : null)).catch(() => null),
        inspectOperation<{ available: boolean; apps: AppProtection[] }>("app.backup.protection").then(
          (body) => (isObject(body?.result) && Array.isArray(body.result.apps) ? { ok: true as const, available: Boolean(body.result.available), apps: body.result.apps } : { ok: false as const, error: "The answer held no list of apps." }),
          (requestError: unknown) => ({ ok: false as const, error: messageOf(requestError, "App protection could not be read") })),
        requestJson<{ schedules?: ScheduleLike[] }>("/api/v1/schedules").then((body) => (Array.isArray(body?.schedules) ? body.schedules : [])).catch(() => [] as ScheduleLike[]),
        inspectOperation<{ restores?: RestoreReview[] }>("host.snapshot.restores").then((body) => (Array.isArray(body?.result?.restores) ? body.result.restores : null)).catch(() => null),
        // Each app's last restore rehearsal, which the catalog's summary carries on its live rows.
        requestJson<unknown>("/api/v1/catalog?view=summary").then(asRehearsals).catch(() => null),
      ]);
      if (list.ok) {
        setBackups(list.backups.filter((backup) => backup.applicationId === "boxpilot-controller"));
        setNewestLocalAt(list.backups.reduce<string | null>((newest, backup) => (newest === null || backup.createdAt > newest ? backup.createdAt : newest), null));
        setError(null);
      } else {
        setError(list.error);
      }
      setProtection(protectionState);
      setRetention(retentionState);
      setMachine(machineState);
      setRemote(remoteState);
      setRemoteSettings(remoteConfig);
      if (cloudState.ok) { setCloud(cloudState.cloud); setCloudError(null); } else { setCloudError(cloudState.error); }
      setCloudSettings(cloudConfig);
      if (apps.ok) { setAppProtection({ available: apps.available, verdicts: judgeProtection(apps.apps, scheduleList) }); setAppList({ available: apps.available, apps: apps.apps }); setAppProtectionError(null); } else { setAppProtection(null); setAppList(null); setAppProtectionError(apps.error); }
      setSchedules(scheduleList);
      setRestores(reviews);
      setRehearsals(rehearsed);
      setReadAt(clock.current());
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * Schedule each operation daily, one request each, so a refusal on one does not cost the others;
   * what succeeded is reported rather than assumed.
   */
  const schedule = async (entries: Array<{ label: string; body: Record<string, unknown> }>, done: (created: number) => string) => {
    let created = 0;
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        const response = await fetch("/api/v1/schedules", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(entry.body) });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "refused");
        created += 1;
      } catch (requestError) {
        failures.push(`${entry.label}: ${messageOf(requestError, "failed")}`);
      }
    }
    setScheduling(failures.length
      ? { busy: false, failed: true, message: `Scheduled ${created} of ${entries.length}. ${failures.join("; ")}` }
      : { busy: false, failed: false, message: done(created) });
    await refresh();
  };
  // Nightly backups in a fixed 02:00-03:59 window, spaced so a dozen apps do not all stop at once.
  const protectNightly = (targets: ProtectionVerdict[]) => {
    setScheduling({ busy: true, failed: false, message: "Setting up nightly backups…" });
    void schedule(
      targets.map((target, index) => ({ label: target.name, body: { operationId: "app.backup", parameters: { id: target.id }, frequency: "daily", ...nightlySlot(index, targets.length) } })),
      (created) => `Scheduled nightly backups for ${created} app${created === 1 ? "" : "s"}. The first runs tonight.`,
    );
  };
  // The second copy from 04:15, after the app backups above have finished writing.
  const mirrorNightly = (operations: string[]) => {
    setScheduling({ busy: true, failed: false, message: "Scheduling the nightly second copy…" });
    void schedule(
      operations.map((operationId, index) => ({ label: operationId, body: { operationId, parameters: {}, frequency: "daily", minute: 15, hour: (4 + index) % 24 } })),
      () => "Nightly second copy scheduled. The first runs tonight.",
    );
  };

  const inputs: OffBoxInputs = {
    cloud: { configured: Boolean(cloudSettings?.destination), lastSyncAt: syncedAt(cloudSettings?.lastSync) },
    ssh: { configured: Boolean(remoteSettings?.destination), lastSyncAt: syncedAt(remoteSettings?.lastSync) },
    drive: { configured: machine?.sync.mount.mounted ?? false, lastSyncAt: machine?.sync.lastSync?.completedAt ?? null, skipped: machine?.sync.lastSync?.skippedCount ?? 0 },
  };
  const wanted = mirrorOperations(inputs);
  const offVerdict = offBoxVerdict(inputs, { newestLocalBackupAt: newestLocalAt });
  // "Only on this server" is a claim about all three destinations: with one of them unread and none
  // of the others set up, it is not known, and is said as not known.
  const offBoxUnknown = loaded && wanted.length === 0 && (machine === null || cloudSettings === null || remoteSettings === null);
  const summary: OffBoxSummary | null = loaded && !offBoxUnknown ? {
    verdict: offVerdict,
    warning: offBoxWarning(offVerdict),
    wanted,
    scheduled: wanted.length > 0 && wanted.every((operationId) => schedules.some((entry) => entry.operationId === operationId && entry.enabled !== false)),
  } : null;
  const behind = behindBackupSchedules(schedules);
  const verdicts = appProtection?.verdicts ?? [];
  const never = verdicts.filter((verdict) => verdict.state === "never");
  const stale = verdicts.filter((verdict) => verdict.state === "stale");

  // What a dead disk would leave of each app (the first tab). A destination whose state did not come
  // back is handed over as unread, never as "not set up"; a cloud sync's errors are files it left out.
  const recovery = loaded ? recoveryOf({
    apps: appList?.available ? appList.apps : null,
    schedules,
    offBox: {
      cloud: cloudSettings ? { configured: Boolean(cloudSettings.destination), lastSyncAt: syncedAt(cloudSettings.lastSync), skipped: cloudSettings.lastSync?.errors ?? 0 } : null,
      ssh: remoteSettings ? inputs.ssh : null,
      drive: machine ? inputs.drive : null,
    },
    rehearsals,
  }, { now: readAt }) : null;
  const sshDestination = remoteSettings?.destination && !("hidden" in remoteSettings.destination) ? remoteSettings.destination : null;
  const sendOffId = sendOffOperation({
    drive: Boolean(machine?.sync.mount.mounted),
    ssh: Boolean(sshDestination && remote?.keyReady && remote.rsyncInstalled && remote.hostKeysPinned > 0),
    cloud: Boolean(cloudSettings?.destination && cloud?.rcloneInstalled && cloud.sealed !== false),
  }, (operationId) => mayStart(role, operationId));
  const sendOff: SendOff | null = sendOffId === "backup.sync" ? { operationId: sendOffId, title: "Mirror local backups to the backup drive", preview: <span>Copies the local backup folders (database backups, app backups, machine snapshots) onto the independent backup drive and verifies every copied file's hash. Nothing on the drive is ever deleted.</span> }
    : sendOffId === "backup.remote.sync" ? { operationId: sendOffId, title: `Mirror backups to ${sshDestination?.host ?? "the other machine"}`, preview: <span>Copies the database backups, app backups and machine snapshots to <code>{sshDestination?.host}</code>. Files already there are not sent again; nothing there is ever deleted.</span> }
      : sendOffId === "backup.cloud.sync" ? { operationId: sendOffId, title: "Mirror backups to the cloud", preview: <span>Copies the database backups, app backups and machine snapshots to the bucket, sealed with your passphrase. Files already there are not sent again; nothing there is ever deleted.</span> }
        : null;
  const recoveryVerdictNow = recovery ? recoveryVerdict(recovery) : null;
  const onRecovery = tab === "recover";
  // The tab carries a mark only when there is something to act on or something unread.
  const recoveryMark = Boolean(recoveryVerdictNow && recoveryVerdictNow.status !== "good" && recoveryVerdictNow.status !== "neutral");

  // Never green about something unread (M28.5): unknown protection is said as unknown.
  const verdict: { status: Status; label: string } = !loaded ? { status: "unknown", label: "Reading…" }
    : onRecovery && recoveryVerdictNow ? { status: recoveryVerdictNow.status, label: recoveryVerdictNow.label }
    : behind.length ? { status: "danger", label: `${behind.length} backup${behind.length === 1 ? "" : "s"} stopped running` }
      : never.length ? { status: "warning", label: `${never.length} ${never.length === 1 ? "app" : "apps"} never backed up` }
        : summary?.warning ? { status: "warning", label: offVerdict.state === "none" ? "Only on this server" : offVerdict.state === "never" ? "Never copied off" : offVerdict.state === "ok" && offVerdict.skipped ? "Copy off this server incomplete" : "Copy off this server behind" }
          : stale.length ? { status: "warning", label: `${stale.length} not backed up recently` }
            : !appProtection?.available ? { status: "unknown", label: "Not read" }
              : { status: "good", label: "Protected" };

  const offAge = offVerdict.lastSyncAt ? ago(offVerdict.lastSyncAt) : null;
  const tabs: Array<TabItem<TabId>> = [
    { id: "recover", label: "What you'd get back", count: recovery?.read ? recovery.rows.length : undefined, status: recoveryMark ? recoveryVerdictNow?.status : undefined, statusLabel: recoveryMark ? recoveryVerdictNow?.short : undefined },
    { id: "apps", label: "Apps", count: appProtection?.available ? verdicts.length : undefined, status: behind.length ? "danger" : never.length || stale.length ? "warning" : undefined, statusLabel: behind.length ? "a backup stopped running" : never.length || stale.length ? `${never.length + stale.length} need a backup` : undefined },
    { id: "server", label: "This server", count: backups ? backups.length + (machine?.snapshots.length ?? 0) : undefined },
    { id: "offbox", label: "Off this server", status: summary?.warning ? "warning" : offBoxUnknown ? "unknown" : undefined, statusLabel: summary?.warning ?? (offBoxUnknown ? "not read" : undefined) },
    { id: "restore", label: "Restore", count: restores?.length ? restores.length : undefined, status: restores?.length ? "neutral" : undefined, statusLabel: restores?.length ? `${restores.length} left to review` : undefined },
  ];

  return (
    <div className="backups-page">
      <PageHeader
        title="Backups"
        status={verdict}
        meta={!loaded ? undefined : onRecovery ? (recovery?.read ? <>
          <b>{recovery.rows.length}</b> {recovery.rows.length === 1 ? "app" : "apps"} with data · <b>{recovery.counts.full}</b> fully recoverable · <b>{recovery.counts.partly}</b> partly · <b>{recovery.counts.none}</b> not at all{recovery.counts.unknown ? <> · <b>{recovery.counts.unknown}</b> not known</> : null}
        </> : undefined) : <>
          {appProtection?.available ? <><b>{verdicts.length}</b> apps with data · <b>{verdicts.filter((entry) => entry.scheduled).length}</b> nightly · </> : null}
          <b>{backups?.length ?? "—"}</b> database backups · <b>{machine?.snapshots.length ?? "—"}</b> machine snapshots · off this server <b>{offAge ?? "never"}</b>
        </>}
        actions={<Button variant="ghost" busy={loading && loaded} onClick={() => void refresh()}>Check again</Button>}
        about={<>
          <p>What protects this server's data: each app's backups and whether something keeps making them, BoxPilot's own database, machine snapshots, the copies kept somewhere else, and restoring from a snapshot.</p>
          <p>A database backup is taken with no downtime and restore-drilled before it is recorded; Protect keeps an encrypted second copy. A machine snapshot is one archive to redeploy this server: the database, every app's settings and secrets, network and firewall config, and each VM's definition. The data stays in the per-app backups, so an app with no backup comes back installed and empty.</p>
          <p>Backups beside the data they protect survive a bad upgrade, not a failed disk: keep a copy on a backup drive, another machine over SSH or a cloud bucket. Recurring snapshots and syncs can be scheduled on the System page; VM protection is on the Virtual Machines page.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The backups could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      <Tabs<TabId> label="Backups" tabs={tabs} value={tab} onChange={setTab}>
        {(current) => {
          if (current === "recover") {
            return <RecoveryTab csrfToken={csrfToken} role={role} recovery={recovery} protectionError={appProtectionError} folderUnread={appList?.available === false} now={readAt} sendOff={sendOff} hasDestination={wanted.length > 0 || Boolean(remoteSettings?.destination)} scheduling={scheduling}
              onSchedule={(appId) => { const target = verdicts.find((entry) => entry.id === appId); if (target) protectNightly([target]); }}
              facts={serverFacts({ snapshots: machine ? machine.snapshots : null, offBox: offBoxUnknown || !loaded ? null : offVerdict, database: backups })}
              onChanged={() => void refresh()} onOpenOffBox={() => setTab("offbox")} />;
          }
          if (current === "server") return <ServerTab csrfToken={csrfToken} role={role} loading={loading} backups={backups} protection={protection} retention={retention} machine={machine} onChanged={() => void refresh()} />;
          if (current === "offbox") return <OffBoxTab csrfToken={csrfToken} role={role} tailnetHosts={tailnetHosts} machine={machine} remote={remote} remoteSettings={remoteSettings} cloud={cloud} cloudSettings={cloudSettings} cloudError={cloudError} summary={summary} summaryUnknown={offBoxUnknown} scheduling={scheduling} onMirrorNightly={mirrorNightly} onChanged={() => void refresh()} onNavigate={onNavigate} />;
          if (current === "restore") return <RestoreTab csrfToken={csrfToken} role={role} restores={restores} onChanged={() => void refresh()} />;
          return <AppsTab csrfToken={csrfToken} role={role} protection={appProtection} protectionError={appProtectionError} behind={behind} scheduling={scheduling} onSchedule={protectNightly} onChanged={() => void refresh()} onNavigate={onNavigate} />;
        }}
      </Tabs>
    </div>
  );
}

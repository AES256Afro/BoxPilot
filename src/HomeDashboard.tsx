import { useEffect, useState } from "react";
import { countOf } from "./data";
import type { ViewName } from "./data";
import { inspectOperation, type Job } from "./operations";
import { appUrl, type TailnetServe } from "./appLinks";
import { judgeProtection, protectionWarning, type AppProtection, type ScheduleLike } from "./backupProtection";
import { offBoxVerdict, offBoxWarning } from "./offBox";
import { jobStatus, ranAgain } from "./jobStatus";
import { jobTimeout } from "./JobTimeout";

/**
 * Home dashboard (M8.1): what is on this box and what needs attention, one glance.
 * Every source loads independently; a failed one leaves its tile quiet instead of
 * breaking the page.
 */

interface AppSummary { id: string; name: string; running: boolean; paused: boolean; installed: boolean; health: string; updateAvailable: boolean; folderProblems: number; vpnLeaked: boolean; url: string | null }
interface Tile { updates: number | null; security: number; rebootRequired: boolean }
interface ChecklistItem { id: string; title: string; detail: string; done: boolean; known?: boolean; optional: boolean; view: ViewName }
interface Checklist { items: ChecklistItem[]; done: number; total: number; allEssentialDone: boolean; unknown?: number }

interface WatchedCondition { family: string; title: string; since: string | null; announced: boolean }

/** Where the owner goes about a watched condition: schedules live on System, flows on Automations. */
function watchView(family: string): ViewName {
  if (family === "schedule.failed") return "system";
  if (family === "flow.failed") return "automations";
  if (family === "release.available") return "system"; // System, BoxPilot updates
  if (family === "drive.reconnected") return "storage"; // the drive's row, where its auto-reconnect lives
  if (family === "signin.new" || family === "report.weekly") return "settings"; // where you're signed in; the report's preview
  return "repairs"; // host conditions, an interrupted job, a result not saved: Repair keeps the Activity with each job's steps
}

function timeLabel(iso?: string): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const sameDay = new Date().toDateString() === date.toDateString();
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? clock : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export default function HomeDashboard({ onNavigate }: { onNavigate: (view: ViewName) => void }) {
  const [updates, setUpdates] = useState<Tile | null>(null);
  const [failedServices, setFailedServices] = useState<number | null>(null);
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [vms, setVms] = useState<{ total: number; running: number } | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [backups, setBackups] = useState<{ lastBackupAt: string | null; lastSyncAt: string | null; syncReady: boolean } | null>(null);
  const [unprotected, setUnprotected] = useState<string | null>(null);
  const [offBox, setOffBox] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ firstRun: boolean; installedApps: number } | null>(null);
  const [watch, setWatch] = useState<WatchedCondition[]>([]);
  const [notices, setNotices] = useState<WatchedCondition[]>([]);
  const [targetConfigured, setTargetConfigured] = useState(false);
  const [showUnannounced, setShowUnannounced] = useState(false);
  const [rebuild, setRebuild] = useState<{ count: number; source: string } | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);

  useEffect(() => {
    let cancelled = false;
    const guard = <T,>(setter: (value: T) => void) => (value: T) => { if (!cancelled) setter(value); };

    fetch("/api/v1/setup/checklist")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("checklist unavailable"))))
      .then((data: Checklist) => { if (Array.isArray(data?.items)) guard(setChecklist)(data); })
      .catch(() => {});
    inspectOperation<{ count: number; securityCount: number; rebootRequired: boolean }>("apt.upgradable.inspect")
      .then(({ result }) => guard(setUpdates)({ updates: result.count, security: result.securityCount, rebootRequired: result.rebootRequired }))
      .catch(() => {});
    inspectOperation<{ counts: { failed: number } }>("service.list")
      .then(({ result }) => guard(setFailedServices)(result.counts.failed))
      .catch(() => {});
    const servesPromise = inspectOperation<{ available: boolean; serves: TailnetServe[] }>("app.serve.inspect")
      .then(({ result }) => (result.available ? result.serves : []))
      .catch(() => [] as TailnetServe[]);
    fetch("/api/v1/catalog?view=summary")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("catalog unavailable"))))
      .then(async (data: { applications: Array<{ manifest: { id: string; name: string }; live: { installed: boolean; container: { running: boolean; status?: string; health: string }; updateAvailable?: boolean; folderProblems?: Array<{ path: string }>; killSwitchDrill?: { leaked: boolean } | null; urls: Array<{ host: number; exposure: string; path?: string | null }> } | null }>; host: { lanAddress: string | null } }) => {
        const servesSoFar = await servesPromise;

        guard(setApps)(data.applications
          .filter((entry) => entry.live?.installed)
          .map((entry) => ({
            id: entry.manifest.id,
            name: entry.manifest.name,
            installed: true,
            // A paused container still reports running to Docker; it is frozen, not serving.
            running: (entry.live?.container.running ?? false) && entry.live?.container.status !== "paused",
            paused: entry.live?.container.status === "paused",
            health: entry.live?.container.health ?? "",
            updateAvailable: entry.live?.updateAvailable ?? false,
            folderProblems: entry.live?.folderProblems?.length ?? 0,
            vpnLeaked: Boolean(entry.live?.killSwitchDrill?.leaked),
            url: entry.live?.urls.length ? appUrl(entry.live.urls[0], { lanAddress: data.host.lanAddress, serves: servesSoFar }) : null,
          })));
      })
      .catch(() => {});
    fetch("/api/v1/virtualization/domains")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("domains unavailable"))))
      .then((data: { domains?: Array<{ state: string }> }) => {
        const domains = data.domains ?? [];
        guard(setVms)({ total: domains.length, running: domains.filter((domain) => domain.state === "running").length });
      })
      .catch(() => {});
    fetch("/api/v1/jobs?limit=6")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("jobs unavailable"))))
      .then((data: { jobs: Job[] }) => guard(setJobs)(data.jobs))
      .catch(() => {});
    // Whether the *applications* have backups, which is a different question from whether
    // BoxPilot's own database does — and the one nothing used to ask.
    Promise.all([
      inspectOperation<{ available: boolean; apps: AppProtection[] }>("app.backup.protection").catch(() => null),
      fetch("/api/v1/schedules").then((response) => (response.ok ? response.json() : { schedules: [] })).catch(() => ({ schedules: [] })),
    ]).then(([protection, scheduleList]: [{ result: { available: boolean; apps: AppProtection[] } } | null, { schedules: ScheduleLike[] }]) => {
      if (!protection?.result?.available) return;
      guard(setUnprotected)(protectionWarning(judgeProtection(protection.result.apps, scheduleList.schedules ?? [])));
    }).catch(() => {});
    // Is there a copy anywhere but this disk? Any of the three destinations counts.
    // A destination that cannot be read is unknown, not absent. Saying "backups are only on this
    // server" because a request failed would assert something we did not learn, so if none of the
    // three answers, the dashboard stays quiet rather than inventing an alarm.
    type DestinationRead = { ok: boolean; destination: unknown; lastSync: unknown };
    const destination = async (url: string): Promise<DestinationRead> => {
      try {
        const response = await fetch(url);
        if (!response.ok) return { ok: false, destination: null, lastSync: null };
        const body = (await response.json()) as { destination?: unknown; lastSync?: unknown };
        return { ok: true, destination: body.destination ?? null, lastSync: body.lastSync ?? null };
      } catch {
        return { ok: false, destination: null, lastSync: null };
      }
    };
    // Both the off-box warning and the backup card want the backup list and the machine's mirror
    // state. They are the same two reads, so they are made once and shared rather than twice each.
    type BackupList = { backups: Array<{ applicationId: string; createdAt: string }> } | null;
    const backupsOnce: Promise<BackupList> = fetch("/api/v1/backups")
      .then((response) => (response.ok ? (response.json() as Promise<NonNullable<BackupList>>) : null)).catch(() => null);
    const machineOnce = inspectOperation<{ sync: { mount: { mounted: boolean }; lastSync: { completedAt: string } | null } }>("host.snapshot.inspect").catch(() => null);

    Promise.all([
      destination("/api/v1/settings/cloud-destination"),
      destination("/api/v1/settings/backup-destination"),
      machineOnce,
      backupsOnce,
    ]).then(([cloud, ssh, machine, backupList]) => {
      if (!cloud.ok && !ssh.ok && !machine) return;
      const at = (value: unknown) => (typeof value === "string" ? value : (value as { completedAt?: string } | null)?.completedAt ?? null);
      // The newest local backup, so a mirror that has quietly stopped following them is caught
      // long before it is old enough to count as stale.
      const newestLocalBackupAt = (backupList?.backups ?? []).reduce<string | null>((newest, backup) => (newest === null || backup.createdAt > newest ? backup.createdAt : newest), null);
      guard(setOffBox)(offBoxWarning(offBoxVerdict({
        cloud: { configured: Boolean(cloud.destination), lastSyncAt: at(cloud.lastSync) },
        ssh: { configured: Boolean(ssh.destination), lastSyncAt: at(ssh.lastSync) },
        drive: { configured: machine?.result.sync.mount.mounted ?? false, lastSyncAt: machine?.result.sync.lastSync?.completedAt ?? null },
      }, { newestLocalBackupAt })));
    }).catch(() => {});
    Promise.all([backupsOnce, machineOnce])
      .then(([list, machine]) => {
        if (!list) return; // no list, no card: an empty one would read as "no backups yet"
        guard(setBackups)({
          lastBackupAt: list.backups.find((backup) => backup.applicationId === "boxpilot-controller")?.createdAt ?? null,
          lastSyncAt: machine?.result.sync.lastSync?.completedAt ?? null,
          syncReady: machine?.result.sync.mount.mounted ?? false,
        });
      })
      .catch(() => {});

    fetch("/api/v1/settings/watch")
      .then((response) => (response.ok ? response.json() : { conditions: [] }))
      .then((data: { targetConfigured?: boolean; conditions?: Array<{ key: string; active: boolean; details: Array<{ title: string; since?: string | null; announced?: boolean }> }>; notices?: Array<{ key: string; title: string; since?: string | null }> }) => {
        guard(setTargetConfigured)(data.targetConfigured === true);
        guard(setWatch)((data.conditions ?? []).filter((condition) => condition.active).flatMap((condition) => condition.details.map((detail) => ({ family: condition.key, title: detail.title, since: detail.since ?? null, announced: detail.announced !== false }))));
        guard(setNotices)((data.notices ?? []).map((notice) => ({ family: notice.key, title: notice.title, since: notice.since ?? null, announced: false })));
      })
      .catch(() => {});

    fetch("/api/v1/setup")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("setup unavailable"))))
      .then((data: { firstRun: boolean; installedApps: number }) => guard(setSetup)({ firstRun: data.firstRun, installedApps: data.installedApps }))
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // A rebuild is a fresh box with a drive full of snapshots already mounted. Only a first-run
    // server goes looking: an established one restoring a single app is not rebuilding.
    if (!setup?.firstRun) { setRebuild(null); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const look = (attempt: number) => {
      inspectOperation<{ locations: Array<{ mount: { source: string }; snapshots: unknown[] }>; unanswered?: unknown[] }>("host.snapshot.discover")
        .then(({ result }) => {
          if (cancelled) return;
          const count = result.locations.reduce((total, location) => total + location.snapshots.length, 0);
          if (count > 0) { setRebuild({ count, source: result.locations[0].mount.source }); return; }
          // A mounted drive that failed to answer is usually a network hiccup, not an empty drive;
          // one quiet retry covers the moment that hid a rebuild's snapshots on a live network.
          if ((result.unanswered ?? []).length > 0 && attempt === 0) retryTimer = setTimeout(() => look(1), 4000);
        })
        .catch(() => {}); // no drive, no answer, no card: a fresh box with nothing mounted is just fresh
    };
    look(0);
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [setup?.firstRun]);

  const attention: Array<{ label: string; view: ViewName }> = [];
  // What the health watcher currently sees, announced or not. Without a notification target these
  // conditions used to exist only in a setting nobody read; the owner found out from an I/O error.
  // The ones that reached no one are also counted in the line at the top of the page.
  for (const alert of watch) attention.push({ label: alert.title, view: watchView(alert.family) });
  // Everything BoxPilot knew and could not tell anyone (M27.2): host conditions, failed schedules,
  // stopped automations and results it could not save, with no target set or a target that failed.
  // News that reached no one - an interrupted job, a release, a new sign-in, the weekly report - is
  // counted here too, but it is not a fault, so it stays out of "Needs attention" below.
  const unannounced = [...watch.filter((alert) => !alert.announced), ...notices];
  if (updates?.rebootRequired) attention.push({ label: "A reboot is pending", view: "updates" });
  if ((updates?.updates ?? 0) > 0) attention.push({ label: `${updates?.updates} update${updates?.updates === 1 ? "" : "s"} available${updates?.security ? ` (${updates.security} security)` : ""}`, view: "updates" });
  if ((failedServices ?? 0) > 0) attention.push({ label: `${failedServices} failed service${failedServices === 1 ? "" : "s"}`, view: "services" });
  for (const app of apps ?? []) {
    // Paused is a choice, not a fault: say so rather than nagging about something deliberate.
    // A leak outranks every other state this app could be in: it means traffic left the tunnel.
    if (app.vpnLeaked) attention.push({ label: `${app.name} leaked outside its VPN`, view: "catalog" });
    if (app.paused) attention.push({ label: `${app.name} is paused`, view: "catalog" });
    else if (!app.running) attention.push({ label: `${app.name} is not running`, view: "catalog" });
    // A folder the app cannot write to is a fault happening right now; an update can wait behind it.
    else if (app.folderProblems > 0) attention.push({ label: `${app.name} cannot write to its data folder`, view: "catalog" });
    else if (app.updateAvailable) attention.push({ label: `${app.name} has an update`, view: "catalog" });
  }
  // Repair keeps Activity with each job's steps; the Overview itself was a link back to this page.
  // One BoxPilot already ran again after a restart is not waiting on anyone (M30.2).
  const failedJob = (jobs ?? []).find((job) => job.state === "failed" && !ranAgain(job));
  if (failedJob) attention.push({ label: `${jobTimeout(failedJob) ? "Job ran out of time" : "Job failed"}: ${failedJob.title}`, view: "repairs" });
  const staleDays = (iso: string | null) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000)) : null);
  if (unprotected) attention.push({ label: unprotected, view: "backups" });
  const backupAgeDays = staleDays(backups?.lastBackupAt ?? null);
  if (backups && (backupAgeDays === null || backupAgeDays > 7)) attention.push({ label: backupAgeDays === null ? "No database backup yet" : `Last database backup is ${countOf(backupAgeDays, "day")} old`, view: "backups" });
  // Covers all three destinations, and the case of having none — which is the common one, and the
  // one the old drive-only check stayed quiet about.
  if (offBox) attention.push({ label: offBox, view: "backups" });

  return (
    <div className="home-dashboard">
      {unannounced.length > 0 && (
        <section className="notice warning-notice unannounced-notice" aria-label="Alerts that reached no one">
          <div className="unannounced-line">
            <strong>BoxPilot could not tell you about {countOf(unannounced.length, "thing")}</strong>
            <span className="unannounced-actions">
              <button type="button" className="text-button" aria-expanded={showUnannounced} onClick={() => setShowUnannounced((open) => !open)}>{showUnannounced ? "Hide the list" : "Show the list"}</button>
              <button type="button" className="text-button" onClick={() => onNavigate("settings")}>{targetConfigured ? "Check where alerts go" : "Set where alerts go"}</button>
            </span>
          </div>
          {showUnannounced && (
            <>
              <span>{targetConfigured
                ? `${unannounced.length === 1 ? "This has" : "These have"} not reached your notification target yet. BoxPilot tries again every 15 minutes.`
                : `No notification target is set, so ${unannounced.length === 1 ? "this" : "these"} reached no one.`}</span>
              <ul className="unannounced-list">
                {unannounced.map((alert, index) => (
                  <li key={`${alert.family}:${alert.title}:${index}`}>
                    <button type="button" className="text-button" onClick={() => onNavigate(watchView(alert.family))}>{alert.title}</button>
                    {alert.since && <span className="muted"> since {timeLabel(alert.since)}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {setup?.firstRun && rebuild && (
        <section className="panel">
          <header className="panel-header">
            <div>
              <strong>Rebuilding this server?</strong>
              <span>Found {rebuild.count === 1 ? "a machine snapshot" : `${rebuild.count} machine snapshots`} on <code>{rebuild.source}</code>. A snapshot reinstalls your apps with their settings and secrets, then restores their data. It is usually the fastest way back.</span>
            </div>
            <button className="primary-button" type="button" onClick={() => onNavigate("backups")}>Restore from a snapshot</button>
          </header>
        </section>
      )}
      {setup?.firstRun && (
        <section className="panel">
          <header className="panel-header">
            <div><strong>{rebuild ? "Or set it up fresh" : "Set up this server"}</strong><span>Nothing is installed yet. Pick what this box should be: home server, DNS appliance, hypervisor, dev box, or just the essentials, and BoxPilot installs the rest in order.</span></div>
            <button className="primary-button" type="button" onClick={() => onNavigate("setup")}>Choose a profile</button>
          </header>
        </section>
      )}
      <div className="metric-grid">
        <button type="button" className="panel metric-link" onClick={() => onNavigate("updates")}>
          <span className="eyebrow">Updates</span><strong>{updates ? updates.updates : "—"}</strong>
          <span>{updates?.rebootRequired ? "reboot pending" : updates?.security ? `${updates.security} security` : "packages waiting"}</span>
        </button>
        <button type="button" className="panel metric-link" onClick={() => onNavigate("services")}>
          <span className="eyebrow">Services</span><strong>{failedServices === null ? "—" : failedServices === 0 ? "Healthy" : failedServices}</strong>
          <span>{failedServices === null ? "could not be read" : failedServices ? "failed units need attention" : "no failed units"}</span>
        </button>
        <button type="button" className="panel metric-link" onClick={() => onNavigate("catalog")}>
          <span className="eyebrow">Apps</span><strong>{apps ? `${apps.filter((app) => app.running).length}/${apps.length}` : "—"}</strong>
          <span>running / installed</span>
        </button>
        <button type="button" className="panel metric-link" onClick={() => onNavigate("virtualization")}>
          <span className="eyebrow">VMs</span><strong>{vms ? `${vms.running}/${vms.total}` : "—"}</strong>
          <span>running / defined</span>
        </button>
        <button type="button" className="panel metric-link" onClick={() => onNavigate("backups")}>
          <span className="eyebrow">Backups</span><strong>{backups ? (backups.lastBackupAt ? timeLabel(backups.lastBackupAt) : "None") : "—"}</strong>
          <span>{backups?.syncReady ? (backups.lastSyncAt ? `mirrored ${timeLabel(backups.lastSyncAt)}` : "mirror never run") : "last database backup"}</span>
        </button>
      </div>

      {checklist && (
        <section className="panel checklist">
          <header className="panel-header">
            <div><strong>Set up your server</strong><span>{checklist.allEssentialDone ? `All ${checklist.total} essentials are in place.` : `${checklist.done} of ${checklist.total} essentials done${checklist.unknown ? `, ${checklist.unknown} could not be checked` : ""}. Each one is a few clicks; BoxPilot explains what it does before it runs.`}</span></div>
            <span className={`status-pill ${checklist.allEssentialDone ? "status-good" : "status-neutral"}`}>{checklist.done}/{checklist.total}</span>
          </header>
          <ul className="checklist-items">
            {checklist.items.filter((item) => !item.done || !checklist.allEssentialDone).map((item) => (
              <li key={item.id} className={item.done ? "done" : ""}>
                <span className="checklist-mark" aria-hidden="true">{item.done ? "✓" : item.known === false ? "?" : "○"}</span>
                <div>
                  <strong>{item.title}{item.optional && !item.done ? <span className="muted"> (optional)</span> : null}</strong>
                  <span className="muted">{item.known === false ? "BoxPilot could not check this just now." : item.detail}</span>
                </div>
                {!item.done && item.known !== false && <button type="button" className="secondary-button" onClick={() => onNavigate(item.view)}>Open</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {attention.length > 0 && (
        <section className="panel">
          <header className="panel-header"><div><strong>Needs attention</strong><span>{attention.length} item{attention.length === 1 ? "" : "s"}</span></div></header>
          <ul className="attention-list">
            {attention.map((item) => (
              <li key={item.label}><button type="button" className="text-button" onClick={() => onNavigate(item.view)}>{item.label}</button></li>
            ))}
          </ul>
        </section>
      )}

      {apps && apps.length > 0 && (
        <section className="panel">
          <header className="panel-header"><div><strong>Installed apps</strong><span>From the catalog. Click one to manage it.</span></div></header>
          <div className="dashboard-apps">
            {apps.map((app) => (
              <article key={app.id} className="dashboard-app">
                <button type="button" className="dashboard-app-name" onClick={() => onNavigate("catalog")}>
                  <strong>{app.name}</strong>
                  <span className={`status-pill ${app.running ? "status-good" : "status-danger"}`}>{app.running ? (app.health && app.health !== "none" ? app.health : "running") : "stopped"}</span>
                  {app.updateAvailable && <span className="status-pill status-warning">update</span>}
                </button>
                {app.url && <a href={app.url} target="_blank" rel="noreferrer">{app.url.replace(/^http:\/\//, "")}</a>}
              </article>
            ))}
          </div>
        </section>
      )}

      {setup && !setup.firstRun && (
        <p className="muted dashboard-setup-link"><button type="button" className="text-button" onClick={() => onNavigate("setup")}>Add more with a setup profile</button></p>
      )}

      {jobs && jobs.length > 0 && (
        <section className="panel">
          <header className="panel-header"><div><strong>Recent activity</strong><span>The Activity button in the top bar follows jobs live.</span></div></header>
          <ul className="dashboard-jobs">
            {jobs.map((job) => (
              <li key={job.id}>
                <span>{job.title}</span>
                <span className="activity-meta"><span className={`status-pill ${jobStatus(job).tone}`}>{jobStatus(job).label}</span><span className="activity-time">{timeLabel(job.createdAt)}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

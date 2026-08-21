import { useEffect, useState } from "react";
import type { ViewName } from "./data";
import { inspectOperation, type Job } from "./operations";

/**
 * Home dashboard (M8.1): what is on this box and what needs attention, one glance.
 * Every source loads independently; a failed one leaves its tile quiet instead of
 * breaking the page.
 */

interface AppSummary { id: string; name: string; running: boolean; installed: boolean; health: string; updateAvailable: boolean; url: string | null }
interface Tile { updates: number | null; security: number; rebootRequired: boolean }

const jobTone: Record<string, string> = { completed: "status-good", failed: "status-danger", applying: "status-warning", verifying: "status-warning" };

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
  const [setup, setSetup] = useState<{ firstRun: boolean; installedApps: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const guard = <T,>(setter: (value: T) => void) => (value: T) => { if (!cancelled) setter(value); };

    inspectOperation<{ count: number; securityCount: number; rebootRequired: boolean }>("apt.upgradable.inspect")
      .then(({ result }) => guard(setUpdates)({ updates: result.count, security: result.securityCount, rebootRequired: result.rebootRequired }))
      .catch(() => {});
    inspectOperation<{ counts: { failed: number } }>("service.list")
      .then(({ result }) => guard(setFailedServices)(result.counts.failed))
      .catch(() => {});
    fetch("/api/v1/catalog")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("catalog unavailable"))))
      .then((data: { applications: Array<{ manifest: { id: string; name: string }; live: { installed: boolean; container: { running: boolean; health: string }; updateAvailable?: boolean; urls: Array<{ host: number; exposure: string }> } | null }>; host: { lanAddress: string | null } }) => {
        const hostForLinks = data.host.lanAddress ?? window.location.hostname;
        guard(setApps)(data.applications
          .filter((entry) => entry.live?.installed)
          .map((entry) => ({
            id: entry.manifest.id,
            name: entry.manifest.name,
            installed: true,
            running: entry.live?.container.running ?? false,
            health: entry.live?.container.health ?? "",
            updateAvailable: entry.live?.updateAvailable ?? false,
            url: entry.live?.urls.length ? `http://${entry.live.urls[0].exposure === "loopback" ? "127.0.0.1" : hostForLinks}:${entry.live.urls[0].host}` : null,
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
    Promise.all([
      fetch("/api/v1/backups").then((response) => (response.ok ? response.json() : Promise.reject(new Error("backups unavailable")))),
      inspectOperation<{ sync: { mount: { mounted: boolean }; lastSync: { completedAt: string } | null } }>("host.snapshot.inspect").catch(() => null),
    ])
      .then(([list, machine]: [{ backups: Array<{ applicationId: string; createdAt: string }> }, { result: { sync: { mount: { mounted: boolean }; lastSync: { completedAt: string } | null } } } | null]) => {
        guard(setBackups)({
          lastBackupAt: list.backups.find((backup) => backup.applicationId === "boxpilot-controller")?.createdAt ?? null,
          lastSyncAt: machine?.result.sync.lastSync?.completedAt ?? null,
          syncReady: machine?.result.sync.mount.mounted ?? false,
        });
      })
      .catch(() => {});

    fetch("/api/v1/setup")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("setup unavailable"))))
      .then((data: { firstRun: boolean; installedApps: number }) => guard(setSetup)({ firstRun: data.firstRun, installedApps: data.installedApps }))
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  const attention: Array<{ label: string; view: ViewName }> = [];
  if (updates?.rebootRequired) attention.push({ label: "A reboot is pending", view: "updates" });
  if ((updates?.updates ?? 0) > 0) attention.push({ label: `${updates?.updates} update${updates?.updates === 1 ? "" : "s"} available${updates?.security ? ` (${updates.security} security)` : ""}`, view: "updates" });
  if ((failedServices ?? 0) > 0) attention.push({ label: `${failedServices} failed service${failedServices === 1 ? "" : "s"}`, view: "services" });
  for (const app of apps ?? []) {
    if (!app.running) attention.push({ label: `${app.name} is not running`, view: "catalog" });
    else if (app.updateAvailable) attention.push({ label: `${app.name} has an update`, view: "catalog" });
  }
  const failedJob = (jobs ?? []).find((job) => job.state === "failed");
  if (failedJob) attention.push({ label: `Job failed: ${failedJob.title}`, view: "overview" });
  const staleDays = (iso: string | null) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000)) : null);
  const backupAgeDays = staleDays(backups?.lastBackupAt ?? null);
  if (backups && (backupAgeDays === null || backupAgeDays > 7)) attention.push({ label: backupAgeDays === null ? "No database backup yet" : `Last database backup is ${backupAgeDays} days old`, view: "backups" });
  const syncAgeDays = staleDays(backups?.lastSyncAt ?? null);
  if (backups?.syncReady && (syncAgeDays === null || syncAgeDays > 7)) attention.push({ label: syncAgeDays === null ? "Backups have never been mirrored off-box" : `Off-box backup mirror is ${syncAgeDays} days old`, view: "backups" });

  return (
    <div className="home-dashboard">
      {setup?.firstRun && (
        <section className="panel">
          <header className="panel-header">
            <div><strong>Set up this server</strong><span>Nothing is installed yet. Pick what this box should be — home server, DNS appliance, hypervisor, dev box, or just the essentials — and BoxPilot installs the rest in order.</span></div>
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
          <span>{failedServices ? "failed units need attention" : "no failed units"}</span>
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
                <span className="activity-meta"><span className={`status-pill ${jobTone[job.state] ?? "status-neutral"}`}>{job.state.replace("_", " ")}</span><span className="activity-time">{timeLabel(job.createdAt)}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

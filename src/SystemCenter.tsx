import { useCallback, useEffect, useRef, useState } from "react";
import { useOperation } from "./ApproveDialog";
import UpsPanel from "./UpsPanel";
import SchedulesPanel from "./SchedulesPanel";
import { inspectOperation } from "./operations";
import { readJson } from "./http";

interface HousekeepingCategory { id: string; title: string; summary: string; items: number | null; bytes: number; humanBytes: string; detail: string[]; keeping: string[]; safe: boolean }
interface Housekeeping { generatedAt: string; categories: HousekeepingCategory[]; totalBytes: number; totalHumanBytes: string }
interface DockerDisk { available: boolean; rows: Array<{ type: string; total: number | string | null; active: number | string | null; size: string | null; reclaimable: string | null }>; logging?: { configured: boolean; logDriver: string | null; maxSize: string | null; liveRestore: boolean } }

interface SystemSettings {
  hostname: { static: string | null; live: string | null };
  timezone: string | null;
  timezones: string[];
  locale?: string | null;
  locales?: string[];
  swappiness: number | null;
  swap: Array<{ device: string; type: string; sizeKiB: number; usedKiB: number; priority: number }>;
  memory: { memTotalKiB: number | null; memAvailableKiB: number | null; swapTotalKiB: number | null; swapFreeKiB: number | null };
  fstrim: { active: string | null; enabled: string | null; nextRun: string | null };
}

function gib(kib: number | null): string {
  if (kib === null) return "—";
  return `${(kib / 1024 / 1024).toFixed(1)} GiB`;
}

interface ReleaseUpdate { current: { version: string }; latest: { tag: string; version: string; name: string; url: string; publishedAt: string | null; prerelease: boolean; notes: string | null } | null; updateAvailable: boolean; checkedAt: string; error: string | null }
interface UpdateStatus { units: Array<{ unit: string; active: string; sub: string }>; log: string[]; outcome: "running" | "live" | "failed" | null }

export default function SystemCenter({ csrfToken }: { csrfToken: string }) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [timezone, setTimezone] = useState("");
  const [locale, setLocale] = useState("");
  const [swappiness, setSwappiness] = useState("");

  const [dockerDisk, setDockerDisk] = useState<DockerDisk | null>(null);
  const [housekeeping, setHousekeeping] = useState<Housekeeping | null>(null);
  const [scanning, setScanning] = useState(false);
  const [chosenCleanup, setChosenCleanup] = useState<Set<string>>(new Set());
  const [release, setRelease] = useState<ReleaseUpdate | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateOutcome, setUpdateOutcome] = useState<"live" | "timeout" | null>(null);
  const updateTarget = useRef<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [checkingRelease, setCheckingRelease] = useState(false);
  /** Fields the owner has typed into, so a background refresh does not overwrite their work. */
  const edited = useRef<Set<string>>(new Set());

  const loadRelease = useCallback(async (refresh = false) => {
    setCheckingRelease(true);
    try {
      const response = await fetch(`/api/v1/system/update${refresh ? "?refresh=1" : ""}`);
      setRelease(await readJson<ReleaseUpdate>(response));
      setReleaseError(null);
    } catch (requestError) {
      setReleaseError(requestError instanceof Error ? requestError.message : "The release check is unavailable");
    } finally {
      setCheckingRelease(false);
    }
    inspectOperation<UpdateStatus>("system.update.status").then(({ result }) => setUpdateStatus(result)).catch(() => setUpdateStatus(null));
  }, []);

  useEffect(() => { void loadRelease(); }, [loadRelease]);

  // After the update job starts the detached build, poll health until the new version answers.
  useEffect(() => {
    if (!updating) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => {
      fetch("/api/v1/health").then((response) => (response.ok ? response.json() : null)).then((health: { version?: string } | null) => {
        if (health?.version === updating) { setUpdateOutcome("live"); window.clearInterval(timer); window.setTimeout(() => window.location.reload(), 1500); }
      }).catch(() => {});
      if (Date.now() - started > 10 * 60 * 1000) { setUpdateOutcome("timeout"); window.clearInterval(timer); }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [updating]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ result }, docker] = await Promise.all([
        inspectOperation<SystemSettings>("system.settings.inspect"),
        inspectOperation<DockerDisk>("docker.disk.inspect").catch(() => null),
      ]);
      setSettings(result);
      setDockerDisk(docker?.result && Array.isArray(docker.result.rows) ? docker.result : null);
      // Only adopt server values for fields the owner has not edited: refresh() also runs when an
      // unrelated job on this page finishes, and it used to wipe a half-typed hostname.
      if (!edited.current.has("hostname")) setHostname(result.hostname.static ?? "");
      if (!edited.current.has("timezone")) setTimezone(result.timezone ?? "");
      if (!edited.current.has("locale")) setLocale(result.locale ?? "");
      if (!edited.current.has("swappiness")) setSwappiness(result.swappiness === null ? "" : String(result.swappiness));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read system settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** What can be reclaimed, asked for once when the page opens and again on demand. */
  const scanHousekeeping = useCallback(async () => {
    setScanning(true);
    try {
      const { result } = await inspectOperation<Housekeeping>("housekeeping.inspect");
      setHousekeeping(result);
      setChosenCleanup(new Set());
    } catch {
      setHousekeeping(null);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => { void scanHousekeeping(); }, [scanHousekeeping]);

  const chosenHumanBytes = (() => {
    const bytes = (housekeeping?.categories ?? []).filter((category) => chosenCleanup.has(category.id)).reduce((sum, category) => sum + category.bytes, 0);
    if (bytes <= 0) return "nothing";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  })();

  const { start, dialog } = useOperation(csrfToken, (job) => {
    if (job.type === "op:system.update" && job.state === "completed" && updateTarget.current) setUpdating(updateTarget.current);
    void refresh();
  });

  const [swapFileGiB, setSwapFileGiB] = useState("4");
  const swapFileValue = Number.parseInt(swapFileGiB, 10);
  const swapFileValid = Number.isInteger(swapFileValue) && swapFileValue >= 1 && swapFileValue <= 64;

  const fstrimEnabled = settings?.fstrim.enabled === "enabled";
  const swappinessValue = Number.parseInt(swappiness, 10);
  const swappinessValid = Number.isInteger(swappinessValue) && swappinessValue >= 0 && swappinessValue <= 100;

  return (
    <div className="system-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Hostname</span><strong>{loading ? "…" : settings?.hostname.live ?? "—"}</strong><span>{settings && settings.hostname.static !== settings.hostname.live ? `static: ${settings.hostname.static}` : "static and live match"}</span></article>
        <article className="panel"><span className="eyebrow">Time zone</span><strong>{loading ? "…" : settings?.timezone ?? "unknown"}</strong><span>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} in your browser</span></article>
        <article className="panel"><span className="eyebrow">Memory</span><strong>{loading ? "…" : gib(settings?.memory.memAvailableKiB ?? null)}</strong><span>available of {gib(settings?.memory.memTotalKiB ?? null)}</span></article>
        <article className="panel"><span className="eyebrow">Swap</span><strong>{loading ? "…" : gib(settings?.memory.swapTotalKiB ?? null)}</strong><span>{settings?.memory.swapTotalKiB ? `${gib((settings.memory.swapTotalKiB ?? 0) - (settings.memory.swapFreeKiB ?? 0))} in use` : "no swap configured"}</span></article>
      </div>

      <section className="panel">
        <header className="panel-header">
          <div><strong>BoxPilot updates</strong><span>Running {release?.current.version ?? __BOXPILOT_VERSION__}. Releases come from GitHub: the update downloads the exact commit the release points at, builds it, swaps it in, restarts BoxPilot, and rolls back by itself if the new version fails its health check.</span></div>
          {release?.updateAvailable && release.latest && !updating && (
            <button className="primary-button" type="button" onClick={() => { const target = release.latest!; updateTarget.current = target.version; start({ operationId: "system.update", title: `Update BoxPilot to ${target.tag}`, parameters: { tag: target.tag }, confirmText: target.tag, preview: <span>Downloads the commit <code>{target.tag}</code> points at from GitHub, builds it, and swaps it in. BoxPilot restarts for about a minute; running jobs are interrupted, so let them finish first. If the new version does not answer its health check, the previous version is restored automatically.</span> }); }}>Update to {release.latest.tag}</button>
          )}
        </header>
        <div className="recovery-actions">
          <span className="muted">
            {releaseError ? `Release check unavailable: ${releaseError}`
              : checkingRelease && !release ? "Checking GitHub for releases…"
              : !release ? "The release check has not run yet."
              : release.latest ? `Latest release ${release.latest.tag}${release.latest.publishedAt ? ` (${new Date(release.latest.publishedAt).toLocaleDateString()})` : ""} — ${release.updateAvailable ? "newer than the installed version" : "you are up to date"}.`
              : release.error ? `Release check unavailable: ${release.error}` : "No releases have been published yet."}
          </span>
          {release?.latest && <a href={release.latest.url} target="_blank" rel="noreferrer">Release notes</a>}
          <button className="secondary-button" type="button" disabled={checkingRelease} onClick={() => void loadRelease(true)}>{checkingRelease ? "Checking…" : "Check again"}</button>
        </div>
        {updating && (
          <div className={updateOutcome === "timeout" ? "auth-error" : "surface-notice"} role="status">
            {updateOutcome === "live" ? `BoxPilot ${updating} is live — reloading.` : updateOutcome === "timeout" ? "The update is taking longer than ten minutes. Check the update log below; a failed health check restores the previous version automatically." : `Updating to ${updating}… BoxPilot restarts when the build finishes. This page reconnects by itself.`}
          </div>
        )}
        {updateStatus && updateStatus.log.length > 0 && (
          <details className="vm-domain-details">
            <summary>Last update log{updateStatus.outcome ? ` — ${updateStatus.outcome}` : ""}</summary>
            <pre className="app-logs">{updateStatus.log.join("\n")}</pre>
          </details>
        )}
      </section>

      <section className="panel">
        <header className="panel-header"><div><strong>Rename this server</strong><span>Sets the hostname and keeps /etc/hosts in step. Other machines that cached the old name keep using it until they look it up again.</span></div></header>
        <div className="recovery-actions">
          <input aria-label="New hostname" value={hostname} onChange={(event) => setHostname(event.target.value.toLowerCase())} placeholder="my-server" />
          <button className="primary-button" type="button" disabled={loading || !hostname || hostname === settings?.hostname.static} onClick={() => start({ operationId: "system.hostname.set", title: `Rename to ${hostname}`, parameters: { hostname }, preview: <span><code>hostnamectl set-hostname {hostname}</code>, then the <code>127.0.1.1</code> line in <code>/etc/hosts</code> is updated.</span> })}>Rename</button>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header"><div><strong>Time zone</strong><span>Log timestamps, cron schedules, and timers follow the system time zone.</span></div></header>
        <div className="recovery-actions">
          {settings && settings.timezones.length > 0 ? (
            <select aria-label="Time zone" value={timezone} onChange={(event) => { edited.current.add("timezone"); setTimezone(event.target.value); }}>
              {settings.timezone && !settings.timezones.includes(settings.timezone) && <option value={settings.timezone}>{settings.timezone}</option>}
              {settings.timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          ) : (
            <input aria-label="Time zone" value={timezone} onChange={(event) => { edited.current.add("timezone"); setTimezone(event.target.value); }} placeholder="Europe/Berlin" />
          )}
          <button className="primary-button" type="button" disabled={loading || !timezone || timezone === settings?.timezone} onClick={() => start({ operationId: "system.timezone.set", title: `Change time zone to ${timezone}`, parameters: { timezone }, preview: <span><code>timedatectl set-timezone {timezone}</code></span> })}>Change</button>
        </div>
      </section>

      {settings && (settings.locales?.length ?? 0) > 0 && (
        <section className="panel">
          <header className="panel-header"><div><strong>System language</strong><span>LANG for services and shells. Only locales already generated on this system are offered.</span></div></header>
          <div className="recovery-actions">
            <select aria-label="System locale" value={locale} onChange={(event) => { edited.current.add("locale"); setLocale(event.target.value); }}>
              {settings.locale && !settings.locales?.includes(settings.locale) && <option value={settings.locale}>{settings.locale}</option>}
              {settings.locales?.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
            <button className="primary-button" type="button" disabled={loading || !locale || locale === settings.locale} onClick={() => start({ operationId: "system.locale.set", title: `Set the system language to ${locale}`, parameters: { locale }, preview: <span><code>update-locale LANG={locale}</code>. New sessions and restarted services pick it up.</span> })}>Change</button>
          </div>
        </section>
      )}

      <section className="panel">
        <header className="panel-header"><div><strong>Swap and memory pressure</strong><span>Swappiness {settings?.swappiness ?? "—"} today. Lower values keep more in RAM; 10 suits most servers, 60 is the Ubuntu default.</span></div></header>
        <div className="recovery-actions">
          <input aria-label="Swappiness" inputMode="numeric" value={swappiness} onChange={(event) => { edited.current.add("swappiness"); setSwappiness(event.target.value); }} placeholder="10" />
          <button className="primary-button" type="button" disabled={loading || !swappinessValid || swappinessValue === settings?.swappiness} onClick={() => start({ operationId: "system.swappiness.set", title: `Set swappiness to ${swappinessValue}`, parameters: { value: swappinessValue }, preview: <span>Applies now with <code>sysctl</code> and persists in <code>/etc/sysctl.d/99-boxpilot.conf</code>.</span> })}>Apply</button>
        </div>
        {settings && settings.swap.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Swap device</th><th>Type</th><th>Size</th><th>In use</th></tr></thead>
              <tbody>{settings.swap.map((device) => <tr key={device.device}><td><code>{device.device}</code></td><td>{device.type}</td><td>{gib(device.sizeKiB)}</td><td>{gib(device.usedKiB)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {settings && (settings.swap.some((device) => device.device === "/swap.boxpilot") ? (
          <div className="recovery-actions">
            <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "storage.swapfile.set", title: "Remove the swap file", parameters: { remove: true }, preview: <span>Turns off and deletes <code>/swap.boxpilot</code> and removes its fstab entry. Other swap devices are untouched.</span> })}>Remove swap file</button>
          </div>
        ) : (
          <div className="recovery-actions">
            <input aria-label="Swap file size in GiB" inputMode="numeric" placeholder="4" value={swapFileGiB} onChange={(event) => setSwapFileGiB(event.target.value.trim())} />
            <button className="secondary-button" type="button" disabled={loading || !swapFileValid} onClick={() => start({ operationId: "storage.swapfile.set", title: `Create a ${swapFileValue} GiB swap file`, parameters: { sizeGiB: swapFileValue }, preview: <span>Creates <code>/swap.boxpilot</code> ({swapFileValue} GiB), adds a nofail fstab entry, and enables it.</span> })}>Create swap file</button>
          </div>
        ))}
      </section>

      <section className="panel">
        <header className="panel-header">
          <div>
            <strong>Housekeeping</strong>
            <span>{housekeeping ? `${housekeeping.totalHumanBytes} can be reclaimed. Pick what to clear — nothing else is touched.` : "What is taking up room that nothing needs any more."}</span>
          </div>
          <div className="recovery-actions">
            <button className="text-button" type="button" disabled={scanning} onClick={() => void scanHousekeeping()}>{scanning ? "Looking…" : "Rescan"}</button>
            <button
              className="primary-button"
              type="button"
              disabled={loading || chosenCleanup.size === 0}
              onClick={() => start({
                operationId: "housekeeping.reclaim",
                title: `Reclaim ${chosenHumanBytes}`,
                parameters: { targets: [...chosenCleanup] },
                preview: (
                  <span>
                    Removes {[...chosenCleanup].map((id) => housekeeping?.categories.find((category) => category.id === id)?.title.toLowerCase()).filter(Boolean).join(", ")} — about {chosenHumanBytes}.
                    Images a container uses, the release a failed update would roll back to, and the newest backups of each app are not touched.
                  </span>
                ),
              })}
            >Reclaim {chosenCleanup.size > 0 ? chosenHumanBytes : "space"}</button>
          </div>
        </header>
        {!housekeeping && <p className="muted">{scanning ? "Working out what can go…" : "Press Rescan to look."}</p>}
        {housekeeping && (
          <ul className="housekeeping-list">
            {housekeeping.categories.map((category) => (
              <li key={category.id} className={category.bytes > 0 ? "" : "is-empty"}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosenCleanup.has(category.id)}
                    disabled={category.bytes === 0 || !category.safe}
                    onChange={(event) => setChosenCleanup((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(category.id); else next.delete(category.id);
                      return next;
                    })}
                  />
                  <div>
                    <strong>{category.title}</strong>
                    <span className="housekeeping-size">{category.bytes > 0 ? category.humanBytes : "nothing to clear"}{category.items !== null && category.items > 0 ? ` · ${category.items} item${category.items === 1 ? "" : "s"}` : ""}</span>
                    <span className="muted">{category.summary}</span>
                    {category.keeping.length > 0 && <span className="muted">Keeping: {category.keeping.join(", ")}.</span>}
                    {category.detail.length > 0 && <details><summary>What exactly</summary><span className="muted">{category.detail.join(" · ")}</span></details>}
                  </div>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dockerDisk?.available && (
        <section className="panel">
          <header className="panel-header">
            <div><strong>Docker disk use</strong><span>How Docker accounts for its own space. Shared layers mean the reclaimable figure is usually well under the sum of the sizes.</span></div>
          </header>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Type</th><th>Total</th><th>Active</th><th>Size</th><th>Reclaimable</th></tr></thead>
              <tbody>{dockerDisk.rows.map((row) => <tr key={row.type}><td>{row.type}</td><td>{row.total ?? "—"}</td><td>{row.active ?? "—"}</td><td>{row.size ?? "—"}</td><td>{row.reclaimable ?? "—"}</td></tr>)}</tbody>
            </table>
          </div>
          {dockerDisk.logging && !dockerDisk.logging.configured && (
            <div className="recovery-actions">
              <span className="muted">Container logs are unlimited right now — a chatty container can fill the disk.</span>
              <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "docker.logging.set", title: "Apply Docker log rotation defaults", parameters: {}, preview: <span>Sets the daemon default to 3 × 10 MB per container — for containers created from now on, not existing ones — and turns on live-restore, then restarts dockerd. Running containers restart briefly this one time; future daemon restarts leave them running.</span> })}>Apply log rotation defaults</button>
            </div>
          )}
          {dockerDisk.logging?.configured && <p className="muted">Log rotation: {dockerDisk.logging.maxSize} per file{dockerDisk.logging.liveRestore ? " · live-restore on" : ""}. Applies to containers created after it was set.</p>}
        </section>
      )}

      <UpsPanel start={start} />
      <section className="panel">
        <header className="panel-header">
          <div><strong>SSD trim timer</strong><span>{fstrimEnabled ? `fstrim.timer is enabled${settings?.fstrim.nextRun ? `; next run ${settings.fstrim.nextRun}` : ""}.` : "fstrim.timer is disabled. Weekly trim keeps SSDs fast and healthy."}</span></div>
          <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "service.action", title: fstrimEnabled ? "Disable weekly trim" : "Enable weekly trim", parameters: { unit: "fstrim.timer", action: fstrimEnabled ? "disable" : "enable" }, preview: <span><code>systemctl {fstrimEnabled ? "disable" : "enable"} fstrim.timer</code></span> })}>{fstrimEnabled ? "Disable" : "Enable"}</button>
        </header>
      </section>

      <SchedulesPanel csrfToken={csrfToken} />
    </div>
  );
}

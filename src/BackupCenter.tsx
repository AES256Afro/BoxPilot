import { useCallback, useEffect, useState, useRef } from "react";
import { useOperation } from "./ApproveDialog";
import CloudBackupPanel from "./CloudBackupPanel";
import RestorePanel from "./RestorePanel";
import { inspectOperation } from "./operations";
import { readJson } from "./http";
import { judgeProtection, type AppProtection, type ProtectionVerdict, type ScheduleLike } from "./backupProtection";

interface BackupRecord { id: string; applicationId: string; destination: string; checksumSha256: string; sizeBytes: number; downtimeMs: number; restoreDrill: { passed?: boolean } | null; createdAt: string }
interface ControllerProtection { id: string; backupId: string; snapshotId?: string; createdAt: string; protected?: boolean; retained?: boolean }
interface ProtectionState { destination: { ready?: boolean; encrypted?: boolean; repositoryId?: string | null; blockers?: string[] } | null; protections: ControllerProtection[] }
interface RetentionStatus { policy?: { minimumCopies?: number; minimumAgeDays?: number }; candidates?: unknown[]; beforeCount?: number }
interface MachineSnapshot { artifact: string; sizeBytes: number | null; checksumSha256: string | null; createdAt: string | null; contents: { apps?: unknown[]; vms?: { domains?: string[] } } | null }
interface RemoteMirrorState { keyReady: boolean; publicKey: string | null; fingerprint: string | null; hostKeysPinned: number; rsyncInstalled: boolean }
interface RemoteDestination { host: string; port: number; user: string; path: string }
interface RemoteSettings { destination: RemoteDestination | null; lastSync: { completedAt: string; filesTransferred: number; bytesTransferred: number; destination: string } | null }
interface MachineSnapshotState {
  snapshots: MachineSnapshot[];
  keep: number;
  sync: { destination: string; mount: { mounted: boolean; blocker?: string | null; freeBytes?: number | null }; lastSync: { completedAt: string; copiedCount: number } | null };
}

const requestJson = async <T,>(url: string, options?: RequestInit): Promise<T> => readJson<T>(await fetch(url, options));

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

/**
 * Backups home: BoxPilot's own database. Per-app backups live on each catalog card, and VM
 * protection lives on the Virtual Machines page.
 */
export default function BackupCenter({ csrfToken }: { csrfToken: string; onOpenRepair?: () => void }) {
  const [appProtection, setAppProtection] = useState<{ verdicts: ProtectionVerdict[]; available: boolean } | null>(null);
  const [protecting, setProtecting] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [machine, setMachine] = useState<MachineSnapshotState | null>(null);
  const [remote, setRemote] = useState<RemoteMirrorState | null>(null);
  const [remoteSettings, setRemoteSettings] = useState<RemoteSettings | null>(null);
  const [form, setForm] = useState<RemoteDestination & { password: string }>({ host: "", port: 22, user: "", path: "", password: "" });
  const formTouched = useRef(false);
  const editForm = (patch: Partial<RemoteDestination & { password: string }>) => { formTouched.current = true; setForm((current) => ({ ...current, ...patch })); };
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, protectionState, retentionState, machineState, remoteState, remoteConfig] = await Promise.all([
        requestJson<{ backups: BackupRecord[] }>("/api/v1/backups"),
        requestJson<ProtectionState>("/api/v1/controller-backup-protection").catch(() => null),
        requestJson<RetentionStatus>("/api/v1/controller-backup-retention").catch(() => null),
        requestJson<{ result: MachineSnapshotState }>("/api/v1/operations/host.snapshot.inspect/inspect").then((body) => body.result).catch(() => null),
        requestJson<{ result: RemoteMirrorState }>("/api/v1/operations/backup.remote.inspect/inspect").then((body) => body.result).catch(() => null),
        requestJson<RemoteSettings>("/api/v1/settings/backup-destination").catch(() => null),
      ]);
      setBackups(list.backups.filter((backup) => backup.applicationId === "boxpilot-controller"));
      setProtection(protectionState);
      setRetention(retentionState);
      setMachine(machineState);
      setRemote(remoteState);
      setRemoteSettings(remoteConfig);
      // Seed the form from the saved destination only while the owner has not started editing it.
      if (remoteConfig?.destination && !formTouched.current) setForm((current) => ({ ...current, ...remoteConfig.destination!, password: current.password }));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load backup state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const [panelRefresh, setPanelRefresh] = useState(0);
  /** Which apps have a backup, and which have something that keeps making them. */
  const loadProtection = useCallback(async () => {
    try {
      const [result, scheduleList] = await Promise.all([
        inspectOperation<{ available: boolean; apps: AppProtection[] }>("app.backup.protection"),
        fetch("/api/v1/schedules").then((response) => (response.ok ? response.json() : { schedules: [] })).catch(() => ({ schedules: [] })),
      ]);
      setAppProtection({ available: result.result.available, verdicts: judgeProtection(result.result.apps, (scheduleList as { schedules: ScheduleLike[] }).schedules ?? []) });
    } catch {
      setAppProtection(null);
    }
  }, []);
  useEffect(() => { void loadProtection(); }, [loadProtection]);

  /**
   * Give every unscheduled app a nightly backup, an hour apart so a dozen of them do not all stop
   * their containers at three in the morning together. Each schedule is its own request, so a
   * refusal on one does not cost the others; what succeeded is reported rather than assumed.
   */
  const protectEverything = async (targets: ProtectionVerdict[]) => {
    setProtecting("Setting up nightly backups…");
    let created = 0;
    const failures: string[] = [];
    for (const [index, target] of targets.entries()) {
      try {
        const response = await fetch("/api/v1/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
          body: JSON.stringify({ operationId: "app.backup", parameters: { id: target.id }, frequency: "daily", minute: (index * 7) % 60, hour: (2 + index) % 24 }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "refused");
        created += 1;
      } catch (requestError) {
        failures.push(`${target.name}: ${requestError instanceof Error ? requestError.message : "failed"}`);
      }
    }
    setProtecting(failures.length
      ? `Scheduled ${created} of ${targets.length}. ${failures.join("; ")}`
      : `Scheduled nightly backups for ${created} app${created === 1 ? "" : "s"}. The first runs tonight.`);
    await loadProtection();
  };

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); setPanelRefresh((key) => key + 1); });

  const protectBackup = (backupId: string) => {
    start({
      operationId: "controller.backup.protect",
      title: "Protect the backup independently",
      parameters: { backupId },
      preview: <span>Copies the verified backup into the separate encrypted restic repository, reads the whole repository back, and restore-drills the exact snapshot with no network. Nothing is pruned or overwritten.</span>,
    });
  };

  const saveDestination = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch("/api/v1/settings/backup-destination", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ password: form.password, destination: { host: form.host.trim(), port: Number(form.port) || 22, user: form.user.trim(), path: form.path.trim() } }) });
      const body = (await response.json().catch(() => ({}))) as RemoteSettings & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save the destination");
      setRemoteSettings(body);
      editForm({ password: "" });
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "Could not save the destination");
    } finally {
      setSaving(false);
    }
  };

  const latest = backups[0] ?? null;
  // A copy the retention run forgot is no longer in the repository, so it is not a protected copy.
  const liveProtections = (protection?.protections ?? []).filter((entry) => entry.retained !== false && entry.protected !== false);
  const protectedIds = new Set(liveProtections.map((entry) => entry.backupId));
  // A backup can be protected once. Where retention has since forgotten that copy, offering the
  // button again just produces an error, so the row says what happened instead.
  const forgottenIds = new Set((protection?.protections ?? []).filter((entry) => entry.retained === false).map((entry) => entry.backupId));
  const destinationReady = Boolean(protection?.destination?.ready);

  return (
    <div className="backup-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        <article className="panel">
          <span className="eyebrow">BoxPilot database</span>
          <strong>{loading ? "…" : backups.length}</strong>
          <span>{latest ? `latest ${new Date(latest.createdAt).toLocaleString()}` : "verified local snapshots"}</span>
          <div className="recovery-actions">
            <button className="primary-button" type="button" disabled={loading} onClick={() => start({ operationId: "controller.backup.create", title: "Back up the BoxPilot database", parameters: {}, preview: <span>Snapshots the live database with <code>VACUUM INTO</code> (no downtime) and restore-drills the copy before recording it.</span> })}>Back up now</button>
          </div>
        </article>
        <article className="panel">
          <span className="eyebrow">Independent copies</span>
          <strong>{loading ? "…" : protection ? liveProtections.length : "—"}</strong>
          <span>{destinationReady ? "encrypted restic repository ready" : protection?.destination?.blockers?.[0] ?? "restic repository needs terminal setup"}</span>
        </article>
        <article className="panel">
          <span className="eyebrow">Everything else</span>
          <span>App data backs up from each card in the <strong>App catalog</strong> (schedulable on the System page). VM protection lives on the <strong>Virtual Machines</strong> page.</span>
        </article>
      </div>

      <section className="panel">
        <header className="panel-header"><div><strong>Database snapshots</strong><span>Each snapshot passed an isolated restore drill before it was recorded. Protect copies one into the encrypted restic repository.</span></div></header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Created</th><th>Size</th><th>Drill</th><th>Independent copy</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {loading && backups.length === 0 ? <tr><td colSpan={5}>Loading backups...</td></tr> : null}
              {!loading && backups.length === 0 ? <tr><td colSpan={5}>No database backups yet. One click above creates and verifies the first.</td></tr> : null}
              {backups.map((backup) => (
                <tr key={backup.id}>
                  <td>{new Date(backup.createdAt).toLocaleString()}</td>
                  <td>{formatBytes(backup.sizeBytes)}</td>
                  <td>{backup.restoreDrill?.passed ? <span className="status-pill status-good">passed</span> : <span className="status-pill status-warning">unverified</span>}</td>
                  <td>{protectedIds.has(backup.id) ? <span className="status-pill status-good">protected</span> : forgottenIds.has(backup.id) ? <span className="status-pill status-neutral" title="Retention removed the encrypted copy of this backup">copy removed</span> : "—"}</td>
                  <td>{!protectedIds.has(backup.id) && !forgottenIds.has(backup.id) && destinationReady ? <button className="text-button" type="button" onClick={() => protectBackup(backup.id)}>Protect</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {retention?.policy && (
          <div className="recovery-actions">
            <span className="muted">Retention keeps at least {retention.policy.minimumCopies ?? 3} independent copies; {retention.candidates?.length ?? 0} snapshot(s) currently eligible for forgetting.</span>
            {(retention.candidates?.length ?? 0) > 0 && <button className="secondary-button" type="button" onClick={() => start({ operationId: "controller.backup.retention.apply", title: "Apply controller backup retention", parameters: {}, preview: <span>Forgets only the currently eligible old snapshots and verifies the repository afterwards. Never prunes.</span> })}>Apply retention</button>}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel-header">
          <div><strong>Machine snapshot</strong><span>One archive to redeploy this box: the database, every app's settings and secrets, network and firewall config, and each VM's definition. App data stays in per-app backups.</span></div>
          <button className="primary-button" type="button" disabled={loading} onClick={() => start({ operationId: "host.snapshot.create", title: "Create a machine snapshot", parameters: {}, preview: <span>Takes a fresh verified database backup and bundles it with every installed app's compose project (settings and secrets), netplan, firewall rules, fstab, and VM definitions. The archive contains secrets — keep copies only on encrypted or physically controlled media. The newest {machine?.keep ?? 3} snapshots are kept.</span> })}>Create machine snapshot</button>
        </header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Created</th><th>Size</th><th>Apps</th><th>VMs</th><th>SHA-256</th></tr></thead>
            <tbody>
              {(machine?.snapshots ?? []).length === 0 ? <tr><td colSpan={5}>{machine ? "No machine snapshots yet. One click above creates the first." : "Machine snapshot state is unavailable."}</td></tr> : null}
              {(machine?.snapshots ?? []).map((snapshot) => (
                <tr key={snapshot.artifact}>
                  <td>{snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : snapshot.artifact}</td>
                  <td>{snapshot.sizeBytes ? formatBytes(snapshot.sizeBytes) : "—"}</td>
                  <td>{snapshot.contents?.apps?.length ?? "—"}</td>
                  <td>{snapshot.contents?.vms?.domains?.length ?? "—"}</td>
                  <td>{snapshot.checksumSha256 ? <code>{snapshot.checksumSha256.slice(0, 16)}...</code> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="recovery-actions">
          {machine?.sync.mount.mounted ? (
            <>
              <span className="muted">Off-box mirror on the backup drive{machine.sync.lastSync ? ` — last synced ${new Date(machine.sync.lastSync.completedAt).toLocaleString()}` : " — never synced"}. Copies are hash-verified and never deleted.</span>
              <button className="secondary-button" type="button" onClick={() => start({ operationId: "backup.sync", title: "Mirror local backups to the backup drive", parameters: {}, preview: <span>Copies the local backup folders (database backups, app backups, machine snapshots) onto the independent backup drive and verifies every copied file's hash. Nothing on the drive is ever deleted.</span> })}>Sync to backup drive</button>
            </>
          ) : (
            <span className="muted">{machine?.sync.mount.blocker ?? "Mount an independent backup drive (Storage page) to enable the off-box mirror."}</span>
          )}
          <span className="muted">Recurring snapshots and syncs can be scheduled on the System page.</span>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <div>
            <strong>What your apps' data is protected by</strong>
            <span>A backup that exists is not the same as one that keeps being made. Apps whose only data is a cache or re-downloadable models are left out.</span>
          </div>
          {appProtection && appProtection.verdicts.some((verdict) => !verdict.scheduled) && (
            <button className="primary-button" type="button" disabled={Boolean(protecting)}
              onClick={() => void protectEverything(appProtection.verdicts.filter((verdict) => !verdict.scheduled))}>
              Back up everything nightly
            </button>
          )}
        </header>
        {protecting && <p className="muted">{protecting}</p>}
        {!appProtection ? <p className="muted">Reading…</p>
          : !appProtection.available ? <p className="muted">The backup folder could not be read, so protection is unknown. Nothing is assumed either way.</p>
          : appProtection.verdicts.length === 0 ? <p className="muted">No installed app holds data that needs backing up yet.</p>
          : (
          <table className="perf-table">
            <thead><tr><th>App</th><th>Last backup</th><th>Keeps happening</th></tr></thead>
            <tbody>
              {[...appProtection.verdicts]
                .sort((left, right) => Number(left.state === "ok") - Number(right.state === "ok") || left.name.localeCompare(right.name))
                .map((verdict) => (
                <tr key={verdict.id}>
                  <td>{verdict.name}</td>
                  <td>
                    {verdict.state === "never"
                      ? <span className="status-pill status-warning">never</span>
                      : <span className={`status-pill ${verdict.state === "ok" ? "status-good" : "status-warning"}`}>{verdict.ageDays === 0 ? "today" : `${verdict.ageDays}d ago`}</span>}
                  </td>
                  <td>
                    {verdict.scheduled
                      ? <span className="muted">nightly</span>
                      : <button className="text-button" type="button" onClick={() => void protectEverything([verdict])}>Schedule it</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RestorePanel csrfToken={csrfToken} start={start} />
      <section className="panel">
        <header className="panel-header">
          <div><strong>Off-box destination over SSH</strong><span>Mirror the backup folders to another machine with rsync over SSH. BoxPilot generates its own key; you authorize the public half on the destination. Nothing is ever deleted there, and no password is stored here.</span></div>
        </header>
        <div className="recovery-actions">
          {remote?.keyReady
            ? <span className="muted">Mirror key ready{remote.fingerprint ? ` (${remote.fingerprint})` : ""}. Add this public key to <code>~/.ssh/authorized_keys</code> for the destination user:</span>
            : <><span className="muted">Step 1 — create the mirror key on this server.</span><button className="secondary-button" type="button" onClick={() => start({ operationId: "backup.remote.setup", title: "Create the off-box mirror key", parameters: {}, preview: <span>Generates an ed25519 key pair under <code>/etc/boxpilot/secrets</code>. The private key never leaves this server.</span> })}>Create key</button></>}
        </div>
        {remote?.publicKey && <pre className="app-logs" aria-label="Mirror public key">{remote.publicKey}</pre>}
        <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); void saveDestination(); }}>
          <input aria-label="Destination host" placeholder="host or IP" value={form.host} onChange={(event) => editForm({ host: event.target.value })} required />
          <input aria-label="Destination port" type="number" min={1} max={65535} value={form.port} onChange={(event) => editForm({ port: Number(event.target.value) })} style={{ width: "6em" }} />
          <input aria-label="Destination user" placeholder="user" value={form.user} onChange={(event) => editForm({ user: event.target.value })} required />
          <input aria-label="Destination path" placeholder="/absolute/path" value={form.path} onChange={(event) => editForm({ path: event.target.value })} required />
          <input aria-label="Owner password" type="password" placeholder="owner password" autoComplete="current-password" value={form.password} onChange={(event) => editForm({ password: event.target.value })} required />
          <button className="secondary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save destination"}</button>
        </form>
        {formError && <div className="auth-error" role="alert">{formError}</div>}
        <div className="recovery-actions">
          {remoteSettings?.destination
            ? <span className="muted">Destination <code>{remoteSettings.destination.user}@{remoteSettings.destination.host}:{remoteSettings.destination.path}</code>{remoteSettings.lastSync ? ` — last mirrored ${new Date(remoteSettings.lastSync.completedAt).toLocaleString()} (${remoteSettings.lastSync.filesTransferred} files)` : " — never mirrored"}.</span>
            : <span className="muted">Step 2 — save where the backups should go.</span>}
          {remoteSettings?.destination && remote?.keyReady && <button className="secondary-button" type="button" onClick={() => start({ operationId: "backup.remote.test", title: "Test the off-box destination", parameters: {}, preview: <span>Connects as <code>{remoteSettings.destination!.user}@{remoteSettings.destination!.host}</code>, creates <code>{remoteSettings.destination!.path}</code> if needed, checks it is writable, and pins the destination's host key on first use.</span> })}>Test connection</button>}
          {remoteSettings?.destination && remote?.keyReady && (remote.rsyncInstalled
            ? <button className="primary-button" type="button" disabled={remote.hostKeysPinned === 0} title={remote.hostKeysPinned === 0 ? "Test the connection first" : undefined} onClick={() => start({ operationId: "backup.remote.sync", title: "Mirror backups off-box", parameters: {}, preview: <span>rsync pushes the database backups, app backups, and machine snapshots to <code>{remoteSettings.destination!.host}</code> with checksum verification. Nothing on the destination is deleted. Schedule it on the System page to keep it current.</span> })}>Mirror now</button>
            : <button className="secondary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install rsync", parameters: { packages: ["rsync"] }, preview: <span>Installs the <code>rsync</code> package from Ubuntu's repositories; the mirror needs it on this server.</span> })}>Install rsync</button>)}
        </div>
      </section>
      <CloudBackupPanel start={start} refreshKey={panelRefresh} />
    </div>
  );
}

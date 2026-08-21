import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";
import RestorePanel from "./RestorePanel";
import { inspectOperation } from "./operations";

interface BackupRecord { id: string; applicationId: string; destination: string; checksumSha256: string; sizeBytes: number; downtimeMs: number; restoreDrill: { passed?: boolean } | null; createdAt: string }
interface ControllerProtection { id: string; backupId: string; snapshotId?: string; createdAt: string }
interface ProtectionState { destination: { mounted?: boolean; repositoryInitialized?: boolean } | null; protections: ControllerProtection[] }
interface RetentionStatus { policy?: { minimumCopies?: number; minimumAgeDays?: number }; candidates?: unknown[]; beforeCount?: number }
interface MachineSnapshot { artifact: string; sizeBytes: number | null; checksumSha256: string | null; createdAt: string | null; contents: { apps?: unknown[]; vms?: { domains?: string[] } } | null }
interface MachineSnapshotState {
  snapshots: MachineSnapshot[];
  keep: number;
  sync: { destination: string; mount: { mounted: boolean; blocker?: string | null; freeBytes?: number | null }; lastSync: { completedAt: string; copiedCount: number } | null };
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

/**
 * Backups home: BoxPilot's own database. Per-app backups live on each catalog card, and VM
 * protection lives on the Virtual Machines page.
 */
export default function BackupCenter({ csrfToken }: { csrfToken: string; onOpenRepair?: () => void }) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [machine, setMachine] = useState<MachineSnapshotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, protectionState, retentionState, machineState] = await Promise.all([
        requestJson<{ backups: BackupRecord[] }>("/api/v1/backups"),
        requestJson<ProtectionState>("/api/v1/controller-backup-protection").catch(() => null),
        requestJson<RetentionStatus>("/api/v1/controller-backup-retention").catch(() => null),
        requestJson<{ result: MachineSnapshotState }>("/api/v1/operations/host.snapshot.inspect/inspect").then((body) => body.result).catch(() => null),
      ]);
      setBackups(list.backups.filter((backup) => backup.applicationId === "boxpilot-controller"));
      setProtection(protectionState);
      setRetention(retentionState);
      setMachine(machineState);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load backup state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });

  const protectBackup = (backupId: string) => {
    start({
      operationId: "controller.backup.protect",
      title: "Protect the backup independently",
      parameters: { backupId },
      preview: <span>Copies the verified backup into the separate encrypted restic repository, reads the whole repository back, and restore-drills the exact snapshot with no network. Nothing is pruned or overwritten.</span>,
    });
  };

  const latest = backups[0] ?? null;
  const protectedIds = new Set((protection?.protections ?? []).map((entry) => entry.backupId));

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
          <strong>{loading ? "…" : protection?.protections.length ?? "—"}</strong>
          <span>{protection?.destination?.repositoryInitialized ? "encrypted restic repository ready" : "restic repository needs terminal setup"}</span>
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
                  <td>{protectedIds.has(backup.id) ? <span className="status-pill status-good">protected</span> : "—"}</td>
                  <td>{!protectedIds.has(backup.id) && protection?.destination?.repositoryInitialized ? <button className="text-button" type="button" onClick={() => protectBackup(backup.id)}>Protect</button> : null}</td>
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

      <RestorePanel csrfToken={csrfToken} start={start} />
    </div>
  );
}

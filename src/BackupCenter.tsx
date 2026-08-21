import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface BackupRecord { id: string; applicationId: string; destination: string; checksumSha256: string; sizeBytes: number; downtimeMs: number; restoreDrill: { passed?: boolean } | null; createdAt: string }
interface ControllerProtection { id: string; backupId: string; snapshotId?: string; createdAt: string }
interface ProtectionState { destination: { mounted?: boolean; repositoryInitialized?: boolean } | null; protections: ControllerProtection[] }
interface RetentionStatus { policy?: { minimumCopies?: number; minimumAgeDays?: number }; candidates?: unknown[]; beforeCount?: number }
interface ProtectionPlan { id: string; revision: string }

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
export default function BackupCenter({ csrfToken, onOpenRepair }: { csrfToken: string; onOpenRepair: () => void }) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, protectionState, retentionState] = await Promise.all([
        requestJson<{ backups: BackupRecord[] }>("/api/v1/backups"),
        requestJson<ProtectionState>("/api/v1/controller-backup-protection").catch(() => null),
        requestJson<RetentionStatus>("/api/v1/controller-backup-retention").catch(() => null),
      ]);
      setBackups(list.backups.filter((backup) => backup.applicationId === "boxpilot-controller"));
      setProtection(protectionState);
      setRetention(retentionState);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load backup state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });

  // Independent restic protection still uses the reviewed plan flow and the Repair Center desk.
  const protectLatest = async (backupId: string) => {
    setPending(true);
    setError(null);
    try {
      const { plan } = await requestJson<{ plan: ProtectionPlan }>(`/api/v1/controller-backups/${backupId}/protection-plans`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: "{}",
      });
      await requestJson(`/api/v1/controller-protection-plans/${plan.id}/stage`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ revision: plan.revision }),
      });
      onOpenRepair();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Protection staging failed");
    } finally {
      setPending(false);
    }
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
                  <td>{!protectedIds.has(backup.id) && protection?.destination?.repositoryInitialized ? <button className="text-button" type="button" disabled={pending} onClick={() => void protectLatest(backup.id)}>Protect</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {retention?.policy && <p className="muted">Retention keeps at least {retention.policy.minimumCopies ?? 3} independent copies; {retention.candidates?.length ?? 0} snapshot(s) currently eligible for forgetting.</p>}
      </section>
    </div>
  );
}

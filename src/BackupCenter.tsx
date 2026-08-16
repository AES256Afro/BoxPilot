import { useCallback, useEffect, useState } from "react";

type BackupRecord = {
  id: string;
  applicationId: string;
  destination: string;
  artifactPath: string;
  checksumSha256: string;
  sizeBytes: number;
  downtimeMs: number;
  restoreDrill: { passed: boolean; network?: string; publishedPorts?: number; manifestChecksumSha256?: string };
  createdAt: string;
  verifiedAt: string;
};

type Coverage = {
  applicationId: string;
  name: string;
  sourceKind: "controller-state" | "application-state";
  source: { installed: boolean; healthy?: boolean; state: string; detail: string };
  state: "not-installed" | "unprotected" | "verified";
  protected: boolean;
  latestBackup: BackupRecord | null;
  requirement: string;
};

type BackupPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: {
    executable: boolean;
    destination: string;
    blockers: Array<{ id: string; summary: string }>;
    changes: string[];
    warnings: string[];
    recovery: string;
  };
};

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

export default function BackupCenter({ csrfToken, onOpenRepair }: { csrfToken: string; onOpenRepair: () => void }) {
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const body = await requestJson<{ coverage: Coverage[]; backups: BackupRecord[]; limitations: string[] }>("/api/v1/backups");
      setCoverage(body.coverage ?? []);
      setBackups(body.backups ?? []);
      setLimitations(body.limitations ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Backup inventory is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createPlan = async (applicationId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: BackupPlan }>(`/api/v1/backups/${applicationId}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Backup planning failed");
    } finally {
      setPending(false);
    }
  };

  const stage = async () => {
    if (!plan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/backup-plans/${plan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: plan.revision }),
      });
      setPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Backup staging failed");
    } finally {
      setPending(false);
    }
  };

  const verifiedCount = coverage.filter((entry) => entry.protected).length;
  const plannedSource = coverage.find((entry) => entry.applicationId === plan?.subjectId);

  return (
    <>
      <div className="readiness">
        <div>
          <strong>{loading ? "Inspecting backup coverage" : verifiedCount ? "Restore-verified coverage recorded" : "No backup source is restore-verified yet"}</strong>
          <span>Integrity alone is insufficient. BoxPilot requires the adapter-specific isolated recovery drill.</span>
        </div>
        <span className={`status-pill ${verifiedCount ? "status-good" : "status-warning"}`}>{verifiedCount} of {coverage.length || 1} verified</span>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {limitations.map((limitation) => <div className="notice warning-notice" key={limitation}><strong>Destination limitation</strong><span>{limitation}</span></div>)}

      <div className="backup-source-grid">
        {coverage.map((item) => (
          <section className="panel backup-source-card" key={item.applicationId}>
            <div>
              <span className="eyebrow">{item.sourceKind === "controller-state" ? "Controller state source" : "Application-aware source"}</span>
              <h3>{item.name}</h3>
              <p>{item.source.detail}</p>
              <small>{item.requirement}</small>
            </div>
            <div className="backup-source-actions">
              <span className={`status-pill ${item.state === "verified" ? "status-good" : "status-warning"}`}>{item.state}</span>
              <button className="primary-button" type="button" onClick={() => void createPlan(item.applicationId)} disabled={pending || loading}>{pending ? "Inspecting..." : `Plan verified backup for ${item.name}`}</button>
            </div>
          </section>
        ))}
      </div>

      {plan && (
        <section className="panel backup-plan-card" aria-label="Backup plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable plan {plan.revision}</span><h3>{plannedSource?.name ?? plan.subjectId}: {plan.output.executable ? "ready for approval" : "backup is blocked"}</h3></div><span className={`status-pill ${plan.output.executable ? "status-good" : "status-warning"}`}>{plan.output.destination}</span></div>
          <div className="backup-plan-columns">
            <div><strong>Exact workflow</strong><ol>{plan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
            <div><strong>Warnings and recovery</strong><ul>{plan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{plan.output.recovery}</p></div>
          </div>
          {plan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker.id}><strong>{blocker.id}</strong><span>{blocker.summary}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!plan.output.executable || pending} onClick={() => void stage()}>Stage for approval</button></footer>
        </section>
      )}

      <section className="panel table-panel">
        <div className="section-heading"><div><span className="eyebrow">Durable evidence</span><h3>Verified backup artifacts</h3></div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
        {backups.length ? (
          <div className="table-scroll"><table><thead><tr><th>Source</th><th>Created</th><th>Artifact</th><th>SHA-256</th><th>Downtime</th><th>Restore drill</th></tr></thead><tbody>{backups.map((backup) => <tr key={backup.id}><td>{coverage.find((entry) => entry.applicationId === backup.applicationId)?.name ?? backup.applicationId}</td><td>{new Date(backup.createdAt).toLocaleString()}</td><td>{formatBytes(backup.sizeBytes)} local<details><summary>Verification details</summary><small>Server path</small><code className="backup-evidence-value">{backup.artifactPath}</code><small>Artifact SHA-256</small><code className="backup-evidence-value">{backup.checksumSha256}</code>{backup.restoreDrill.manifestChecksumSha256 && <><small>Manifest SHA-256</small><code className="backup-evidence-value">{backup.restoreDrill.manifestChecksumSha256}</code></>}</details></td><td><code>{backup.checksumSha256.slice(0, 12)}...</code></td><td>{backup.downtimeMs} ms</td><td className={backup.restoreDrill.passed ? "good-text" : "warning-text"}>{backup.restoreDrill.passed ? (backup.applicationId === "boxpilot-controller" ? "Passed, isolated copy-open" : "Passed, network isolated") : "Failed"}</td></tr>)}</tbody></table></div>
        ) : <p className="empty-state">No backup is listed as successful until its artifact checksum and adapter-specific isolated recovery drill both pass.</p>}
      </section>
    </>
  );
}

export const backupUiInternals = { formatBytes };

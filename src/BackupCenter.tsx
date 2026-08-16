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

type ControllerProtectionRecord = {
  id: string;
  backupId: string;
  destination: "mounted-restic-controller";
  repositoryId: string;
  snapshotId: string;
  sizeBytes: number;
  encrypted: boolean;
  independent: boolean;
  repositoryVerified: boolean;
  protected: boolean;
  retained: boolean;
  retention: { runId: string; forgottenAt: string } | null;
  restoreDrill: { passed: boolean; mode: string; network: string; workspaceRemoved: boolean };
  createdAt: string;
};

type ControllerRetentionStatus = {
  executable: boolean;
  repositoryId: string | null;
  beforeCount: number;
  policy: { minimumCopies: number; minimumAgeDays: number; requiresProtectedRestoreDrill: boolean; preserveActiveControllerOperations: boolean };
  candidates: Array<{ protectionId: string; backupId: string; snapshotId: string; createdAt: string; ageDays: number; sizeBytes: number }>;
  kept: Array<{ protectionId: string; backupId: string; snapshotId: string; createdAt: string; ageDays: number; sizeBytes: number; reasons: string[] }>;
  retentionRuns: Array<{ id: string; forgotten: unknown[]; repositoryVerified: boolean; complete: boolean; prunePerformed: boolean; createdAt: string }>;
  blockers: string[];
  changes: string[];
  warnings: string[];
  verification: string[];
  recovery: string;
  prunePerformed: false;
  spaceReclaimed: false;
};

type ControllerRetentionPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: ControllerRetentionStatus;
};

type ControllerDestination = {
  ready: boolean;
  encrypted: boolean;
  independent: boolean;
  resticVersion: string | null;
  mount: { target: string; sourceType: string } | null;
  destinationFreeBytes: number | null;
  blockers: string[];
  setupCommand: string;
};

type Coverage = {
  applicationId: string;
  name: string;
  sourceKind: "controller-state" | "application-state";
  source: { installed: boolean; healthy?: boolean; state: string; detail: string };
  state: "not-installed" | "unprotected" | "locally-verified" | "protected";
  protected: boolean;
  latestBackup: BackupRecord | null;
  latestProtection: ControllerProtectionRecord | null;
  requirement: string;
};

type ControllerProtectionPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: {
    executable: boolean;
    destination: string;
    destinationFreeBytes: number | null;
    blockers: string[];
    changes: string[];
    verification: string[];
    warnings: string[];
    recovery: string;
  };
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
  const [controllerDestination, setControllerDestination] = useState<ControllerDestination | null>(null);
  const [controllerProtections, setControllerProtections] = useState<ControllerProtectionRecord[]>([]);
  const [protectionPlan, setProtectionPlan] = useState<ControllerProtectionPlan | null>(null);
  const [controllerRetention, setControllerRetention] = useState<ControllerRetentionStatus | null>(null);
  const [retentionPlan, setRetentionPlan] = useState<ControllerRetentionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [body, protection, retention] = await Promise.all([
        requestJson<{ coverage: Coverage[]; backups: BackupRecord[]; limitations: string[] }>("/api/v1/backups"),
        requestJson<{ destination: ControllerDestination; protections: ControllerProtectionRecord[] }>("/api/v1/controller-backup-protection"),
        requestJson<ControllerRetentionStatus>("/api/v1/controller-backup-retention"),
      ]);
      setCoverage(body.coverage ?? []);
      setBackups(body.backups ?? []);
      setLimitations(body.limitations ?? []);
      setControllerDestination(protection.destination);
      setControllerProtections(protection.protections ?? []);
      setControllerRetention(retention);
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

  const createProtectionPlan = async (backupId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: ControllerProtectionPlan }>(`/api/v1/controller-backups/${backupId}/protection-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setProtectionPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Controller protection planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageProtection = async () => {
    if (!protectionPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/controller-protection-plans/${protectionPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: protectionPlan.revision }),
      });
      setProtectionPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Controller protection staging failed");
    } finally {
      setPending(false);
    }
  };

  const createRetentionPlan = async () => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: ControllerRetentionPlan }>("/api/v1/controller-retention-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setRetentionPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Controller retention planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageRetention = async () => {
    if (!retentionPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/controller-retention-plans/${retentionPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: retentionPlan.revision }),
      });
      setRetentionPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Controller retention staging failed");
    } finally {
      setPending(false);
    }
  };

  const verifiedCount = coverage.filter((entry) => entry.latestBackup?.restoreDrill?.passed).length;
  const protectedCount = coverage.filter((entry) => entry.protected).length;
  const plannedSource = coverage.find((entry) => entry.applicationId === plan?.subjectId);

  return (
    <>
      <div className="readiness">
        <div>
          <strong>{loading ? "Inspecting backup coverage" : protectedCount ? "Independent controller protection is proven" : verifiedCount ? "Local restore evidence exists, but disaster protection is incomplete" : "No backup source is restore-verified yet"}</strong>
          <span>BoxPilot separates local restore verification from encrypted independent protection.</span>
        </div>
        <span className={`status-pill ${protectedCount ? "status-good" : "status-warning"}`}>{protectedCount} protected | {verifiedCount} local</span>
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
              <span className={`status-pill ${item.state === "protected" ? "status-good" : "status-warning"}`}>{item.state}</span>
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

      <section className="panel backup-plan-card" aria-label="Controller disaster protection">
        <div className="section-heading"><div><span className="eyebrow">Independent controller destination</span><h3>{controllerDestination?.ready ? "Encrypted restic destination ready" : "Setup required on Bigbox"}</h3></div><span className={`status-pill ${controllerDestination?.ready ? "status-good" : "status-warning"}`}>{controllerDestination?.ready ? "ready" : "blocked"}</span></div>
        <p>A separate <code>restic-controller</code> repository and recovery password protect verified BoxPilot state from loss of the server disk.</p>
        {controllerDestination?.ready ? <p className="good-text">Mounted at {controllerDestination.mount?.target} on {controllerDestination.mount?.sourceType ?? "independent storage"}. Full repository reads and exact isolated restore drills are required.</p> : <div className="vm-plan-warnings"><strong>Fail-closed setup</strong>{controllerDestination?.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<span>Run from the Bigbox terminal after mounting independent storage: <code>{controllerDestination?.setupCommand ?? "sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh"}</code></span><span>Keep the controller repository password outside Bigbox.</span></div>}
      </section>

      <section className="panel backup-plan-card" aria-label="Controller retention">
        <div className="section-heading"><div><span className="eyebrow">Independent controller lifecycle</span><h3>Fixed evidence-gated retention</h3></div><span className={`status-pill ${controllerRetention?.executable ? "status-good" : "status-warning"}`}>{controllerRetention?.executable ? `${controllerRetention.candidates.length} eligible` : "no eligible batch"}</span></div>
        <p>BoxPilot keeps at least {controllerRetention?.policy?.minimumCopies ?? 3} retained protected snapshots, keeps every snapshot younger than {controllerRetention?.policy?.minimumAgeDays ?? 30} days, and never runs restic prune.</p>
        <div className="backup-plan-columns"><div><strong>Current evidence</strong><ul><li>{controllerRetention?.beforeCount ?? 0} active controller snapshot(s) in the fixed repository</li><li>{controllerRetention?.candidates?.length ?? 0} exact candidate(s)</li><li>{controllerRetention?.retentionRuns?.length ?? 0} recorded retention run(s)</li></ul></div><div><strong>Permanent boundaries</strong><ul><li>Live database and local verified artifacts remain unchanged</li><li>No path, repository, selector, policy, password, schedule, prune, or space-reclamation input</li><li>No controller production-restore claim exists in this release</li></ul></div></div>
        {controllerRetention?.blockers?.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Retention blocker</strong><span>{blocker}</span></div>)}
        <footer className="modal-actions"><button className="primary-button" type="button" disabled={pending || loading} onClick={() => void createRetentionPlan()}>Build fixed retention plan</button></footer>
      </section>

      {protectionPlan && (
        <section className="panel backup-plan-card" aria-label="Controller protection plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable protection plan {protectionPlan.revision}</span><h3>{protectionPlan.output.executable ? "Ready for owner approval" : "Independent protection is blocked"}</h3></div><span className={`status-pill ${protectionPlan.output.executable ? "status-good" : "status-warning"}`}>{protectionPlan.output.destination}</span></div>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{protectionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{protectionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{protectionPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{protectionPlan.output.recovery}</p></div></div>
          {protectionPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Protection blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setProtectionPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!protectionPlan.output.executable || pending} onClick={() => void stageProtection()}>Stage independent protection</button></footer>
        </section>
      )}

      {retentionPlan && (
        <section className="panel backup-plan-card" aria-label="Controller retention plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable retention plan {retentionPlan.revision}</span><h3>{retentionPlan.output.executable ? `${retentionPlan.output.candidates.length} exact snapshot(s) ready for approval` : "Controller retention is blocked"}</h3></div><span className={`status-pill ${retentionPlan.output.executable ? "status-good" : "status-warning"}`}>high risk</span></div>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{retentionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{retentionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{retentionPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{retentionPlan.output.recovery}</p></div></div>
          {retentionPlan.output.candidates.map((candidate) => <div className="notice" key={candidate.protectionId}><strong>{candidate.ageDays} days old</strong><span>Snapshot <code>{candidate.snapshotId}</code> from controller backup <code>{candidate.backupId}</code></span></div>)}
          {retentionPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Retention blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setRetentionPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!retentionPlan.output.executable || pending} onClick={() => void stageRetention()}>Stage exact retention batch</button></footer>
        </section>
      )}

      <section className="panel table-panel">
        <div className="section-heading"><div><span className="eyebrow">Durable evidence</span><h3>Verified backup artifacts</h3></div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
        {backups.length ? (
          <div className="table-scroll"><table><thead><tr><th>Source</th><th>Created</th><th>Artifact</th><th>SHA-256</th><th>Restore drill</th><th>Independent protection</th></tr></thead><tbody>{backups.map((backup) => { const protection = controllerProtections.find((item) => item.backupId === backup.id); return <tr key={backup.id}><td>{coverage.find((entry) => entry.applicationId === backup.applicationId)?.name ?? backup.applicationId}</td><td>{new Date(backup.createdAt).toLocaleString()}</td><td>{formatBytes(backup.sizeBytes)} local<details><summary>Verification details</summary><small>Server path</small><code className="backup-evidence-value">{backup.artifactPath}</code><small>Artifact SHA-256</small><code className="backup-evidence-value">{backup.checksumSha256}</code>{backup.restoreDrill.manifestChecksumSha256 && <><small>Manifest SHA-256</small><code className="backup-evidence-value">{backup.restoreDrill.manifestChecksumSha256}</code></>}</details></td><td><code>{backup.checksumSha256.slice(0, 12)}...</code></td><td className={backup.restoreDrill.passed ? "good-text" : "warning-text"}>{backup.restoreDrill.passed ? (backup.applicationId === "boxpilot-controller" ? "Passed, isolated copy-open" : "Passed, network isolated") : "Failed"}</td><td>{backup.applicationId !== "boxpilot-controller" ? <span className="warning-text">Adapter pending</span> : protection?.protected ? <details><summary className="good-text">Protected and restored</summary><small>Repository</small><code className="backup-evidence-value">{protection.repositoryId}</code><small>Snapshot</small><code className="backup-evidence-value">{protection.snapshotId}</code></details> : protection?.retained === false ? <details><summary className="warning-text">Snapshot forgotten</summary><small>The local restore-verified artifact remains. This old restic snapshot no longer counts as protected.</small><code className="backup-evidence-value">{protection.snapshotId}</code></details> : <button className="text-button" type="button" disabled={pending} onClick={() => void createProtectionPlan(backup.id)}>Plan encrypted copy</button>}</td></tr>; })}</tbody></table></div>
        ) : <p className="empty-state">No backup is listed as successful until its artifact checksum and adapter-specific isolated recovery drill both pass.</p>}
      </section>
    </>
  );
}

export const backupUiInternals = { formatBytes };

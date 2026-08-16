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

type ApplicationProtectionRecord = {
  id: string;
  backupId: string;
  applicationId: "uptime-kuma" | "pi-hole" | "keel";
  destination: "mounted-restic-applications";
  repositoryId: string;
  snapshotId: string;
  sizeBytes: number;
  encrypted: boolean;
  independent: boolean;
  repositoryVerified: boolean;
  protected: boolean;
  retained: boolean;
  retention: { runId: string; forgottenAt: string } | null;
  restoreDrill: { passed: boolean; mode: string; network: string; workspaceRemoved: boolean; artifactChecksumMatched: boolean };
  createdAt: string;
};

type ApplicationRetentionStatus = {
  executable: boolean;
  repositoryId: string | null;
  beforeCount: number;
  policy: { minimumCopiesPerApplication: number; minimumAgeDays: number; requiresProtectedRestoreDrill: boolean; preserveRecoveryReferences: boolean; preserveActiveApplicationOperations: boolean };
  candidates: Array<{ protectionId: string; backupId: string; applicationId: string; snapshotId: string; createdAt: string; ageDays: number; sizeBytes: number }>;
  kept: Array<{ protectionId: string; backupId: string; applicationId: string; snapshotId: string; createdAt: string; ageDays: number; sizeBytes: number; reasons: string[] }>;
  retentionRuns: Array<{ id: string; forgotten: unknown[]; repositoryVerified: boolean; complete: boolean; prunePerformed: boolean; createdAt: string }>;
  blockers: string[];
  changes: string[];
  warnings: string[];
  verification: string[];
  recovery: string;
  prunePerformed: false;
  spaceReclaimed: false;
};

type ApplicationRetentionPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: ApplicationRetentionStatus;
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

type ApplicationDestination = ControllerDestination;

type Coverage = {
  applicationId: string;
  name: string;
  sourceKind: "controller-state" | "application-state";
  source: { installed: boolean; healthy?: boolean; state: string; detail: string };
  state: "not-installed" | "unprotected" | "locally-verified" | "protected";
  protected: boolean;
  latestBackup: BackupRecord | null;
  latestProtection: ControllerProtectionRecord | ApplicationProtectionRecord | null;
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

type KeelRecoveryRecord = {
  id: string;
  backupId: string;
  applicationId: "keel";
  destination: "managed-keel-recovery";
  statePath: string;
  evidencePath: string;
  sizeBytes: number;
  state: "stopped";
  network: "none";
  createdAt: string;
};

type KeelRecoveryPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: {
    executable: boolean;
    destination: "managed-keel-recovery";
    initialState: "stopped";
    network: "none";
    blockers: string[];
    changes: string[];
    verification: string[];
    warnings: string[];
    recovery: string;
  };
};

type KeelRecoveryDrillRecord = {
  id: string;
  recoveryId: string;
  applicationId: "keel";
  releaseVersion: "1.2.6";
  network: "private-loopback-only";
  healthIdentityVerified: boolean;
  databaseIntegrity: "ok";
  foreignKeyIssues: 0;
  schemaVerified: boolean;
  processStarted: boolean;
  processStopped: boolean;
  workspaceRemoved: boolean;
  sourceRecoveryUnchanged: boolean;
  passed: boolean;
  createdAt: string;
};

type KeelRecoveryDrillPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: {
    executable: boolean;
    mode: "isolated-keel-startup-health";
    releaseVersion: "1.2.6";
    network: "private-loopback-only";
    port: 3100;
    blockers: string[];
    changes: string[];
    verification: string[];
    warnings: string[];
    recovery: string;
  };
};

type KeelPromotionRecord = {
  id: string;
  recoveryId: string;
  drillId: string;
  applicationId: "keel";
  releaseVersion: "1.2.6";
  rollbackPath: string;
  healthIdentityVerified: boolean;
  databaseIntegrity: "ok";
  rollbackAvailable: boolean;
  sourceRecoveryUnchanged: boolean;
  ownerLoginTested: false;
  createdAt: string;
};

type KeelPromotionPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: {
    executable: boolean;
    releaseVersion: "1.2.6";
    network: "host-loopback-only";
    rollbackDestination: "managed-keel-promotion-rollback";
    blockers: string[];
    changes: string[];
    verification: string[];
    warnings: string[];
    recovery: string;
  };
};

type KeelRollbackRecord = {
  id: string;
  promotionId: string;
  applicationId: "keel";
  releaseVersion: "1.2.6";
  displacedStatePath: string;
  displacedEvidencePath: string;
  healthIdentityVerified: boolean;
  databaseIntegrity: "ok";
  displacedStateRetained: boolean;
  sourceRollbackCheckpointUnchanged: boolean;
  ownerLoginTested: false;
  createdAt: string;
};

type KeelRollbackPlan = {
  id: string;
  revision: string;
  subjectId: string;
  output: {
    executable: boolean;
    releaseVersion: "1.2.6";
    network: "host-loopback-only";
    displacedDestination: "managed-keel-rollback-checkpoint";
    sourceCheckpointPreserved: boolean;
    blockers: string[];
    changes: string[];
    verification: string[];
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
  const [applicationDestination, setApplicationDestination] = useState<ApplicationDestination | null>(null);
  const [applicationProtections, setApplicationProtections] = useState<ApplicationProtectionRecord[]>([]);
  const [protectionPlan, setProtectionPlan] = useState<ControllerProtectionPlan | null>(null);
  const [applicationProtectionPlan, setApplicationProtectionPlan] = useState<ControllerProtectionPlan | null>(null);
  const [controllerRetention, setControllerRetention] = useState<ControllerRetentionStatus | null>(null);
  const [retentionPlan, setRetentionPlan] = useState<ControllerRetentionPlan | null>(null);
  const [applicationRetention, setApplicationRetention] = useState<ApplicationRetentionStatus | null>(null);
  const [applicationRetentionPlan, setApplicationRetentionPlan] = useState<ApplicationRetentionPlan | null>(null);
  const [keelRecoveries, setKeelRecoveries] = useState<KeelRecoveryRecord[]>([]);
  const [keelRecoveryPlan, setKeelRecoveryPlan] = useState<KeelRecoveryPlan | null>(null);
  const [keelRecoveryDrills, setKeelRecoveryDrills] = useState<KeelRecoveryDrillRecord[]>([]);
  const [keelRecoveryDrillPlan, setKeelRecoveryDrillPlan] = useState<KeelRecoveryDrillPlan | null>(null);
  const [keelPromotions, setKeelPromotions] = useState<KeelPromotionRecord[]>([]);
  const [keelPromotionPlan, setKeelPromotionPlan] = useState<KeelPromotionPlan | null>(null);
  const [keelRollbacks, setKeelRollbacks] = useState<KeelRollbackRecord[]>([]);
  const [keelRollbackPlan, setKeelRollbackPlan] = useState<KeelRollbackPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [body, protection, applicationProtection, retention, appRetention, recovery, recoveryDrills, promotions, rollbacks] = await Promise.all([
        requestJson<{ coverage: Coverage[]; backups: BackupRecord[]; limitations: string[] }>("/api/v1/backups"),
        requestJson<{ destination: ControllerDestination; protections: ControllerProtectionRecord[] }>("/api/v1/controller-backup-protection"),
        requestJson<{ destination: ApplicationDestination; protections: ApplicationProtectionRecord[] }>("/api/v1/application-backup-protection"),
        requestJson<ControllerRetentionStatus>("/api/v1/controller-backup-retention"),
        requestJson<ApplicationRetentionStatus>("/api/v1/application-backup-retention").catch(() => ({
          executable: false, repositoryId: null, beforeCount: 0,
          policy: { minimumCopiesPerApplication: 3, minimumAgeDays: 30, requiresProtectedRestoreDrill: true, preserveRecoveryReferences: true, preserveActiveApplicationOperations: true },
          candidates: [], kept: [], retentionRuns: [], blockers: ["Application retention inventory is unavailable"], changes: [], warnings: [], verification: [], recovery: "Keep protected snapshots unchanged", prunePerformed: false, spaceReclaimed: false,
        } as ApplicationRetentionStatus)),
        requestJson<{ recoveries: KeelRecoveryRecord[] }>("/api/v1/keel-recoveries").catch(() => ({ recoveries: [] })),
        requestJson<{ drills: KeelRecoveryDrillRecord[] }>("/api/v1/keel-recovery-drills").catch(() => ({ drills: [] })),
        requestJson<{ promotions: KeelPromotionRecord[] }>("/api/v1/keel-recovery-promotions").catch(() => ({ promotions: [] })),
        requestJson<{ rollbacks: KeelRollbackRecord[] }>("/api/v1/keel-rollbacks").catch(() => ({ rollbacks: [] })),
      ]);
      setCoverage(body.coverage ?? []);
      setBackups(body.backups ?? []);
      setLimitations(body.limitations ?? []);
      setControllerDestination(protection.destination);
      setControllerProtections(protection.protections ?? []);
      setApplicationDestination(applicationProtection.destination);
      setApplicationProtections(applicationProtection.protections ?? []);
      setControllerRetention(retention);
      setApplicationRetention(appRetention);
      setKeelRecoveries(recovery.recoveries ?? []);
      setKeelRecoveryDrills(recoveryDrills.drills ?? []);
      setKeelPromotions(promotions.promotions ?? []);
      setKeelRollbacks(rollbacks.rollbacks ?? []);
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

  const createApplicationProtectionPlan = async (backupId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: ControllerProtectionPlan }>(`/api/v1/application-backups/${backupId}/protection-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setApplicationProtectionPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Application protection planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageApplicationProtection = async () => {
    if (!applicationProtectionPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/application-protection-plans/${applicationProtectionPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: applicationProtectionPlan.revision }),
      });
      setApplicationProtectionPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Application protection staging failed");
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

  const createApplicationRetentionPlan = async () => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: ApplicationRetentionPlan }>("/api/v1/application-retention-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setApplicationRetentionPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Application retention planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageApplicationRetention = async () => {
    if (!applicationRetentionPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/application-retention-plans/${applicationRetentionPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: applicationRetentionPlan.revision }),
      });
      setApplicationRetentionPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Application retention staging failed");
    } finally {
      setPending(false);
    }
  };

  const createKeelRecoveryPlan = async (backupId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: KeelRecoveryPlan }>(`/api/v1/application-backups/${backupId}/keel-recovery-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setKeelRecoveryPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel recovery planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageKeelRecovery = async () => {
    if (!keelRecoveryPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/keel-recovery-plans/${keelRecoveryPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: keelRecoveryPlan.revision }),
      });
      setKeelRecoveryPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel recovery staging failed");
    } finally {
      setPending(false);
    }
  };

  const createKeelRecoveryDrillPlan = async (recoveryId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: KeelRecoveryDrillPlan }>(`/api/v1/keel-recoveries/${recoveryId}/drill-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setKeelRecoveryDrillPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel recovery drill planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageKeelRecoveryDrill = async () => {
    if (!keelRecoveryDrillPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/keel-recovery-drill-plans/${keelRecoveryDrillPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: keelRecoveryDrillPlan.revision }),
      });
      setKeelRecoveryDrillPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel recovery drill staging failed");
    } finally {
      setPending(false);
    }
  };

  const createKeelPromotionPlan = async (recoveryId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: KeelPromotionPlan }>(`/api/v1/keel-recoveries/${recoveryId}/promotion-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setKeelPromotionPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel production promotion planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageKeelPromotion = async () => {
    if (!keelPromotionPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/keel-promotion-plans/${keelPromotionPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: keelPromotionPlan.revision }),
      });
      setKeelPromotionPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel production promotion staging failed");
    } finally {
      setPending(false);
    }
  };

  const createKeelRollbackPlan = async (promotionId: string) => {
    setPending(true);
    try {
      const body = await requestJson<{ plan: KeelRollbackPlan }>(`/api/v1/keel-promotions/${promotionId}/rollback-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      });
      setKeelRollbackPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel operator rollback planning failed");
    } finally {
      setPending(false);
    }
  };

  const stageKeelRollback = async () => {
    if (!keelRollbackPlan) return;
    setPending(true);
    try {
      await requestJson(`/api/v1/keel-rollback-plans/${keelRollbackPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: keelRollbackPlan.revision }),
      });
      setKeelRollbackPlan(null);
      onOpenRepair();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Keel operator rollback staging failed");
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
          <strong>{loading ? "Inspecting backup coverage" : protectedCount ? "Independent backup protection is proven" : verifiedCount ? "Local restore evidence exists, but disaster protection is incomplete" : "No backup source is restore-verified yet"}</strong>
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

      <section className="panel backup-plan-card" aria-label="Application disaster protection">
        <div className="section-heading"><div><span className="eyebrow">Independent application destination</span><h3>{applicationDestination?.ready ? "Encrypted restic destination ready" : "Setup required on Bigbox"}</h3></div><span className={`status-pill ${applicationDestination?.ready ? "status-good" : "status-warning"}`}>{applicationDestination?.ready ? "ready" : "blocked"}</span></div>
        <p>A separate <code>restic-applications</code> repository and recovery password protect verified Uptime Kuma and Pi-hole archives from loss of the server disk.</p>
        {applicationDestination?.ready ? <p className="good-text">Mounted at {applicationDestination.mount?.target} on {applicationDestination.mount?.sourceType ?? "independent storage"}. Full repository reads and exact byte-for-byte archive restores are required.</p> : <div className="vm-plan-warnings"><strong>Fail-closed setup</strong>{applicationDestination?.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<span>Run from the Bigbox terminal after mounting independent storage: <code>{applicationDestination?.setupCommand ?? "sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh"}</code></span><span>Keep this recovery password separate from the controller and VM repository passwords.</span></div>}
      </section>

      <section className="panel backup-plan-card" aria-label="Keel recovery clones">
        <div className="section-heading"><div><span className="eyebrow">Application recovery</span><h3>Stopped Keel recovery clones</h3></div><span className={`status-pill ${keelRecoveries.length ? "status-good" : "status-warning"}`}>{keelRecoveries.length} clone(s)</span></div>
        <p>Materialize a verified Keel backup as a new root-only recovery state without replacing production, starting an application, or attaching a network.</p>
        <div className="backup-plan-columns">
          <div><strong>Eligible local backups</strong>{backups.filter((backup) => backup.applicationId === "keel" && backup.restoreDrill.passed).length ? <ul>{backups.filter((backup) => backup.applicationId === "keel" && backup.restoreDrill.passed).map((backup) => <li key={backup.id}><button className="text-button" type="button" disabled={pending} onClick={() => void createKeelRecoveryPlan(backup.id)}>Plan stopped clone from {new Date(backup.createdAt).toLocaleString()}</button></li>)}</ul> : <p>No restore-verified Keel backup is available.</p>}</div>
          <div><strong>Published recovery evidence</strong>{keelRecoveries.length ? <ul>{keelRecoveries.map((recovery) => {
            const latestDrill = keelRecoveryDrills.find((drill) => drill.recoveryId === recovery.id);
            const passingDrill = latestDrill?.passed ? latestDrill : undefined;
            const promotion = keelPromotions.find((entry) => entry.recoveryId === recovery.id);
            const rollback = promotion ? keelRollbacks.find((entry) => entry.promotionId === promotion.id) : undefined;
            return <li key={recovery.id}><details><summary className="good-text">Stopped, no network, {formatBytes(recovery.sizeBytes)}</summary><small>State path</small><code className="backup-evidence-value">{recovery.statePath}</code><small>Source backup</small><code className="backup-evidence-value">{recovery.backupId}</code>{passingDrill ? <><p className="good-text">Startup rehearsal passed {new Date(passingDrill.createdAt).toLocaleString()}: private loopback health, SQLite, clean stop, unchanged source, workspace removed.</p>{promotion ? <><p className="good-text">Promoted {new Date(promotion.createdAt).toLocaleString()}; production health passed and the original checkpoint remains preserved.</p><small>Original rollback checkpoint</small><code className="backup-evidence-value">{promotion.rollbackPath}</code>{rollback ? <><p className="good-text">Operator rollback completed {new Date(rollback.createdAt).toLocaleString()}; the original checkpoint is unchanged and displaced production is retained.</p><small>Displaced production checkpoint</small><code className="backup-evidence-value">{rollback.displacedStatePath}</code></> : <button className="text-button" type="button" disabled={pending} onClick={() => void createKeelRollbackPlan(promotion.id)}>Plan operator rollback</button>}</> : <button className="text-button" type="button" disabled={pending} onClick={() => void createKeelPromotionPlan(recovery.id)}>Plan production promotion</button>}</> : <button className="text-button" type="button" disabled={pending} onClick={() => void createKeelRecoveryDrillPlan(recovery.id)}>Plan isolated startup rehearsal</button>}</details></li>;
          })}</ul> : <p>No stopped clone has been published.</p>}</div>
        </div>
        <div className="notice warning-notice"><strong>Promotion is a critical separate job</strong><span>Only a clone with matching passing startup evidence can replace <code>/var/lib/keel</code>. The fixed job preserves prior production as a root-only local rollback checkpoint and does not test owner login.</span></div>
      </section>

      <section className="panel backup-plan-card" aria-label="Controller retention">
        <div className="section-heading"><div><span className="eyebrow">Independent controller lifecycle</span><h3>Fixed evidence-gated retention</h3></div><span className={`status-pill ${controllerRetention?.executable ? "status-good" : "status-warning"}`}>{controllerRetention?.executable ? `${controllerRetention.candidates.length} eligible` : "no eligible batch"}</span></div>
        <p>BoxPilot keeps at least {controllerRetention?.policy?.minimumCopies ?? 3} retained protected snapshots, keeps every snapshot younger than {controllerRetention?.policy?.minimumAgeDays ?? 30} days, and never runs restic prune.</p>
        <div className="backup-plan-columns"><div><strong>Current evidence</strong><ul><li>{controllerRetention?.beforeCount ?? 0} active controller snapshot(s) in the fixed repository</li><li>{controllerRetention?.candidates?.length ?? 0} exact candidate(s)</li><li>{controllerRetention?.retentionRuns?.length ?? 0} recorded retention run(s)</li></ul></div><div><strong>Permanent boundaries</strong><ul><li>Live database and local verified artifacts remain unchanged</li><li>No path, repository, selector, policy, password, schedule, prune, or space-reclamation input</li><li>No controller production-restore claim exists in this release</li></ul></div></div>
        {controllerRetention?.blockers?.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Retention blocker</strong><span>{blocker}</span></div>)}
        <footer className="modal-actions"><button className="primary-button" type="button" disabled={pending || loading} onClick={() => void createRetentionPlan()}>Build fixed retention plan</button></footer>
      </section>

      <section className="panel backup-plan-card" aria-label="Application retention">
        <div className="section-heading"><div><span className="eyebrow">Independent application lifecycle</span><h3>Per-application evidence-gated retention</h3></div><span className={`status-pill ${applicationRetention?.executable ? "status-good" : "status-warning"}`}>{applicationRetention?.executable ? `${applicationRetention.candidates.length} eligible` : "no eligible batch"}</span></div>
        <p>BoxPilot keeps at least {applicationRetention?.policy?.minimumCopiesPerApplication ?? 3} retained protected snapshots for each application, keeps every snapshot younger than {applicationRetention?.policy?.minimumAgeDays ?? 30} days, preserves recovery references, and never runs restic prune.</p>
        <div className="backup-plan-columns"><div><strong>Current evidence</strong><ul><li>{applicationRetention?.beforeCount ?? 0} active application snapshot(s) in the fixed repository</li><li>{applicationRetention?.candidates?.length ?? 0} exact candidate(s)</li><li>{applicationRetention?.retentionRuns?.length ?? 0} recorded retention run(s)</li></ul></div><div><strong>Permanent boundaries</strong><ul><li>Running applications, local verified archives, and recovery objects remain unchanged</li><li>No path, repository, selector, policy, password, schedule, prune, or space-reclamation input</li><li>Only exact old restore-tested unreferenced snapshots can qualify</li></ul></div></div>
        {applicationRetention?.blockers?.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Retention blocker</strong><span>{blocker}</span></div>)}
        <footer className="modal-actions"><button className="primary-button" type="button" disabled={pending || loading} onClick={() => void createApplicationRetentionPlan()}>Build application retention plan</button></footer>
      </section>

      {protectionPlan && (
        <section className="panel backup-plan-card" aria-label="Controller protection plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable protection plan {protectionPlan.revision}</span><h3>{protectionPlan.output.executable ? "Ready for owner approval" : "Independent protection is blocked"}</h3></div><span className={`status-pill ${protectionPlan.output.executable ? "status-good" : "status-warning"}`}>{protectionPlan.output.destination}</span></div>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{protectionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{protectionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{protectionPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{protectionPlan.output.recovery}</p></div></div>
          {protectionPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Protection blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setProtectionPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!protectionPlan.output.executable || pending} onClick={() => void stageProtection()}>Stage independent protection</button></footer>
        </section>
      )}

      {applicationProtectionPlan && (
        <section className="panel backup-plan-card" aria-label="Application protection plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable application protection plan {applicationProtectionPlan.revision}</span><h3>{applicationProtectionPlan.output.executable ? "Ready for owner approval" : "Independent application protection is blocked"}</h3></div><span className={`status-pill ${applicationProtectionPlan.output.executable ? "status-good" : "status-warning"}`}>{applicationProtectionPlan.output.destination}</span></div>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{applicationProtectionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{applicationProtectionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{applicationProtectionPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{applicationProtectionPlan.output.recovery}</p></div></div>
          {applicationProtectionPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Protection blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setApplicationProtectionPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!applicationProtectionPlan.output.executable || pending} onClick={() => void stageApplicationProtection()}>Stage independent protection</button></footer>
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

      {applicationRetentionPlan && (
        <section className="panel backup-plan-card" aria-label="Application retention plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable application retention plan {applicationRetentionPlan.revision}</span><h3>{applicationRetentionPlan.output.executable ? `${applicationRetentionPlan.output.candidates.length} exact snapshot(s) ready for approval` : "Application retention is blocked"}</h3></div><span className={`status-pill ${applicationRetentionPlan.output.executable ? "status-good" : "status-warning"}`}>high risk</span></div>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{applicationRetentionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{applicationRetentionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{applicationRetentionPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{applicationRetentionPlan.output.recovery}</p></div></div>
          {applicationRetentionPlan.output.candidates.map((candidate) => <div className="notice" key={candidate.protectionId}><strong>{candidate.applicationId} | {candidate.ageDays} days old</strong><span>Snapshot <code>{candidate.snapshotId}</code> from backup <code>{candidate.backupId}</code></span></div>)}
          {applicationRetentionPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Retention blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setApplicationRetentionPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!applicationRetentionPlan.output.executable || pending} onClick={() => void stageApplicationRetention()}>Stage application retention batch</button></footer>
        </section>
      )}

      {keelRecoveryPlan && (
        <section className="panel backup-plan-card" aria-label="Keel recovery plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable recovery plan {keelRecoveryPlan.revision}</span><h3>{keelRecoveryPlan.output.executable ? "Stopped clone ready for approval" : "Keel recovery is blocked"}</h3></div><span className={`status-pill ${keelRecoveryPlan.output.executable ? "status-good" : "status-warning"}`}>high risk</span></div>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{keelRecoveryPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{keelRecoveryPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{keelRecoveryPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{keelRecoveryPlan.output.recovery}</p></div></div>
          {keelRecoveryPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Recovery blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setKeelRecoveryPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!keelRecoveryPlan.output.executable || pending} onClick={() => void stageKeelRecovery()}>Stage stopped recovery clone</button></footer>
        </section>
      )}

      {keelRecoveryDrillPlan && (
        <section className="panel backup-plan-card" aria-label="Keel recovery drill plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable startup rehearsal {keelRecoveryDrillPlan.revision}</span><h3>{keelRecoveryDrillPlan.output.executable ? "Isolated Keel startup rehearsal ready" : "Startup rehearsal is blocked"}</h3></div><span className={`status-pill ${keelRecoveryDrillPlan.output.executable ? "status-good" : "status-warning"}`}>high risk</span></div>
          <p>Keel {keelRecoveryDrillPlan.output.releaseVersion} runs only against a disposable copy on {keelRecoveryDrillPlan.output.network}. Port {keelRecoveryDrillPlan.output.port} exists only inside the private namespace.</p>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{keelRecoveryDrillPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{keelRecoveryDrillPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{keelRecoveryDrillPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{keelRecoveryDrillPlan.output.recovery}</p></div></div>
          {keelRecoveryDrillPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Drill blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setKeelRecoveryDrillPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!keelRecoveryDrillPlan.output.executable || pending} onClick={() => void stageKeelRecoveryDrill()}>Stage isolated startup rehearsal</button></footer>
        </section>
      )}

      {keelPromotionPlan && (
        <section className="panel backup-plan-card" aria-label="Keel production promotion plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable production promotion {keelPromotionPlan.revision}</span><h3>{keelPromotionPlan.output.executable ? "Drilled Keel recovery ready for critical approval" : "Production promotion is blocked"}</h3></div><span className={`status-pill ${keelPromotionPlan.output.executable ? "status-good" : "status-warning"}`}>critical</span></div>
          <p>Keel {keelPromotionPlan.output.releaseVersion} remains on {keelPromotionPlan.output.network}. This job replaces application state and preserves the entire stopped prior state in {keelPromotionPlan.output.rollbackDestination}.</p>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{keelPromotionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{keelPromotionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{keelPromotionPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{keelPromotionPlan.output.recovery}</p></div></div>
          {keelPromotionPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Promotion blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setKeelPromotionPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!keelPromotionPlan.output.executable || pending} onClick={() => void stageKeelPromotion()}>Stage critical production promotion</button></footer>
        </section>
      )}

      {keelRollbackPlan && (
        <section className="panel backup-plan-card" aria-label="Keel operator rollback plan">
          <div className="section-heading"><div><span className="eyebrow">Immutable operator rollback {keelRollbackPlan.revision}</span><h3>{keelRollbackPlan.output.executable ? "Retained Keel checkpoint ready for critical approval" : "Operator rollback is blocked"}</h3></div><span className={`status-pill ${keelRollbackPlan.output.executable ? "status-good" : "status-warning"}`}>critical</span></div>
          <p>Keel {keelRollbackPlan.output.releaseVersion} remains on {keelRollbackPlan.output.network}. This job restores the exact pre-promotion state, keeps the original checkpoint unchanged, and retains current production in {keelRollbackPlan.output.displacedDestination}.</p>
          <div className="backup-plan-columns"><div><strong>Exact workflow</strong><ol>{keelRollbackPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol><strong>Required evidence</strong><ol>{keelRollbackPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div><div><strong>Warnings and recovery</strong><ul>{keelRollbackPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>{keelRollbackPlan.output.recovery}</p></div></div>
          {keelRollbackPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Rollback blocker</strong><span>{blocker}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setKeelRollbackPlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!keelRollbackPlan.output.executable || pending} onClick={() => void stageKeelRollback()}>Stage critical operator rollback</button></footer>
        </section>
      )}

      <section className="panel table-panel">
        <div className="section-heading"><div><span className="eyebrow">Durable evidence</span><h3>Verified backup artifacts</h3></div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
        {backups.length ? (
          <div className="table-scroll"><table><thead><tr><th>Source</th><th>Created</th><th>Artifact</th><th>SHA-256</th><th>Restore drill</th><th>Independent protection</th></tr></thead><tbody>{backups.map((backup) => { const controllerProtection = controllerProtections.find((item) => item.backupId === backup.id); const applicationProtection = applicationProtections.find((item) => item.backupId === backup.id); return <tr key={backup.id}><td>{coverage.find((entry) => entry.applicationId === backup.applicationId)?.name ?? backup.applicationId}</td><td>{new Date(backup.createdAt).toLocaleString()}</td><td>{formatBytes(backup.sizeBytes)} local<details><summary>Verification details</summary><small>Server path</small><code className="backup-evidence-value">{backup.artifactPath}</code><small>Artifact SHA-256</small><code className="backup-evidence-value">{backup.checksumSha256}</code>{backup.restoreDrill.manifestChecksumSha256 && <><small>Manifest SHA-256</small><code className="backup-evidence-value">{backup.restoreDrill.manifestChecksumSha256}</code></>}</details></td><td><code>{backup.checksumSha256.slice(0, 12)}...</code></td><td className={backup.restoreDrill.passed ? "good-text" : "warning-text"}>{backup.restoreDrill.passed ? (backup.applicationId === "boxpilot-controller" ? "Passed, isolated copy-open" : "Passed, network isolated") : "Failed"}</td><td>{backup.applicationId === "boxpilot-controller" ? (controllerProtection?.protected ? <details><summary className="good-text">Protected and restored</summary><small>Repository</small><code className="backup-evidence-value">{controllerProtection.repositoryId}</code><small>Snapshot</small><code className="backup-evidence-value">{controllerProtection.snapshotId}</code></details> : controllerProtection?.retained === false ? <details><summary className="warning-text">Snapshot forgotten</summary><small>The local restore-verified artifact remains. This old restic snapshot no longer counts as protected.</small><code className="backup-evidence-value">{controllerProtection.snapshotId}</code></details> : <button className="text-button" type="button" disabled={pending} onClick={() => void createProtectionPlan(backup.id)}>Plan encrypted copy</button>) : applicationProtection?.protected ? <details><summary className="good-text">Protected and restored</summary><small>Repository</small><code className="backup-evidence-value">{applicationProtection.repositoryId}</code><small>Snapshot</small><code className="backup-evidence-value">{applicationProtection.snapshotId}</code><small>Proof</small><span>Exact archive SHA-256 restored</span></details> : <button className="text-button" type="button" disabled={pending} onClick={() => void createApplicationProtectionPlan(backup.id)}>Plan encrypted copy</button>}</td></tr>; })}</tbody></table></div>
        ) : <p className="empty-state">No backup is listed as successful until its artifact checksum and adapter-specific isolated recovery drill both pass.</p>}
      </section>
    </>
  );
}

export const backupUiInternals = { formatBytes };

import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;
const applicationIds = new Set(["uptime-kuma", "pi-hole", "keel"]);

export function createApplicationProtectionService({ store, helper }) {
  async function destination() {
    try {
      return await helper.request("application.backup.protection.inspect", {});
    } catch {
      return {
        adapter: "mounted-restic-applications",
        ready: false,
        encrypted: false,
        independent: false,
        resticVersion: null,
        mount: null,
        repositoryId: null,
        destinationRevision: null,
        destinationFreeBytes: null,
        blockers: ["The restricted helper could not inspect application disaster protection"],
        setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh",
        recoveryKeyRequired: true,
      };
    }
  }

  async function list() {
    return { destination: await destination(), protections: store.listApplicationBackupProtections() };
  }

  function backup(backupId) {
    return store.listBackups(200).find((candidate) => candidate.id === backupId && applicationIds.has(candidate.applicationId)) ?? null;
  }

  function verifiedBackup(backupId) {
    const candidate = backup(backupId);
    const commonEvidence = candidate?.destination === "local-managed"
      && candidate.restoreDrill?.passed === true
      && candidate.restoreDrill?.network === "none"
      && candidate.restoreDrill?.publishedPorts === 0
      && shaPattern.test(candidate.checksumSha256 ?? "")
      && Number.isSafeInteger(candidate.sizeBytes)
      && candidate.sizeBytes > 0;
    const piholeEvidence = candidate?.applicationId !== "pi-hole" || (
      candidate.restoreDrill?.configurationIncluded === true
      && candidate.restoreDrill?.administratorSecretIncluded === true
      && candidate.restoreDrill?.routerMutationPerformed === false
      && candidate.restoreDrill?.dnsCutoverPerformed === false
    );
    const keelEvidence = candidate?.applicationId !== "keel" || (
      candidate.restoreDrill?.mode === "isolated-keel-export-open"
      && candidate.restoreDrill?.databaseIntegrity === "ok"
      && candidate.restoreDrill?.foreignKeyIssues === 0
      && candidate.restoreDrill?.schemaVerified === true
      && candidate.restoreDrill?.environmentIncluded === true
      && candidate.restoreDrill?.treeDigestMatched === true
      && candidate.restoreDrill?.applicationStarted === false
      && candidate.restoreDrill?.productionStateReplaced === false
    );
    if (!commonEvidence || !piholeEvidence || !keelEvidence) throw new Error("The selected local application backup is unavailable or lacks complete no-network restore verification");
    return candidate;
  }

  async function plan(backupId, ownerId) {
    const source = verifiedBackup(backupId);
    if (store.getApplicationBackupProtectionByBackup(source.id)) throw new Error("This application backup already has durable independent protection evidence");
    const currentDestination = await destination();
    const capacityReady = Number.isSafeInteger(currentDestination.destinationFreeBytes)
      && currentDestination.destinationFreeBytes >= source.sizeBytes + 256 * 1024 ** 2;
    const blockers = [...(currentDestination.blockers ?? [])];
    if (currentDestination.ready && !capacityReady) blockers.push("The independent application destination does not have enough free space");
    const input = {
      protectionId: randomUUID(),
      backupId: source.id,
      applicationId: source.applicationId,
      expectedArtifactChecksumSha256: source.checksumSha256,
      expectedSizeBytes: source.sizeBytes,
      expectedDestinationRevision: currentDestination.destinationRevision,
    };
    const output = {
      executable: currentDestination.ready === true && capacityReady,
      destination: "mounted-restic-applications",
      applicationId: source.applicationId,
      resticVersion: currentDestination.resticVersion,
      repositoryId: currentDestination.repositoryId,
      destinationFreeBytes: currentDestination.destinationFreeBytes,
      blockers,
      changes: [
        "Reverify the exact immutable local application archive, size, and SHA-256 approved by this plan",
        "Write only that archive into the separate encrypted application restic repository on an independent mounted filesystem",
        "Tag the snapshot only with server-generated application, backup, and protection identifiers",
        "Read every restic data pack and confirm the exact snapshot path and tags",
        "Restore that exact snapshot into a generated helper-owned no-network workspace",
        "Rehash the restored archive, require a byte-for-byte match, then remove the successful drill workspace",
        "Combine the prior application-aware no-network boot drill with independent exact-artifact restore evidence",
      ],
      verification: ["Approved local archive SHA-256 and size", "Prior application-aware no-network restore drill", "Full restic repository data read", "Exact snapshot path and tag readback", "Exact restored archive SHA-256 and size"],
      warnings: [
        "The application repository password is a separate recovery key. Keep a copy outside this server and outside the backup filesystem.",
        source.applicationId === "pi-hole"
          ? "The encrypted archive contains the Pi-hole administrator secret. Router and client DNS are never changed by this workflow."
          : source.applicationId === "keel"
            ? "The encrypted archive contains Keel notes, users, sessions, configuration, uploads, and the managed-secret companion when present. Treat it as highly sensitive."
            : "The encrypted archive contains Uptime Kuma state and credentials.",
        "A local USB disk is independent from this server's storage but is not offsite protection. A NAS or rotated encrypted disk is stronger.",
        "BoxPilot does not forget, prune, overwrite, or delete application restic snapshots in this workflow.",
      ],
      recovery: "The running application and verified local archive remain unchanged. If repository or restore verification fails, preserve the encrypted repository and generated root-only drill workspace for inspection. BoxPilot does not run retention or prune.",
      encrypted: currentDestination.encrypted === true,
      independent: currentDestination.independent === true,
      protected: false,
    };
    return store.createPlan({ type: "application.backup.protection", subjectId: source.id, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const source = verifiedBackup(draft.input.backupId);
    if (source.applicationId !== draft.input.applicationId || source.checksumSha256 !== draft.input.expectedArtifactChecksumSha256
      || source.sizeBytes !== draft.input.expectedSizeBytes) throw new Error("The selected application backup evidence changed after planning");
    if (store.getApplicationBackupProtectionByBackup(source.id)) throw new Error("This application backup already has durable independent protection evidence");
    const currentDestination = await destination();
    if (!currentDestination.ready || currentDestination.destinationRevision !== draft.input.expectedDestinationRevision
      || currentDestination.destinationFreeBytes < source.sizeBytes + 256 * 1024 ** 2) {
      throw new Error("The encrypted independent application destination is unavailable or changed");
    }
    return { source, currentDestination };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.backup.protection") throw new Error("Application protection plan not found");
    if (draft.revision !== revision) throw new Error("Application protection plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Application protection plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    const label = draft.input.applicationId === "pi-hole" ? "Pi-hole" : draft.input.applicationId === "keel" ? "Keel Notes" : "Uptime Kuma";
    return store.createJob({
      type: "application.backup.protect",
      title: `Encrypt, independently copy, and restore-test ${label}`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact local archive evidence, prior no-network drill, independent mount, repository identity, separate recovery key, and capacity validated" },
        { name: "checkpoint", state: "completed", detail: "Running application and local archive remain immutable; repository forget, prune, and overwrite are unavailable" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.backup.protect") throw new Error("Unsupported application protection job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged application protection plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The application protection job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.created !== true || result?.protectionId !== input.protectionId || result?.backupId !== input.backupId
      || result?.applicationId !== input.applicationId || result?.destination !== "mounted-restic-applications"
      || !shaPattern.test(result?.repositoryId ?? "") || !shaPattern.test(result?.snapshotId ?? "")
      || result?.sizeBytes !== input.expectedSizeBytes || result?.artifactChecksumSha256 !== input.expectedArtifactChecksumSha256
      || result?.encrypted !== true || result?.independent !== true || result?.repositoryVerified !== true || result?.protected !== true
      || result?.restoreDrill?.passed !== true || result.restoreDrill.mode !== "exact-snapshot-artifact-restore"
      || result.restoreDrill.network !== "none" || result.restoreDrill.publishedPorts !== 0
      || result.restoreDrill.artifactChecksumMatched !== true || result.restoreDrill.artifactSizeMatched !== true
      || result.restoreDrill.priorApplicationRestoreEvidencePreserved !== true || result.restoreDrill.workspaceRemoved !== true
      || result.restoreDrill.applicationStarted !== false || result.restoreDrill.productionStateReplaced !== false
      || result.boundary?.browserPathAccepted !== false || result.boundary?.browserPasswordAccepted !== false
      || result.boundary?.repositorySelectorAccepted !== false || result.boundary?.productionApplicationChanged !== false
      || result.boundary?.localBackupChanged !== false || result.boundary?.networkAccessRequired !== false
      || result.boundary?.retentionPerformed !== false || result.boundary?.prunePerformed !== false
      || (input.applicationId === "pi-hole" && (result.boundary?.routerMutationPerformed !== false || result.boundary?.dnsCutoverPerformed !== false))) {
      throw new Error("Application protection evidence validation failed");
    }
    return store.recordApplicationBackupProtection({
      id: result.protectionId,
      backupId: result.backupId,
      applicationId: result.applicationId,
      destination: result.destination,
      repositoryId: result.repositoryId,
      snapshotId: result.snapshotId,
      sizeBytes: result.sizeBytes,
      encrypted: true,
      independent: true,
      repositoryVerified: true,
      protected: true,
      restoreDrill: result.restoreDrill,
      createdBy: job.createdBy,
    });
  }

  return { list, plan, stage, validateJob, recordResult };
}

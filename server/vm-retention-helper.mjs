import { createVmProtectionHelper } from "./vm-protection-helper.mjs";
import { parseSnapshotInventory, resticRepositoryUnder, resticRunner, shaPattern, snapshotSetRevision, validateRetentionInput } from "./restic-retention.mjs";
import { backupMountpoint } from "./backup-mount.mjs";

export const validateVmRetentionInput = (input) => validateRetentionInput(input, { subject: "VM" });

export function createVmRetentionHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  mountRoot = process.env.BOXPILOT_VM_BACKUP_MOUNT ?? backupMountpoint,
  passwordFile = process.env.BOXPILOT_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/vm-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-restic",
  inspectDestination = createVmProtectionHelper().inspect,
  run = resticRunner,
} = {}) {
  const { repository } = resticRepositoryUnder(mountRoot, { directory: "restic-vm", subject: "VM" });

  function commonResticArguments() {
    return ["--repo", repository, "--password-file", passwordFile, "--cache-dir", cacheRoot];
  }

  async function inspect() {
    const destination = await inspectDestination();
    if (!destination.ready || !shaPattern.test(destination.repositoryId ?? "") || !shaPattern.test(destination.destinationRevision ?? "")) {
      return {
        ready: false,
        repositoryId: destination.repositoryId ?? null,
        destinationRevision: destination.destinationRevision ?? null,
        snapshotSetRevision: null,
        snapshots: [],
        blockers: destination.blockers ?? ["The encrypted VM backup destination is unavailable"],
      };
    }
    const result = await run(resticBinary, [...commonResticArguments(), "snapshots", "--json", "--tag", "boxpilot-vm"], { timeout: 30000 });
    const snapshots = parseSnapshotInventory(result.stdout, { label: "VM" });
    return {
      ready: true,
      repositoryId: destination.repositoryId,
      destinationRevision: destination.destinationRevision,
      snapshotSetRevision: snapshotSetRevision(snapshots),
      snapshots,
      blockers: [],
    };
  }

  async function apply(parameters) {
    const errors = validateVmRetentionInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const before = await inspect();
    if (!before.ready || before.repositoryId !== parameters.repositoryId
      || before.destinationRevision !== parameters.expectedDestinationRevision
      || before.snapshotSetRevision !== parameters.expectedSnapshotSetRevision) {
      throw new Error("The encrypted repository or its snapshot inventory changed after approval");
    }
    const beforeIds = new Set(before.snapshots.map((snapshot) => snapshot.id));
    if (parameters.forgetSnapshotIds.some((id) => !beforeIds.has(id))) throw new Error("A reviewed snapshot is no longer present in the repository");

    const forgotten = new Set(parameters.forgetSnapshotIds);
    const expectedKept = before.snapshots.map((snapshot) => snapshot.id).filter((id) => !forgotten.has(id)).sort();
    const verification = [];
    let forgetSucceeded = false;
    let repositoryCheckPassed = false;
    let after = null;
    try {
      await run(resticBinary, [...commonResticArguments(), "forget", ...parameters.forgetSnapshotIds], { timeout: 60 * 60 * 1000 });
      forgetSucceeded = true;
    } catch {
      verification.push("forget-command-failed");
    }
    try {
      await run(resticBinary, [...commonResticArguments(), "check", "--read-data", "--quiet"], { timeout: 12 * 60 * 60 * 1000 });
      repositoryCheckPassed = true;
    } catch {
      verification.push("repository-check-failed");
    }
    try {
      after = await inspect();
    } catch {
      verification.push("post-inspection-failed");
    }
    // An unavailable repository inspects as ready: false with no snapshots instead of throwing,
    // which would otherwise read as every candidate gone. Only the same repository counts.
    const afterIdentityValid = after?.ready === true
      && after.repositoryId === before.repositoryId
      && after.destinationRevision === before.destinationRevision;
    if (after && !afterIdentityValid) verification.push("post-inspection-identity-unverified");
    const verifiedAfter = afterIdentityValid ? after : null;
    const afterIds = new Set(verifiedAfter?.snapshots?.map((snapshot) => snapshot.id) ?? []);
    // Only what a fresh inspection shows gone counts as forgotten. Believing the forget command's
    // own exit code here recorded backups as gone that might still be there, and the next preview
    // then reported them as unattributable — a blocker with no way out.
    const actuallyForgotten = verifiedAfter ? parameters.forgetSnapshotIds.filter((id) => !afterIds.has(id)) : [];
    if (actuallyForgotten.length === 0) throw new Error("Restic retention failed before any reviewed snapshot removal was confirmed");
    const allCandidatesAbsent = actuallyForgotten.length === parameters.forgetSnapshotIds.length;
    const allKeptPresent = verifiedAfter ? expectedKept.every((id) => afterIds.has(id)) : false;
    if (!allCandidatesAbsent) verification.push("candidate-still-present");
    if (!allKeptPresent) verification.push("noncandidate-presence-unverified");
    if (after && after.repositoryId !== before.repositoryId) verification.push("repository-identity-changed");
    const complete = forgetSucceeded && allCandidatesAbsent;
    const repositoryVerified = complete && repositoryCheckPassed && allKeptPresent && after?.repositoryId === before.repositoryId;
    return {
      applied: true,
      complete,
      retentionId: parameters.retentionId,
      repositoryId: parameters.repositoryId,
      forgottenSnapshotIds: actuallyForgotten,
      keptSnapshotIds: expectedKept,
      beforeCount: before.snapshots.length,
      afterCount: verifiedAfter?.snapshots?.length ?? null,
      beforeSnapshotSetRevision: before.snapshotSetRevision,
      afterSnapshotSetRevision: verifiedAfter?.snapshotSetRevision ?? null,
      repositoryVerified,
      prunePerformed: false,
      spaceReclaimed: false,
      verification,
    };
  }

  /**
   * Forget one snapshot the repository holds and BoxPilot has no record of. That state comes from
   * a backup that was written and then failed its verification, and it blocks retention until it
   * is cleared. `knownSnapshotIds` are the ones with local records: refusing to touch those is
   * what keeps this from becoming a general delete.
   * @param {{ snapshotId?: string, knownSnapshotIds?: string[] }} [request]
   */
  async function forgetUnrecorded({ snapshotId, knownSnapshotIds = [] } = {}) {
    if (typeof snapshotId !== "string" || !shaPattern.test(snapshotId)) throw new Error("Snapshot id must be an exact SHA-256 id");
    if (knownSnapshotIds.includes(snapshotId)) throw new Error("That snapshot has a local backup record; use retention, which checks the copy and age policy");
    const before = await inspect();
    if (!before.ready) throw new Error(`The encrypted repository is not available: ${(before.blockers ?? []).join("; ") || "not ready"}`);
    if (!before.snapshots.some((snapshot) => snapshot.id === snapshotId)) throw new Error("That snapshot is not in the repository");
    await run(resticBinary, [...commonResticArguments(), "forget", snapshotId], { timeout: 60 * 60 * 1000 });
    const after = await inspect();
    // An unavailable repository lists no snapshots, which is not the same as this one being gone.
    if (!after.ready || after.repositoryId !== before.repositoryId || after.destinationRevision !== before.destinationRevision) {
      throw new Error("The forget ran, but its result could not be confirmed because the repository is not available; check it before trying again");
    }
    if (after.snapshots.some((snapshot) => snapshot.id === snapshotId)) throw new Error("The snapshot is still in the repository after forget");
    return { forgotten: true, snapshotId, repositoryId: after.repositoryId, beforeCount: before.snapshots.length, afterCount: after.snapshots.length, prunePerformed: false };
  }

  return { inspect, apply, forgetUnrecorded };
}


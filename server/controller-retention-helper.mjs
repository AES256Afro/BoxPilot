import { createControllerProtectionHelper } from "./controller-protection-helper.mjs";
import { parseSnapshotInventory, resticRepositoryUnder, resticRunner, shaPattern, snapshotSetRevision, validateRetentionInput } from "./restic-retention.mjs";
import { backupMountpoint } from "./backup-mount.mjs";

export const validateControllerRetentionInput = (input) => validateRetentionInput(input, { subject: "controller" });

export function createControllerRetentionHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  mountRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_MOUNT ?? backupMountpoint,
  passwordFile = process.env.BOXPILOT_CONTROLLER_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/controller-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_CONTROLLER_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-controller-restic",
  inspectDestination = createControllerProtectionHelper().inspect,
  run = resticRunner,
} = {}) {
  const { repository } = resticRepositoryUnder(mountRoot, { directory: "restic-controller", subject: "controller" });

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
        blockers: destination.blockers ?? ["The encrypted controller backup destination is unavailable"],
      };
    }
    const result = await run(resticBinary, [...commonResticArguments(), "snapshots", "--json", "--tag", "boxpilot-controller"], { timeout: 30000 });
    const snapshots = parseSnapshotInventory(result.stdout, { label: "controller" });
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
    const errors = validateControllerRetentionInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const before = await inspect();
    if (!before.ready || before.repositoryId !== parameters.repositoryId
      || before.destinationRevision !== parameters.expectedDestinationRevision
      || before.snapshotSetRevision !== parameters.expectedSnapshotSetRevision) {
      throw new Error("The encrypted controller repository or its snapshot inventory changed after approval");
    }
    const beforeIds = new Set(before.snapshots.map((snapshot) => snapshot.id));
    if (parameters.forgetSnapshotIds.some((id) => !beforeIds.has(id))) throw new Error("A reviewed controller snapshot is no longer present in the repository");

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
    const afterIdentityValid = after?.ready === true
      && after.repositoryId === before.repositoryId
      && after.destinationRevision === before.destinationRevision;
    if (after && !afterIdentityValid) verification.push("post-inspection-identity-unverified");
    const verifiedAfter = afterIdentityValid ? after : null;
    const afterIds = new Set(verifiedAfter?.snapshots?.map((snapshot) => snapshot.id) ?? []);
    // Only what a fresh inspection shows gone counts as forgotten. Trusting the forget command's
    // own exit code marked backups as removed that might still be there, and then reported the run
    // as complete — so the next preview found snapshots it could not account for and blocked.
    const actuallyForgotten = verifiedAfter ? parameters.forgetSnapshotIds.filter((id) => !afterIds.has(id)) : [];
    if (actuallyForgotten.length === 0) throw new Error("Controller retention could not confirm that any reviewed snapshot was removed");
    const allCandidatesAbsent = actuallyForgotten.length === parameters.forgetSnapshotIds.length;
    const allKeptPresent = verifiedAfter ? expectedKept.every((id) => afterIds.has(id)) : false;
    if (!allCandidatesAbsent) verification.push("candidate-still-present");
    if (!allKeptPresent) verification.push("noncandidate-presence-unverified");
    if (after && after.repositoryId !== before.repositoryId) verification.push("repository-identity-changed");
    // A run whose result could not be read is not a run known to be complete.
    const complete = forgetSucceeded && allCandidatesAbsent && verifiedAfter !== null;
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

  return { inspect, apply };
}


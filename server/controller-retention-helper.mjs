import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { createControllerProtectionHelper } from "./controller-protection-helper.mjs";

const execFile = promisify(execFileCallback);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;

async function defaultRunner(binary, args, { timeout = 180000 } = {}) {
  const result = await execFile(binary, args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function snapshotSetRevision(snapshots) {
  const evidence = snapshots
    .map((snapshot) => ({ id: snapshot.id, time: snapshot.time, tags: [...snapshot.tags].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

export function validateControllerRetentionInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A controller retention request is required"];
  const allowedKeys = ["expectedDestinationRevision", "expectedSnapshotSetRevision", "forgetSnapshotIds", "repositoryId", "retentionId"];
  const keys = Object.keys(input).sort();
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) errors.push("Controller retention accepts only fixed typed evidence fields");
  if (typeof input.retentionId !== "string" || !uuidPattern.test(input.retentionId)) errors.push("Retention id must be a UUID");
  if (typeof input.repositoryId !== "string" || !shaPattern.test(input.repositoryId)) errors.push("Repository id is invalid");
  if (typeof input.expectedDestinationRevision !== "string" || !shaPattern.test(input.expectedDestinationRevision)) errors.push("Destination revision is invalid");
  if (typeof input.expectedSnapshotSetRevision !== "string" || !shaPattern.test(input.expectedSnapshotSetRevision)) errors.push("Snapshot-set revision is invalid");
  if (!Array.isArray(input.forgetSnapshotIds) || input.forgetSnapshotIds.length < 1 || input.forgetSnapshotIds.length > 100) {
    errors.push("One to 100 exact snapshot ids are required");
  } else {
    if (input.forgetSnapshotIds.some((id) => typeof id !== "string" || !shaPattern.test(id))) errors.push("Every forgotten snapshot id must be an exact SHA-256 id");
    if (new Set(input.forgetSnapshotIds).size !== input.forgetSnapshotIds.length) errors.push("Forgotten snapshot ids must be unique");
    if (JSON.stringify(input.forgetSnapshotIds) !== JSON.stringify([...input.forgetSnapshotIds].sort())) errors.push("Forgotten snapshot ids must be sorted");
  }
  return errors;
}

export function createControllerRetentionHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  mountRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_MOUNT ?? "/mnt/boxpilot-backup",
  passwordFile = process.env.BOXPILOT_CONTROLLER_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/controller-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_CONTROLLER_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-controller-restic",
  inspectDestination = createControllerProtectionHelper().inspect,
  run = defaultRunner,
} = {}) {
  const resolvedMountRoot = path.resolve(mountRoot);
  if ((!resolvedMountRoot.startsWith("/mnt/") && !resolvedMountRoot.startsWith("/media/")) || resolvedMountRoot === "/mnt" || resolvedMountRoot === "/media") {
    throw new Error("The controller backup mount must be a dedicated path below /mnt or /media");
  }
  const repository = path.join(resolvedMountRoot, "restic-controller");
  if (path.dirname(repository) !== resolvedMountRoot || path.basename(repository) !== "restic-controller") throw new Error("The controller restic repository escaped the configured mount");

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
    const parsed = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(parsed) || parsed.length > 10000) throw new Error("Restic returned an invalid controller snapshot inventory");
    const snapshots = parsed.map((snapshot) => {
      if (!shaPattern.test(snapshot.id ?? "") || typeof snapshot.time !== "string" || !Number.isFinite(Date.parse(snapshot.time)) || !Array.isArray(snapshot.tags)
        || snapshot.tags.some((tag) => typeof tag !== "string" || tag.length > 128)) {
        throw new Error("Restic returned invalid controller snapshot evidence");
      }
      return { id: snapshot.id, time: snapshot.time, tags: [...snapshot.tags].sort() };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) throw new Error("Restic returned duplicate controller snapshot ids");
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
    const actuallyForgotten = verifiedAfter
      ? parameters.forgetSnapshotIds.filter((id) => !afterIds.has(id))
      : forgetSucceeded ? [...parameters.forgetSnapshotIds] : [];
    if (actuallyForgotten.length === 0) throw new Error("Controller retention failed before any reviewed snapshot removal was confirmed");
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

  return { inspect, apply };
}

export const controllerRetentionHelperInternals = { defaultRunner, snapshotSetRevision };

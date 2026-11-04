/**
 * What the two restic retention paths — BoxPilot's own database (`controller-retention-helper.mjs`)
 * and the VM exports (`vm-retention-helper.mjs`) — share (M53.3).
 *
 * They were the same code twice: 136 of 164 lines identical after renaming, in the root-running
 * helpers that decide which backups may be deleted. And they had already drifted. Both validated
 * restic's snapshot evidence with the same line, except that only the controller side rejected a
 * `time` that is a string but not a date. Nothing downstream broke, which is exactly why nobody
 * noticed: a one-sided hardening of duplicated validation is invisible until the day it matters.
 *
 * So the validation lives here once, hardened on both paths, and the helpers keep only what really
 * differs: the restic tag, the repository directory, the password and cache paths, and the words
 * the owner reads.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const shaPattern = /^[a-f0-9]{64}$/;

/** restic, with nothing of the caller's environment but a fixed PATH. */
export async function resticRunner(binary, args, { timeout = 180000 } = {}) {
  const result = await execFile(binary, args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** One digest over a whole snapshot set, so "the repository changed after approval" is one compare. */
export function snapshotSetRevision(snapshots) {
  const evidence = snapshots
    .map((snapshot) => ({ id: snapshot.id, time: snapshot.time, tags: [...snapshot.tags].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/**
 * A retention request, as the web side staged it: fixed fields, exact ids, sorted and unique, so
 * nothing the caller sends can widen what is deleted.
 * @param {any} input The staged request as it arrived over the helper socket: parsed JSON, so dynamic.
 * @param {{ subject: string }} options `subject` names the path in the words the owner reads.
 */
export function validateRetentionInput(input, { subject }) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return [`A ${subject} retention request is required`];
  const allowedKeys = ["expectedDestinationRevision", "expectedSnapshotSetRevision", "forgetSnapshotIds", "repositoryId", "retentionId"];
  const keys = Object.keys(input).sort();
  // "controller" reads mid-sentence in "A controller retention request is required" and at the start
  // of this one, where it needs its capital. "VM" already has both.
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) errors.push(`${Subject} retention accepts only fixed typed evidence fields`);
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

/**
 * `restic snapshots --json`, checked field by field and sorted by id. Every snapshot must carry an
 * exact id, a parseable time and string tags; one that does not means the inventory is not restic's
 * and nothing is deleted on the strength of it.
 *
 * The time's parseability is checked on both paths. Before this module it was checked on one.
 * @param {string} stdout
 * @param {{ label: string }} options `label` names the inventory in the error the owner reads.
 */
export function parseSnapshotInventory(stdout, { label }) {
  const parsed = JSON.parse(stdout || "[]");
  if (!Array.isArray(parsed) || parsed.length > 10000) throw new Error(`Restic returned an invalid ${label} snapshot inventory`);
  const snapshots = parsed.map((snapshot) => {
    if (!shaPattern.test(snapshot.id ?? "") || typeof snapshot.time !== "string" || !Number.isFinite(Date.parse(snapshot.time)) || !Array.isArray(snapshot.tags)
      || snapshot.tags.some((tag) => typeof tag !== "string" || tag.length > 128)) {
      throw new Error(`Restic returned invalid ${label} snapshot evidence`);
    }
    return { id: snapshot.id, time: snapshot.time, tags: [...snapshot.tags].sort() };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) throw new Error(`Restic returned duplicate ${label} snapshot ids`);
  return snapshots;
}

/**
 * The repository directory under a mount that must be dedicated: a path below /mnt or /media and
 * not those roots themselves, with the repository one named directory inside it.
 * @param {string} mountRoot
 * @param {{ directory: string, subject: string }} options
 */
export function resticRepositoryUnder(mountRoot, { directory, subject }) {
  const resolvedMountRoot = path.resolve(mountRoot);
  if ((!resolvedMountRoot.startsWith("/mnt/") && !resolvedMountRoot.startsWith("/media/")) || resolvedMountRoot === "/mnt" || resolvedMountRoot === "/media") {
    throw new Error(`The ${subject} backup mount must be a dedicated path below /mnt or /media`);
  }
  const repository = path.join(resolvedMountRoot, directory);
  if (path.dirname(repository) !== resolvedMountRoot || path.basename(repository) !== directory) throw new Error(`The ${subject} restic repository escaped the configured mount`);
  return { resolvedMountRoot, repository };
}

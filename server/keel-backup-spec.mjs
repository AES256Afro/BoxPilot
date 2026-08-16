import path from "node:path";
import { keelArtifactSpec, validUuid } from "./keel-artifact-spec.mjs";
import { keelInstallPaths, keelServiceIdentity } from "./keel-install-spec.mjs";

export const keelBackupPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/backups/keel",
  restoreRoot: "/var/lib/boxpilot-managed/restore-drills",
  approval: "/run/boxpilot/keel-backup-approval.json",
});

export const keelBackupIdentity = Object.freeze({
  schemaVersion: 1,
  applicationId: "keel",
  destination: "local-managed",
  releaseTag: keelArtifactSpec.releaseTag,
  releaseCommitSha: keelArtifactSpec.releaseCommitSha,
  releaseVersion: keelServiceIdentity.releaseVersion,
  releasePath: keelInstallPaths.release,
  statePath: keelInstallPaths.state,
  unitName: keelServiceIdentity.unitName,
});

export function pathsForKeelBackup(backupId, paths = keelBackupPaths) {
  if (!validUuid(backupId)) throw new Error("Keel backup id must be a UUID");
  const root = path.resolve(paths.root);
  const restoreRoot = path.resolve(paths.restoreRoot);
  const partial = path.join(root, `.${backupId}.partial`);
  const archive = path.join(root, `${backupId}.tar.gz`);
  const archivePartial = path.join(root, `.${backupId}.tar.gz.partial`);
  const result = path.join(root, `${backupId}.result.json`);
  const drill = path.join(restoreRoot, `keel-${backupId}`);
  if ([partial, archive, archivePartial, result].some((candidate) => path.dirname(candidate) !== root) || path.dirname(drill) !== restoreRoot) {
    throw new Error("Keel backup paths escaped their fixed roots");
  }
  return { root, restoreRoot, partial, exportRoot: path.join(partial, "keel-export"), archive, archivePartial, result, drill, drillExport: path.join(drill, "keel-export") };
}

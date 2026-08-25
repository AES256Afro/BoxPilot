import { defineOperation } from "./registry.mjs";
import { mountNamePattern } from "../tasks/storage.mjs";
import { credentialPattern, hostPattern, nfsExportPattern, shareKinds, validSmbShare } from "../tasks/shares.mjs";

const minutes = (value) => value * 60_000;

/**
 * Network shares (SMB/NFS) as permanent, self-reconnecting mounts. The password field is
 * marked `secret`: the job service keeps it in memory only and never writes it to the
 * database or the job log.
 */
export function shareOperations() {
  return [
    defineOperation({
      id: "share.mount", title: "Mount a network share", risk: "medium", timeoutMs: minutes(4),
      description: "Adds a nofail, automount fstab entry for an SMB or NFS share at /mnt/<name>, stores SMB credentials root-only, mounts it, and removes everything again if the first mount fails.",
      parameters: { fields: {
        kind: { type: "string", enum: [...shareKinds] },
        host: { type: "string", maxLength: 253, pattern: hostPattern },
        share: { type: "string", maxLength: 255, validate: (value, parameters) => ((parameters.kind === "nfs" ? nfsExportPattern.test(value) : validSmbShare(value)) ? null : parameters.kind === "nfs" ? "must be an absolute export path" : "may use letters, digits, spaces, dot, underscore, hyphen, and / for a folder inside the share") },
        name: { type: "string", maxLength: 32, pattern: mountNamePattern },
        username: { type: "string", optional: true, nullable: true, maxLength: 64, pattern: credentialPattern },
        password: { type: "string", optional: true, nullable: true, maxLength: 256, secret: true },
        domain: { type: "string", optional: true, nullable: true, maxLength: 64, pattern: credentialPattern },
        readOnly: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("share.mount", {
        kind: parameters.kind, host: parameters.host, share: parameters.share, name: parameters.name,
        username: parameters.username ?? null, password: parameters.password ?? null, domain: parameters.domain ?? null, readOnly: parameters.readOnly ?? false,
      }, { timeoutMs: minutes(3), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "share.unmount", title: "Unmount a network share", risk: "medium", timeoutMs: minutes(3),
      description: "Unmounts /mnt/<name>, removes the fstab entry and the automount unit, and deletes the stored credentials. The empty directory is kept.",
      parameters: { fields: { name: { type: "string", maxLength: 32, pattern: mountNamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("share.unmount", { name: parameters.name }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
  ];
}

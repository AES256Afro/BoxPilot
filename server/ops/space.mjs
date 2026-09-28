/**
 * Low-space recovery (M30.8): where the space went, a preview of a bounded cleanup, and the cleanup.
 *
 * The two reads run in the root helper and report sizes of things the caller could not have
 * measured, the journal, other people's job logs, the backup folders, so they need an operator
 * (ADR-003). The preview takes the cleanup's own parameters, so what it shows is what runs.
 */
import { defineOperation } from "./registry.mjs";
import { cleanupParameters, createSpaceRecovery } from "../space-recovery.mjs";

/** The helper's service when it has one; otherwise one built over the same runner and task client. */
const spaceRecovery = ({ spaceRecovery: given, run, runUnit, housekeeping }) => given ?? createSpaceRecovery({ ...(run ? { run } : {}), runUnit: runUnit ?? null, ...(housekeeping ? { housekeeping } : {}) });

export function spaceOperations() {
  return [
    defineOperation({
      id: "space.inspect", title: "See where the disk space went", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 3 * 60_000,
      description: "Bytes and inodes used by the system journal, BoxPilot's job logs, APT's download cache, Docker and the local backups, with the free space and inodes of the filesystems they are on.",
      run: (_parameters, dependencies) => spaceRecovery(dependencies).inspect(),
    }),
    defineOperation({
      id: "space.cleanup.preview", title: "Preview a disk-space cleanup", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 3 * 60_000,
      description: "Lists exactly what a cleanup with these bounds removes, how much space that frees, and what it keeps.",
      parameters: cleanupParameters,
      run: (parameters, dependencies) => spaceRecovery(dependencies).plan(parameters),
    }),
    defineOperation({
      id: "space.cleanup", title: "Free disk space", risk: "medium", timeoutMs: 30 * 60_000,
      description: "Removes what the preview listed, in the categories you chose: archived journal files beyond the size or age you set, APT's downloaded packages, dangling Docker images no container uses, and logs of completed jobs older than the retention you set. The journal file being written, logs of running or failed jobs, volumes, tagged images and backups stay. Measures the space freed before and after.",
      parameters: cleanupParameters,
      run: (parameters, dependencies) => spaceRecovery(dependencies).cleanup(parameters, { progress: dependencies.progress ?? null, jobLog: dependencies.jobLog ?? null }),
    }),
  ];
}

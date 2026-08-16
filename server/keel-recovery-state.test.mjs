import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectKeelRecoveryState } from "./keel-recovery-state.mjs";
import { pathsForKeelRecovery } from "./keel-recovery-spec.mjs";
import { keelBackupScriptInternals } from "../scripts/boxpilot-keel-backup.mjs";

const directories = [];
const recoveryId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("published Keel recovery state inspection", () => {
  it("accepts a root-only directory tree with normal subdirectory link counts and detects later changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-state-"));
    directories.push(directory);
    const recoveryPaths = { root: path.join(directory, "recoveries") };
    const targets = pathsForKeelRecovery(recoveryId, recoveryPaths);
    await mkdir(path.join(targets.finalState, "uploads"), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path.join(targets.finalState, "keel.db"));
    for (const table of ["AppSetting", "Page", "User", "Workspace"]) database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY);`);
    database.close();
    await writeFile(path.join(targets.finalState, ".env"), "HOST=127.0.0.1\n", { mode: 0o600 });
    await writeFile(path.join(targets.finalState, "uploads", "note.txt"), "note\n", { mode: 0o600 });
    await chmod(targets.final, 0o700);
    await chmod(targets.finalState, 0o700);
    await chmod(path.join(targets.finalState, "uploads"), 0o700);
    for (const file of ["keel.db", ".env", "uploads/note.txt"]) await chmod(path.join(targets.finalState, file), 0o600);
    const tree = await keelBackupScriptInternals.inspectTree(targets.finalState);
    await writeFile(targets.finalEvidence, `${JSON.stringify({
      schemaVersion: 1, recoveryId, backupId, destination: "managed-keel-recovery", statePath: targets.finalState,
      sourceArtifactChecksumSha256: "a".repeat(64), sourceManifestChecksumSha256: "b".repeat(64), sourceSizeBytes: 4096,
      restoredTreeDigestSha256: tree.digest, restoredRegularFiles: tree.regularFiles, restoredDirectories: tree.directories, restoredLogicalBytes: tree.bytes,
      databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, environmentIncluded: true, initialState: "stopped", network: "none",
      applicationStarted: false, productionStateReplaced: false, sourceArtifactChanged: false, browserPathAccepted: false,
      browserCommandAccepted: false, promotionPerformed: false,
    })}\n`, { mode: 0o600 });
    const options = { recoveryPaths, expectedRootUid: process.getuid(), expectedRootGid: process.getgid() };
    await expect(inspectKeelRecoveryState(recoveryId, options)).resolves.toMatchObject({ ready: true, recoveryId, backupId, stateDirectories: 2 });
    await writeFile(path.join(targets.finalState, "uploads", "note.txt"), "changed\n", { mode: 0o600 });
    await expect(inspectKeelRecoveryState(recoveryId, options)).rejects.toThrow("changed after creation");
  });
});

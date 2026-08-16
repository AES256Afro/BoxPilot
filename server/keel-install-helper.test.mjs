import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeelInstallHelper } from "./keel-install-helper.mjs";
import {
  keelEnvironmentContent,
  keelEnvironmentSha256,
  keelServiceIdentity,
  keelServiceUnitContent,
  keelServiceUnitSha256,
} from "./keel-install-spec.mjs";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop(), { recursive: true, force: true });
});

async function fixturePaths() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-install-helper-"));
  cleanup.push(temporary);
  return {
    root: path.join(temporary, "managed", "keel"),
    release: path.join(temporary, "managed", "keel", "releases", "1.2.6"),
    current: path.join(temporary, "managed", "keel", "current"),
    evidence: path.join(temporary, "managed", "keel", ".boxpilot-install.json"),
    approval: path.join(temporary, "run", "keel-install-approval.json"),
    state: path.join(temporary, "state"),
    environment: path.join(temporary, "state", ".env"),
    database: path.join(temporary, "state", "keel.db"),
    managedSecretKey: path.join(temporary, "state", ".keel-server-secrets.key"),
    uploads: path.join(temporary, "state", "uploads"),
    backups: path.join(temporary, "state", "backups"),
    unit: path.join(temporary, "etc", "keel.service"),
  };
}

describe("Keel installation helper", () => {
  it("reports a staged release as installable without mutating the host", async () => {
    const paths = await fixturePaths();
    const helper = createKeelInstallHelper({
      paths,
      stageHelper: { inspect: async () => ({ state: "staged", staged: true, version: "1.2.6" }) },
      inspectAccount: async () => ({ state: "absent", exact: false, uid: null, gid: null }),
    });
    await expect(helper.inspect()).resolves.toMatchObject({
      state: "absent",
      installed: false,
      readyToInstall: true,
      healthy: false,
      claim: { terminalRequired: true },
      boundary: { mutationPerformed: false, databaseOpened: false, secretRead: false },
    });
  });

  it("requires exact activation, service, state, account, evidence, and live health", async () => {
    const paths = await fixturePaths();
    const uid = process.getuid();
    const gid = process.getgid();
    await mkdir(paths.release, { recursive: true, mode: 0o750 });
    await mkdir(paths.state, { mode: 0o700 });
    await mkdir(path.dirname(paths.unit), { recursive: true });
    await symlink(path.relative(path.dirname(paths.current), paths.release), paths.current);
    await writeFile(paths.environment, keelEnvironmentContent(), { mode: 0o640 });
    await chmod(paths.environment, 0o640);
    await writeFile(paths.unit, keelServiceUnitContent(), { mode: 0o644 });
    await chmod(paths.unit, 0o644);
    await writeFile(paths.database, "", { mode: 0o600 });
    const installId = "11111111-1111-4111-8111-111111111111";
    await writeFile(paths.evidence, `${JSON.stringify({
      schemaVersion: 1,
      installId,
      installedAt: "2026-08-16T12:00:00.000Z",
      releaseTag: keelArtifactSpec.releaseTag,
      releaseCommitSha: keelArtifactSpec.releaseCommitSha,
      releaseVersion: keelServiceIdentity.releaseVersion,
      releasePath: paths.release,
      statePath: paths.state,
      unitName: keelServiceIdentity.unitName,
      unitSha256: keelServiceUnitSha256,
      environmentSha256: keelEnvironmentSha256,
      bindAddress: keelServiceIdentity.bindAddress,
      port: keelServiceIdentity.port,
    })}\n`, { mode: 0o640 });
    await chmod(paths.evidence, 0o640);
    const helper = createKeelInstallHelper({
      paths,
      expectedRootUid: uid,
      stageHelper: { inspect: async () => ({ state: "staged", staged: true, version: "1.2.6" }) },
      inspectAccount: async () => ({ state: "exact", exact: true, uid, gid }),
      inspectHealth: async () => true,
      run: async () => ({ ok: true, stdout: "" }),
    });
    await expect(helper.inspect()).resolves.toMatchObject({
      state: "installed",
      installed: true,
      readyToInstall: false,
      releaseVersion: "1.2.6",
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      listener: "127.0.0.1:3000",
      databasePresent: true,
      managedSecretKeyPresent: false,
      account: { state: "exact", dedicated: true },
      activation: { exact: true, release: "1.2.6" },
      unit: { exact: true, hardened: true },
      claim: { state: "unclaimed-or-unknown", terminalRequired: true },
      boundary: { mutationPerformed: false, claimChanged: false, tailscaleChanged: false },
    });
  });

  it("fails closed on browser-selected install fields", async () => {
    const paths = await fixturePaths();
    const helper = createKeelInstallHelper({ paths });
    await expect(helper.install({ installId: "11111111-1111-4111-8111-111111111111", command: "bash" })).rejects.toThrow("only one installId UUID");
  });
});

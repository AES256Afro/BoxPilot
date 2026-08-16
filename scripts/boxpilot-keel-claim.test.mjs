// @vitest-environment node
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keelArtifactSpec } from "../server/keel-artifact-spec.mjs";
import {
  keelEnvironmentContent,
  keelEnvironmentSha256,
  keelServiceIdentity,
  keelServiceUnitSha256,
} from "../server/keel-install-spec.mjs";
import { claimInstalledKeel } from "./boxpilot-keel-claim.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop(), { recursive: true, force: true });
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-claim-"));
  cleanup.push(temporary);
  const uid = process.getuid();
  const gid = process.getgid();
  const paths = {
    root: path.join(temporary, "managed", "keel"),
    release: path.join(temporary, "managed", "keel", "releases", "1.2.6"),
    current: path.join(temporary, "managed", "keel", "current"),
    evidence: path.join(temporary, "managed", "keel", ".boxpilot-install.json"),
    state: path.join(temporary, "state"),
    environment: path.join(temporary, "state", ".env"),
    database: path.join(temporary, "state", "keel.db"),
  };
  await mkdir(paths.release, { recursive: true, mode: 0o750 });
  await mkdir(paths.state, { mode: 0o700 });
  await symlink(path.relative(path.dirname(paths.current), paths.release), paths.current);
  await writeFile(paths.environment, keelEnvironmentContent(), { mode: 0o640 });
  await writeFile(paths.database, "sqlite fixture", { mode: 0o600 });
  await writeFile(paths.evidence, `${JSON.stringify({
    schemaVersion: 1,
    installId: "11111111-1111-4111-8111-111111111111",
    installedAt: "2026-08-16T14:00:00.000Z",
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
    healthIdentityVerified: true,
    claimRequired: true,
    privateAccessConfigured: false,
  })}\n`, { mode: 0o640 });
  await chmod(paths.environment, 0o640);
  await chmod(paths.database, 0o600);
  await chmod(paths.evidence, 0o640);
  return { paths, uid, gid };
}

describe("Keel terminal claim handoff", () => {
  it("rechecks the fixed boundary, drops permanently to keel, and injects only the fixed claim authorization", async () => {
    const value = await fixture();
    const calls = [];
    const runClaim = vi.fn(async (options) => ({ status: "claimed", databasePath: options.defaultDatabase }));
    const result = await claimInstalledKeel({
      token: `keel_claim_${"a".repeat(43)}`,
      paths: value.paths,
      rootUid: value.uid,
      uid: 0,
      sudoUid: "1000",
      stdinTty: true,
      stdoutTty: true,
      inspectAccount: async () => ({ uid: value.uid, gid: value.gid }),
      serviceActive: () => true,
      setGroups: (groups) => calls.push(["groups", groups]),
      setGid: (gid) => calls.push(["gid", gid]),
      setUid: (uid) => calls.push(["uid", uid]),
      runClaim,
    });
    expect(result).toMatchObject({ status: "claimed", databasePath: value.paths.database });
    expect(calls).toEqual([["groups", [value.gid]], ["gid", value.gid], ["uid", value.uid]]);
    expect(runClaim).toHaveBeenCalledWith(expect.objectContaining({
      token: `keel_claim_${"a".repeat(43)}`,
      appRoot: value.paths.release,
      envFile: value.paths.environment,
      defaultDatabase: value.paths.database,
      processEnvironment: {
        DATABASE_URL: `file:${value.paths.database}`,
        KEEL_ENV_FILE: value.paths.environment,
        KEEL_HOME: value.paths.state,
      },
    }));
  });

  it("rejects a root login, noninteractive call, malformed token, or changed environment before privilege drop", async () => {
    const value = await fixture();
    const common = { paths: value.paths, rootUid: value.uid, inspectAccount: async () => ({ uid: value.uid, gid: value.gid }), serviceActive: () => true, setGroups: vi.fn(), setGid: vi.fn(), setUid: vi.fn(), runClaim: vi.fn() };
    await expect(claimInstalledKeel({ ...common, token: "changed", uid: 0, sudoUid: "1000", stdinTty: true, stdoutTty: true })).rejects.toThrow("five-minute");
    await expect(claimInstalledKeel({ ...common, token: `keel_claim_${"a".repeat(43)}`, uid: 0, sudoUid: undefined, stdinTty: true, stdoutTty: true })).rejects.toThrow("normal Bigbox administrator");
    await expect(claimInstalledKeel({ ...common, token: `keel_claim_${"a".repeat(43)}`, uid: 0, sudoUid: "1000", stdinTty: false, stdoutTty: true })).rejects.toThrow("interactively");
    await writeFile(value.paths.environment, "DATABASE_URL=file:/tmp/changed.db\n", { mode: 0o640 });
    await expect(claimInstalledKeel({ ...common, token: `keel_claim_${"a".repeat(43)}`, uid: 0, sudoUid: "1000", stdinTty: true, stdoutTty: true })).rejects.toThrow("content changed");
    expect(common.setUid).not.toHaveBeenCalled();
    expect(common.runClaim).not.toHaveBeenCalled();
  });
});

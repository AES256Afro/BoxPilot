import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installApprovedKeel, keelInstallScriptInternals } from "./boxpilot-keel-install.mjs";
import { keelArtifactSpec } from "../server/keel-artifact-spec.mjs";
import {
  keelEnvironmentSha256,
  keelServiceIdentity,
  keelServiceUnitSha256,
} from "../server/keel-install-spec.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop(), { recursive: true, force: true });
});

async function fixturePaths() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-install-script-"));
  cleanup.push(temporary);
  const paths = {
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
  await mkdir(path.join(paths.release, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.unit), { recursive: true });
  await mkdir(path.dirname(paths.approval), { recursive: true });
  await writeFile(path.join(paths.release, "package.json"), "{}\n", { mode: 0o600 });
  await writeFile(path.join(paths.release, "bin", "keel.mjs"), "#!/usr/bin/env node\n", { mode: 0o700 });
  return paths;
}

function approval(paths, overrides = {}) {
  return JSON.stringify({
    installId: "11111111-1111-4111-8111-111111111111",
    approvedAt: "2026-08-16T12:00:00.000Z",
    releaseTag: keelArtifactSpec.releaseTag,
    releaseCommitSha: keelArtifactSpec.releaseCommitSha,
    releaseVersion: keelServiceIdentity.releaseVersion,
    releasePath: paths.release,
    statePath: paths.state,
    currentPath: paths.current,
    unitName: keelServiceIdentity.unitName,
    unitSha256: keelServiceUnitSha256,
    environmentSha256: keelEnvironmentSha256,
    bindAddress: keelServiceIdentity.bindAddress,
    port: keelServiceIdentity.port,
    ...overrides,
  });
}

describe("fixed Keel installation service", () => {
  it("atomically activates only the reviewed release and proves loopback health", async () => {
    const paths = await fixturePaths();
    const uid = process.getuid();
    const gid = process.getgid();
    const calls = [];
    const run = async (binary, args) => {
      calls.push([binary, args]);
      if (args[0] === "start" && args[1] === "keel.service") await writeFile(paths.database, "", { mode: 0o600 });
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await installApprovedKeel({
      paths,
      loadApproval: async () => approval(paths),
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      run,
      requestHealth: async () => true,
      stageHelper: { inspect: async () => ({ state: "staged", staged: true, version: "1.2.6" }) },
      ensureAccount: async () => ({ uid, gid }),
      expectedReleaseCounts: { regularFiles: 2, directories: 2 },
      rootUid: uid,
      rootGid: gid,
    });
    expect(result).toMatchObject({
      installId: "11111111-1111-4111-8111-111111111111",
      releaseCounts: { regularFiles: 2, directories: 2 },
      serviceStarted: true,
      serviceEnabled: true,
    });
    expect(path.resolve(path.dirname(paths.current), await readlink(paths.current))).toBe(paths.release);
    expect(JSON.parse(await readFile(paths.evidence, "utf8"))).toMatchObject({
      releaseVersion: "1.2.6",
      bindAddress: "127.0.0.1",
      port: 3000,
      healthIdentityVerified: true,
      claimRequired: true,
      privateAccessConfigured: false,
    });
    expect((await lstat(paths.state)).mode & 0o7777).toBe(0o700);
    expect((await lstat(paths.environment)).mode & 0o7777).toBe(0o640);
    expect((await lstat(paths.unit)).mode & 0o7777).toBe(0o644);
    expect(calls.some(([, args]) => args.join(" ") === "enable keel.service")).toBe(true);
    expect(calls.some(([, args]) => args.join(" ") === "start keel.service")).toBe(true);
  });

  it("rejects changed or stale approval markers before host mutation", async () => {
    const paths = await fixturePaths();
    expect(() => keelInstallScriptInternals.parseApproval(approval(paths, { port: 4000 }), new Date("2026-08-16T12:01:00.000Z"), paths)).toThrow("does not match");
    expect(() => keelInstallScriptInternals.parseApproval(approval(paths), new Date("2026-08-16T12:06:00.001Z"), paths)).toThrow("stale");
    expect(() => keelInstallScriptInternals.parseApproval(approval(paths, { command: "bash" }), new Date("2026-08-16T12:01:00.000Z"), paths)).toThrow("unexpected fields");
  });
});

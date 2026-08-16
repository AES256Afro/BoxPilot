import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupApprovedKeel, keelBackupScriptInternals } from "./boxpilot-keel-backup.mjs";
import { keelArtifactSpec } from "../server/keel-artifact-spec.mjs";
import { pathsForKeelBackup } from "../server/keel-backup-spec.mjs";

const execFile = promisify(execFileCallback);
const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";

function createKeelDatabase(target) {
  const database = new DatabaseSync(target);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE AppSetting (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE Page (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE Workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO AppSetting VALUES ('registration', 'closed');
    INSERT INTO Page VALUES ('page-one', 'Recovery proof');
    INSERT INTO User VALUES ('user-one', 'operator');
    INSERT INTO Workspace VALUES ('workspace-one', 'Private');
  `);
  database.close();
}

async function fixture({ exportSucceeds = true, exportIncomplete = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-backup-"));
  directories.push(directory);
  const paths = {
    root: path.join(directory, "managed", "backups", "keel"),
    restoreRoot: path.join(directory, "managed", "restore-drills"),
    approval: path.join(directory, "run", "keel-backup-approval.json"),
  };
  const installPaths = {
    release: path.join(directory, "managed", "apps", "keel", "releases", "1.2.6"),
    state: path.join(directory, "state"),
    database: path.join(directory, "state", "keel.db"),
    environment: path.join(directory, "state", ".env"),
  };
  await mkdir(path.join(installPaths.release, "bin"), { recursive: true });
  await mkdir(installPaths.state, { recursive: true });
  await writeFile(path.join(installPaths.release, "bin", "keel.mjs"), "// fixed upstream entrypoint\n");
  await writeFile(installPaths.environment, "KEEL_BASE_URL=http://127.0.0.1:3000\n", { mode: 0o600 });
  createKeelDatabase(installPaths.database);
  const calls = [];
  const run = vi.fn(async (binary, args) => {
    calls.push({ binary, args: [...args] });
    if (binary === "/usr/bin/systemctl") {
      if (args[0] === "is-active") return { ok: false, stdout: "inactive", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    }
    if (binary === "/usr/local/bin/node") {
      if (!exportSucceeds) return { ok: false, stdout: "", stderr: "export failed" };
      const target = args.at(-1);
      createKeelDatabase(target);
      await writeFile(`${target}.keel-server-secrets.key`, "a".repeat(64), { mode: 0o600 });
      await mkdir(`${target}.uploads`, { mode: 0o700 });
      await writeFile(path.join(`${target}.uploads`, "attachment.txt"), "private attachment\n", { mode: 0o600 });
      return { ok: true, stdout: exportIncomplete ? "exported\nkeel.db.uploads is INCOMPLETE - 1 file copied, 1 skipped" : "exported", stderr: "" };
    }
    if (binary === "/usr/bin/tar") {
      const result = await execFile(binary, args, { encoding: "utf8" });
      return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    }
    throw new Error(`Unexpected binary ${binary}`);
  });
  const approval = JSON.stringify({
    backupId,
    installId,
    approvedAt: "2026-08-16T12:00:00.000Z",
    releaseTag: keelArtifactSpec.releaseTag,
    releaseCommitSha: keelArtifactSpec.releaseCommitSha,
    releaseVersion: "1.2.6",
    unitName: "keel.service",
  });
  const installHelper = { inspect: vi.fn(async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" })) };
  const result = () => backupApprovedKeel({
    paths,
    installPaths,
    loadApproval: async () => approval,
    now: () => new Date("2026-08-16T12:00:05.000Z"),
    clock: (() => { let value = 1000; return () => { value += 25; return value; }; })(),
    run,
    requestHealth: async () => true,
    installHelper,
    account: { uid: process.getuid(), gid: process.getgid() },
    rootUid: process.getuid(),
    rootGid: process.getgid(),
  });
  return { directory, paths, installPaths, run, calls, result };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixed Keel backup one-shot", () => {
  it("creates a private consistent export, restarts the source, and passes an isolated SQLite drill", async () => {
    const { paths, calls, result } = await fixture();
    const evidence = await result();
    const targets = pathsForKeelBackup(backupId, paths);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      backupId,
      installId,
      applicationId: "keel",
      destination: "local-managed",
      releaseVersion: "1.2.6",
      sourceRestartVerified: true,
      restoreDrill: {
        passed: true,
        mode: "isolated-keel-export-open",
        network: "none",
        publishedPorts: 0,
        databaseIntegrity: "ok",
        foreignKeyIssues: 0,
        schemaVerified: true,
        managedSecretCompanionIncluded: true,
        environmentIncluded: true,
        uploadsIncluded: true,
        treeDigestMatched: true,
        workspaceRemoved: true,
        applicationStarted: false,
        productionStateReplaced: false,
      },
      boundary: {
        browserPathAccepted: false,
        browserCommandAccepted: false,
        browserTokenAccepted: false,
        secretContentReturned: false,
        environmentContentReturned: false,
        sourceServiceStopped: true,
        sourceRestarted: true,
        networkAccessRequiredForDrill: false,
        productionStateReplaced: false,
        registrationChanged: false,
        claimChanged: false,
        tailscaleChanged: false,
        firewallChanged: false,
        routerChanged: false,
        independentCopyCreated: false,
        retentionPerformed: false,
        prunePerformed: false,
      },
    });
    expect(evidence.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.manifestChecksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(targets.archive)).mode & 0o777).toBe(0o600);
    expect((await stat(targets.result)).mode & 0o777).toBe(0o600);
    await expect(stat(targets.partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.drill)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(targets.result, "utf8"))).toEqual(evidence);
    expect(calls.filter((call) => call.binary === "/usr/bin/systemctl").map((call) => call.args[0])).toEqual(["stop", "is-active", "start"]);
    expect(calls.find((call) => call.binary === "/usr/local/bin/node")?.args).toEqual([expect.stringMatching(/keel\.mjs$/), "export", expect.stringMatching(/keel\.db$/)]);
  });

  it("guarantees a source restart and removes generated artifacts when export fails", async () => {
    const { paths, calls, result } = await fixture({ exportSucceeds: false });
    await expect(result()).rejects.toThrow("fixed upstream Keel export");
    const targets = pathsForKeelBackup(backupId, paths);
    expect(calls.filter((call) => call.binary === "/usr/bin/systemctl").map((call) => call.args[0])).toEqual(["stop", "is-active", "start"]);
    await expect(stat(targets.partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.result)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on the upstream partial-uploads warning and still restores source health", async () => {
    const { paths, calls, result } = await fixture({ exportIncomplete: true });
    await expect(result()).rejects.toThrow("incomplete upload coverage");
    const targets = pathsForKeelBackup(backupId, paths);
    expect(calls.filter((call) => call.binary === "/usr/bin/systemctl").map((call) => call.args[0])).toEqual(["stop", "is-active", "start"]);
    await expect(stat(targets.archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.result)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale approval, unsafe trees, and malformed managed-secret companions", async () => {
    const approval = JSON.stringify({ backupId, installId, approvedAt: "2026-08-16T11:00:00.000Z", releaseTag: keelArtifactSpec.releaseTag, releaseCommitSha: keelArtifactSpec.releaseCommitSha, releaseVersion: "1.2.6", unitName: "keel.service" });
    expect(() => keelBackupScriptInternals.parseApproval(approval, new Date("2026-08-16T12:00:00.000Z"))).toThrow("stale");
    expect(keelBackupScriptInternals.validManagedKey("a".repeat(64))).toBe(true);
    expect(keelBackupScriptInternals.validManagedKey("not-a-secret-key")).toBe(false);
  });
});

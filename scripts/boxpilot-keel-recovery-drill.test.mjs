import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runApprovedKeelRecoveryDrill, keelRecoveryDrillScriptInternals } from "./boxpilot-keel-recovery-drill.mjs";
import { pathsForKeelRecoveryDrill } from "../server/keel-recovery-drill-spec.mjs";

const directories = [];
const recoveryId = "11111111-1111-4111-8111-111111111111";
const drillId = "22222222-2222-4222-8222-222222222222";
const evidence = "a".repeat(64);
const tree = "b".repeat(64);

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kill(signal) {
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    queueMicrotask(() => this.emit("exit", this.exitCode));
    return true;
  }
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-drill-script-"));
  directories.push(directory);
  const recoveryState = path.join(directory, "recovery-state");
  const drillPaths = { root: path.join(directory, "drills"), approval: path.join(directory, "approval.json") };
  const releasePath = path.join(directory, "release");
  await mkdir(path.join(recoveryState, "uploads"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(releasePath, "bin"), { recursive: true });
  await writeFile(path.join(releasePath, "bin", "keel.mjs"), "", { mode: 0o640 });
  const database = new DatabaseSync(path.join(recoveryState, "keel.db"));
  for (const table of ["AppSetting", "Page", "User", "Workspace"]) database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY);`);
  database.close();
  await writeFile(path.join(recoveryState, ".env"), "DATABASE_URL=file:/var/lib/keel/keel.db\nPORT=3000\n", { mode: 0o600 });
  await writeFile(path.join(recoveryState, "uploads", "note.txt"), "private\n", { mode: 0o600 });
  await writeFile(drillPaths.approval, `${JSON.stringify({ approvedAt: "2026-08-16T12:00:00.000Z", drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree, releaseVersion: "1.2.6", unitName: "boxpilot-keel-recovery-drill.service" })}\n`, { mode: 0o600 });
  const inspectRecovery = vi.fn(async () => ({ ready: true, recoveryId, statePath: recoveryState, evidenceChecksumSha256: evidence, stateTreeDigestSha256: tree }));
  return { directory, recoveryState, drillPaths, releasePath, inspectRecovery };
}

describe("fixed Keel recovery startup drill", () => {
  it("starts only a disposable copy, verifies it, stops it, and removes the workspace", async () => {
    const values = await fixture();
    const spawn = vi.fn(() => new FakeChild());
    const result = await runApprovedKeelRecoveryDrill({
      ...values,
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      account: { uid: process.getuid(), gid: process.getgid() },
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
      run: async (_binary, args) => ({ ok: args[0] === "is-active", stdout: "active", stderr: "" }),
      requestHealth: async () => true,
      spawn,
    });
    expect(result).toMatchObject({ passed: true, healthIdentityVerified: true, processStarted: true, processStopped: true, network: "private-loopback-only", publishedPorts: 0, workspaceRemoved: true, sourceRecoveryUnchanged: true, productionStateReplaced: false, promotionPerformed: false });
    expect(spawn).toHaveBeenCalledWith("/usr/local/bin/node", [path.join(values.releasePath, "bin", "keel.mjs"), "start", "--foreground", "--port", "3100"], expect.objectContaining({ uid: process.getuid(), gid: process.getgid(), cwd: values.releasePath, env: expect.objectContaining({ KEEL_HOME: expect.stringContaining(drillId), PORT: "3100", HOST: "127.0.0.1" }) }));
    const targets = pathsForKeelRecoveryDrill(drillId, values.drillPaths);
    await expect(stat(targets.partial)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(targets.result)).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(await readFile(targets.result, "utf8"))).toMatchObject({ drillId, recoveryId, loginTested: false });
    expect(await readFile(path.join(values.recoveryState, ".env"), "utf8")).toContain("/var/lib/keel");
  });

  it("fails closed on stale or expanded approval input", () => {
    const valid = { approvedAt: "2026-08-16T12:00:00.000Z", drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree, releaseVersion: "1.2.6", unitName: "boxpilot-keel-recovery-drill.service" };
    expect(() => keelRecoveryDrillScriptInternals.parseApproval(JSON.stringify(valid), new Date("2026-08-16T12:06:00.000Z"))).toThrow("stale");
    expect(() => keelRecoveryDrillScriptInternals.parseApproval(JSON.stringify({ ...valid, command: "sh" }), new Date("2026-08-16T12:01:00.000Z"))).toThrow("unexpected fields");
  });

  it("removes the generated partial and writes no result when health fails", async () => {
    const values = await fixture();
    const targets = pathsForKeelRecoveryDrill(drillId, values.drillPaths);
    await expect(runApprovedKeelRecoveryDrill({
      ...values,
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      account: { uid: process.getuid(), gid: process.getgid() },
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
      run: async () => ({ ok: true, stdout: "active", stderr: "" }),
      requestHealth: async () => false,
      healthWait: async () => false,
      spawn: () => new FakeChild(),
    })).rejects.toThrow("health identity");
    await expect(stat(targets.partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.result)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

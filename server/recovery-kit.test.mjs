import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecoveryKitService } from "./recovery-kit.mjs";
import { renderRcloneConfig } from "./backup-cloud.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

const noDrive = { snapshots: [], sync: { destination: "/mnt/boxpilot/backup/boxpilot-local-mirror", mount: { mounted: false }, lastSync: null } };

function catalogHelper({ installed = true, backups = [], countsAvailable = true, drive = noDrive } = {}) {
  return {
    request: vi.fn(async (operation, parameters) => {
      if (operation === "host.snapshot.inspect") { if (drive instanceof Error) throw drive; return drive; }
      if (operation === "app.inspect") return { applications: [{ id: "uptime-kuma", installed, container: { state: installed ? "running" : "absent" } }] };
      if (operation === "app.backups.inspect") return { id: parameters.id, directory: "/secret/backups/uptime-kuma", backups };
      if (operation === "app.backups.counts") return countsAvailable ? { available: true, counts: { "uptime-kuma": backups.length } } : { available: false, counts: {} };
      throw new Error(`Unexpected operation ${operation}`);
    }),
  };
}

async function setup({ installed = true, backups = [], countsAvailable = true, drive = noDrive, domains = [{ name: "notes-vm", state: "shut off", autostart: false }] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-recovery-kit-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory, now: () => new Date("2026-08-16T04:00:00.000Z") });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "private-owner", passwordHash: "secret-password-hash" });
  const service = createRecoveryKitService({
    store,
    prerequisites: { inspect: vi.fn(async () => ({ checks: [{ id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Typed protocol ready", repair: null }] })) },
    helper: catalogHelper({ installed, backups, countsAvailable, drive }),
    libvirt: { listDomains: vi.fn(async () => ({ connected: true, domains })) },
    now: () => new Date("2026-08-16T04:05:00.000Z"),
    version: "0.26.0-test",
  });
  return { owner, service, store };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("secret-free disaster recovery kit", () => {
  it("fails open evidence claims closed and gives an ordered operator runbook", async () => {
    const { service, store } = await setup();
    const kit = await service.inspect();
    expect(kit).toMatchObject({
      schemaVersion: 2,
      product: { version: "0.26.0-test" },
      mode: "secret-free-readiness-and-runbook",
      summary: { status: "action-required", total: 6 },
      boundary: { mutationsPerformed: false, databaseCopied: false, backupDataIncluded: false, credentialsIncluded: false },
    });
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "applications.backup", state: "action-required", evidence: expect.stringContaining("uptime-kuma") }),
      expect.objectContaining({ id: "virtualization.backup", state: "action-required" }),
    ]));
    expect(kit.recoveryOrder.map((item) => item.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(kit.runbookMarkdown).toContain("It is evidence and guidance, not a backup");
    store.close();
  });

  it("reports exact restore evidence without exporting secrets or sensitive state fields", async () => {
    const { owner, service, store } = await setup({ backups: [{ artifact: "uptime-kuma-20260816.tar.gz", sizeBytes: 1024, checksumSha256: "a".repeat(64), createdAt: "2026-08-16T03:00:00.000Z" }] });
    store.recordBackup({ id: "55555555-5555-4555-8555-555555555555", applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/secret/controller/boxpilot.sqlite3", checksumSha256: "e".repeat(64), sizeBytes: 8192, downtimeMs: 0, restoreDrill: { passed: true, integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, manifestChecksumSha256: "f".repeat(64), privateField: "do-not-export" }, createdBy: owner.id });
    store.recordVmExport({ id: "33333333-3333-4333-8333-333333333333", domainName: "notes-vm", domainUuid: "44444444-4444-4444-8444-444444444444", destination: "local-managed", artifactPath: "/secret/vm/export", manifestChecksumSha256: "d".repeat(64), sizeBytes: 2048, protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id });
    store.recordVmBackup({ id: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333", domainName: "notes-vm", domainUuid: "44444444-4444-4444-8444-444444444444", destination: "mounted-restic", repositoryId: "repository-safe-reference", snapshotId: "b".repeat(64), sizeBytes: 2048, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, password: "do-not-export" }, createdBy: owner.id });
    const kit = await service.inspect();
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "controller.database", state: "operator-check", evidence: expect.stringContaining("WAL-aware local controller snapshot") }),
      expect.objectContaining({ id: "applications.backup", state: "verified" }),
      expect.objectContaining({ id: "virtualization.backup", state: "verified" }),
    ]));
    const serialized = JSON.stringify(kit);
    expect(serialized).not.toContain("private-owner");
    expect(serialized).not.toContain("secret-password-hash");
    expect(serialized).not.toContain("/secret/controller/boxpilot.sqlite3");
    expect(serialized).not.toContain("/secret/backups/uptime-kuma");
    expect(serialized).not.toContain("do-not-export");
    expect(serialized).toContain("repository-safe-reference");
    expect(kit.evidence.controllerBackups).toEqual([expect.objectContaining({ checksumSha256: "e".repeat(64), manifestChecksumSha256: "f".repeat(64), restorePassed: true, schemaVerified: true })]);
    expect(kit.evidence.applications).toEqual([expect.objectContaining({ id: "uptime-kuma", installed: true, backupCount: 1 })]);
    expect(kit.runbookMarkdown).toContain("Installed catalog applications: 1");
    store.close();
  });

  it("uses explicit unavailable states when live collectors fail", async () => {
    const { store } = await setup();
    const failed = createRecoveryKitService({
      store,
      prerequisites: { inspect: vi.fn(async () => { throw new Error("offline"); }) },
      helper: { request: vi.fn(async () => { throw new Error("offline"); }) },
      libvirt: { listDomains: vi.fn(async () => { throw new Error("offline"); }) },
      version: "0.26.0-test",
    });
    const kit = await failed.inspect();
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "applications.backup", state: "unavailable" }),
      expect.objectContaining({ id: "virtualization.backup", state: "unavailable" }),
      expect.objectContaining({ id: "host.prerequisites", state: "unavailable" }),
    ]));
    expect(kit.evidence.virtualMachines.inventoryAvailable).toBe(false);
    store.close();
  });

  it("reports controller recovery verified only after encrypted independent exact-snapshot restore evidence", async () => {
    const { owner, service, store } = await setup({ installed: false, domains: [] });
    const backupId = "55555555-5555-4555-8555-555555555555";
    store.recordBackup({ id: backupId, applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/secret/controller/boxpilot.sqlite3", checksumSha256: "e".repeat(64), sizeBytes: 8192, downtimeMs: 0, restoreDrill: { passed: true, mode: "isolated-copy-open", integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, manifestChecksumSha256: "f".repeat(64) }, createdBy: owner.id });
    store.recordControllerBackupProtection({ id: "66666666-6666-4666-8666-666666666666", backupId, destination: "mounted-restic-controller", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64), sizeBytes: 8192, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", workspaceRemoved: true }, createdBy: owner.id });

    const kit = await service.inspect();
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "controller.database", state: "verified", evidence: expect.stringContaining("complete repository read") }),
      expect.objectContaining({ id: "applications.backup", state: "not-applicable" }),
      expect.objectContaining({ id: "virtualization.backup", state: "not-applicable" }),
    ]));
    expect(kit.evidence.controllerProtections).toEqual([expect.objectContaining({ backupId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restorePassed: true })]);
    expect(kit.runbookMarkdown).toContain("Protected controller snapshots: 1");
    const serialized = JSON.stringify(kit);
    expect(serialized).not.toContain("/secret/controller/boxpilot.sqlite3");
    store.close();
  });
});

describe("when the backup folder cannot be read", () => {
  it("says so, instead of reporting that no application has a backup", async () => {
    // Zero backups is an alarm the owner should act on; not knowing is not, and the two used to
    // look identical because a failed directory read returned an empty count map.
    const { owner, service, store } = await setup({ backups: [] });
    void owner;
    const kit = await service.inspect();
    const check = kit.checks.find((item) => item.id === "applications.backup");
    expect(check.state).toBe("action-required"); // the readable-but-empty case still warns
    store.close();

    const unreadable = await setup({ backups: [], countsAvailable: false });
    const blindKit = await unreadable.service.inspect();
    expect(blindKit.checks.find((item) => item.id === "applications.backup").state).toBe("unavailable");
    unreadable.store.close();
  });
});

// M91: app backups read "verified" as soon as each app had one archive, with every archive on the
// disk that would die. The copy off this server is a check of its own, judged as the Backups page
// judges it.
describe("the copy off this server", () => {
  const backedUp = [{ artifact: "uptime-kuma-20260816.tar.gz", sizeBytes: 1024, checksumSha256: "a".repeat(64), createdAt: "2026-08-16T03:00:00.000Z" }];
  const offBox = (kit) => kit.checks.find((item) => item.id === "offbox.copy");

  it("is action required when every backup is on this server only, even with every app backed up", async () => {
    const { service, store } = await setup({ backups: backedUp });
    const kit = await service.inspect();
    expect(kit.checks.find((item) => item.id === "applications.backup").state).toBe("verified");
    expect(offBox(kit)).toMatchObject({ state: "action-required", evidence: expect.stringContaining("on this server only") });
    expect(kit.summary.status).toBe("action-required");
    store.close();
  });

  it("is action required when a destination is saved and nothing has reached it", async () => {
    const { owner, service, store } = await setup({ backups: backedUp });
    store.setSetting("cloudDestination", { provider: "b2", bucket: "box" }, { updatedBy: owner.id });
    expect(offBox(await service.inspect())).toMatchObject({ state: "action-required", evidence: expect.stringContaining("nothing has been copied") });
    store.close();
  });

  it("is action required when the copy is behind the newest backup, and verified when it is not", async () => {
    const drive = (completedAt) => ({ ...noDrive, sync: { ...noDrive.sync, mount: { mounted: true }, lastSync: { completedAt, copiedCount: 3 } } });
    // The kit's clock is 2026-08-16T04:05Z; the store stamps backups at 04:00Z.
    const late = await setup({ backups: backedUp, drive: drive("2026-08-14T04:00:00.000Z") });
    const owner = late.owner;
    late.store.recordBackup({ id: "55555555-5555-4555-8555-555555555555", applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/x", checksumSha256: "e".repeat(64), sizeBytes: 1, downtimeMs: 0, restoreDrill: { passed: true }, createdBy: owner.id });
    const behindKit = await createRecoveryKitService({
      store: late.store,
      prerequisites: { inspect: vi.fn(async () => ({ checks: [] })) },
      helper: catalogHelper({ backups: backedUp, drive: drive("2026-08-14T04:00:00.000Z") }),
      libvirt: { listDomains: vi.fn(async () => ({ connected: true, domains: [] })) },
      now: () => new Date("2026-08-17T04:05:00.000Z"),
    }).inspect();
    expect(offBox(behindKit)).toMatchObject({ state: "action-required", evidence: expect.stringContaining("waiting 24 hours") });
    late.store.close();

    const fresh = await setup({ backups: backedUp, drive: drive("2026-08-16T04:01:00.000Z") });
    expect(offBox(await fresh.service.inspect())).toMatchObject({ state: "verified", evidence: expect.stringContaining("a backup drive") });
    fresh.store.close();
  });

  it("is unavailable, not 'only on this server', when the drive could not be read and nothing else is set up", async () => {
    const { service, store } = await setup({ backups: backedUp, drive: new Error("helper offline") });
    expect(offBox(await service.inspect()).state).toBe("unavailable");
    store.close();
  });
});

// M91: the steps could not be followed in order (the database came back from a restic repository
// BoxPilot cannot read, before the snapshot restore that stages the copy it needs), nothing said to
// keep the cloud passphrase, and nothing said how to open the sealed copies without BoxPilot.
describe("the rebuild the kit prints", () => {
  it("brings the backups back, restores the snapshot, then puts the staged database back, by a stated procedure", async () => {
    const { service, store } = await setup();
    const kit = await service.inspect();
    expect(kit.recoveryOrder.map((item) => item.title)).toEqual([
      "Get the server back", "Get back in privately", "Bring the backups back", "Restore the machine snapshot",
      "Put BoxPilot's database back", "Check each app's data", "Restore virtual machines", "Check it, then make a new kit",
    ]);
    const database = kit.recoveryOrder.find((item) => item.title === "Put BoxPilot's database back").instruction;
    expect(database).toContain("Backups, This server, Restore the database copy");
    expect(database).toContain("restored/<time>/controller/");
    expect(database).toMatch(/delete the -wal and -shm files/);
    expect(kit.recoveryOrder.some((item) => /encrypted repository/.test(item.instruction))).toBe(false);
    store.close();
  });

  // M91 review: the kit and docs/RECOVERY.md still said a snapshot restores the archive it lists, and to
  // restore a newer one by hand, after the default became each app's newest verified backup.
  it("says a snapshot restore takes each app's newest verified backup, falling back to the snapshot's own, as docs/RECOVERY.md does", async () => {
    const { service, store } = await setup();
    const kit = await service.inspect();
    const snapshot = kit.recoveryOrder.find((item) => item.title === "Restore the machine snapshot").instruction;
    expect(snapshot).toContain("newest verified backup on this server or the backup drive");
    expect(snapshot).toContain("falling back to the archive the snapshot lists");
    expect(snapshot).toContain("Use each app's newest backup");
    const check = kit.recoveryOrder.find((item) => item.title === "Check each app's data").instruction;
    expect(check).not.toMatch(/brings back the archive it lists/);
    const doc = await readFile(new URL("../docs/RECOVERY.md", import.meta.url), "utf8");
    expect(doc).not.toMatch(/newest archive the\s+snapshot lists/);
    expect(doc).not.toMatch(/brings back the archive it lists/);
    expect(doc).toMatch(/newest verified backup/);
    store.close();
  });

  it("tells the owner to keep the cloud passphrase somewhere else", async () => {
    const { service, store } = await setup();
    const kit = await service.inspect();
    expect(kit.externalItems.some((item) => /cloud copy's encryption passphrase/.test(item))).toBe(true);
    expect(kit.runbookMarkdown).toContain("encryption passphrase");
    store.close();
  });

  it("prints the crypt remote exactly as the mirror writes it, with the saved bucket and folder and no secret", async () => {
    const { owner, service, store } = await setup();
    const destination = { provider: "b2", account: "acct-id", bucket: "home-box", path: "boxpilot" };
    store.setSetting("cloudDestination", { ...destination, sealed: true }, { updatedBy: owner.id });
    const kit = await service.inspect();
    // What backup-cloud.mjs writes into rclone.conf, its crypt section, with the obscured passphrase.
    const written = renderRcloneConfig(destination, { key: "do-not-export-key", passphraseObscured: "do-not-export-obscured" });
    const sealed = written.split("\n").slice(written.split("\n").indexOf("[boxpilot-sealed]")).filter(Boolean);
    const printed = kit.cloudCopy.config.slice(kit.cloudCopy.config.indexOf("[boxpilot-sealed]"));
    expect(printed.map((line) => (line.startsWith("password = ") ? "password = …" : line)))
      .toEqual(sealed.map((line) => (line.startsWith("password = ") ? "password = …" : line)));
    expect(printed).toEqual(expect.arrayContaining(["type = crypt", "remote = boxpilot:home-box/boxpilot/sealed", "filename_encryption = off", "directory_name_encryption = false"]));
    expect(written).not.toContain("password2");
    expect(kit.cloudCopy.notes.join(" ")).toContain("Leave password2 out");
    expect(kit.runbookMarkdown).toContain("## Opening the cloud copy without BoxPilot");
    expect(kit.runbookMarkdown).toContain("remote = boxpilot:home-box/boxpilot/sealed");
    expect(JSON.stringify(kit)).not.toContain("do-not-export");
    store.close();
  });

  it("prints the same settings with placeholders when no cloud destination is saved", async () => {
    const { service, store } = await setup();
    const kit = await service.inspect();
    expect(kit.cloudCopy.configured).toBe(false);
    expect(kit.cloudCopy.config).toContain("remote = boxpilot:<bucket>/<folder>/sealed");
    store.close();
  });
});

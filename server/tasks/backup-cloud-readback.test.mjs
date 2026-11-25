import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupCloudFetch, backupCloudSetup, backupCloudSnapshots, backupCloudSync, backupCloudTest, configPath, revealObscured } from "./backup-cloud.mjs";
import { cloudSyncRecord, evaluateCloudReadBack, renderRcloneConfig, normalizeCloudDestination } from "../backup-cloud.mjs";
import { createHealthAlerts } from "../health-alerts.mjs";

/*
 * M91, "Restore from anywhere": the cloud copy was write-only. These drive rclone through the injected runner, so they
 * prove what BoxPilot asks rclone and what it does with the answers; what rclone itself does with a crypt remote is
 * not run here.
 */

const PASS = "orchard lantern river";
const rcloneKey = Buffer.from("9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638", "hex");
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function tempDir(prefix = "boxpilot-m91-") { const directory = await mkdtemp(path.join(os.tmpdir(), prefix)); directories.push(directory); return directory; }
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const artifact = "machine-snapshot-20261124T020000Z-1a2b3c4d.tar.gz";
const older = "machine-snapshot-20261117T020000Z-0a0b0c0d.tar.gz";

/** A real rclone obscure (AES-256-CTR under rclone's published key), so the saved passphrase can be read back. */
async function obscure(text) {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-ctr", rcloneKey, iv);
  return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final()]).toString("base64url");
}
const verbOf = (args) => args.find((arg) => ["obscure", "mkdir", "lsjson", "about", "copy", "copyto", "cat", "rcat", "hashsum"].includes(arg));

/** The passphrase the `--config` file an rclone call was handed would decrypt with. */
async function passphraseIn(args) {
  const at = args.indexOf("--config");
  if (at < 0) return null;
  const config = await readFile(args[at + 1], "utf8").catch(() => "");
  const sealed = config.split("[boxpilot-sealed]\n")[1] ?? "";
  return revealObscured(sealed.match(/^password = (.*)$/m)?.[1] ?? "");
}

/**
 * A fake rclone: `bucket` holds what the sealed remote would decrypt to, by path below boxpilot-sealed:. With
 * `sealedWith`, what is in the bucket opens only for a config whose passphrase is that one, as crypt's authenticated
 * blocks would (PLAUSIBLE: the error text is rclone's as reported, not run here).
 */
function fakeRclone({ bucket = {}, wrongPassphrase = false, hashOverride = null, sealedWith = null } = {}) {
  return vi.fn(async (_binary, args, options = {}) => {
    const verb = verbOf(args);
    const last = args[args.length - 1];
    if (verb === "obscure") return { ok: true, stdout: `${await obscure(options.input)}\n`, stderr: "" };
    if (sealedWith && ["cat", "copyto", "hashsum"].includes(verb)) {
      const key = (verb === "copyto" ? args[args.length - 2] : last).replace(/^boxpilot-sealed:/, "");
      if (!key.startsWith(".boxpilot-readback") && key in bucket && (await passphraseIn(args)) !== sealedWith) return { ok: false, stdout: "", stderr: "ERROR : failed to authenticate decrypted block - bad password?" };
    }
    if (verb === "rcat") { bucket[last.replace(/^boxpilot-sealed:/, "")] = options.input; return { ok: true, stdout: "", stderr: "" }; }
    if (verb === "cat") {
      const key = last.replace(/^boxpilot-sealed:/, "");
      if (wrongPassphrase && !key.startsWith(".boxpilot-readback")) return { ok: false, stdout: "", stderr: "ERROR : failed to authenticate decrypted block - bad password?" };
      return key in bucket ? { ok: true, stdout: String(bucket[key]).trim(), stderr: "" } : { ok: false, stdout: "", stderr: "object not found" };
    }
    if (verb === "lsjson" && last.startsWith("boxpilot-sealed:")) {
      const prefix = `${last.replace(/^boxpilot-sealed:/, "")}/`;
      const rows = Object.keys(bucket).filter((key) => key.startsWith(prefix)).map((key) => ({ Name: key.slice(prefix.length), Size: Buffer.byteLength(bucket[key]), ModTime: "2026-11-24T02:05:00Z" }));
      return rows.length ? { ok: true, stdout: JSON.stringify(rows), stderr: "" } : { ok: false, stdout: "", stderr: "error listing: directory not found" };
    }
    if (verb === "lsjson") return { ok: true, stdout: "[]", stderr: "" };
    if (verb === "about") return { ok: true, stdout: JSON.stringify({ free: 10 * 1024 ** 3 }), stderr: "" };
    if (verb === "copy") return { ok: true, stdout: "", stderr: "Errors:                 0\nTransferred:            1 / 1, 100%\n" };
    if (verb === "hashsum") {
      const key = last.replace(/^boxpilot-sealed:/, "");
      if (wrongPassphrase) return { ok: false, stdout: "", stderr: "failed to authenticate decrypted block - bad password?" };
      return key in bucket ? { ok: true, stdout: `${hashOverride ?? sha256(bucket[key])}  ${path.basename(key)}`, stderr: "" } : { ok: false, stdout: "", stderr: "object not found" };
    }
    if (verb === "copyto") {
      const key = args[args.length - 2].replace(/^boxpilot-sealed:/, "");
      if (!(key in bucket)) return { ok: false, stdout: "", stderr: "object not found" };
      await writeFile(last, bucket[key]);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
}

const b2 = { provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox" };
async function sealedSecrets(run) {
  const secretsDirectory = await tempDir();
  await backupCloudSetup({ ...b2, key: "K123", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
  return secretsDirectory;
}
/** A local snapshot store with one archive and its record. */
async function snapshotStore(name = artifact, bytes = "snapshot bytes") {
  const root = await tempDir("boxpilot-snapshots-");
  await writeFile(path.join(root, name), bytes);
  await writeFile(path.join(root, `${name}.meta.json`), JSON.stringify({ schemaVersion: 1, artifact: name, createdAt: "2026-11-24T02:00:00.000Z", sizeBytes: Buffer.byteLength(bytes), checksumSha256: sha256(bytes) }));
  return root;
}
const metaFor = (name, bytes) => JSON.stringify({ schemaVersion: 1, artifact: name, createdAt: "2026-11-24T02:00:00.000Z", sizeBytes: Buffer.byteLength(bytes), checksumSha256: sha256(bytes) });

describe("saving the cloud destination again with a secret left empty (M91)", () => {
  // Before: renaming the folder meant typing the application key and the passphrase (twice) again, and the task refused
  // a missing one, though it could read the saved passphrase. A slip in the retyped passphrase sealed new copies with one
  // nobody knew, or was refused for the folder.
  it("keeps the saved key and passphrase for the same account, and says which it kept", async () => {
    const run = fakeRclone();
    const secretsDirectory = await sealedSecrets(run);
    const first = await readFile(configPath(secretsDirectory), "utf8");
    const obscuredBefore = first.match(/^password = (.*)$/m)[1];
    const moved = await backupCloudSetup({ ...b2, path: "homebox-2027" }, { run, secretsDirectory, rclone: "/" });
    expect(moved.kept).toEqual(["key", "passphrase"]);
    const config = await readFile(configPath(secretsDirectory), "utf8");
    expect(config).toContain("key = K123");
    expect(config).toContain("remote = boxpilot:home-backups/homebox-2027/sealed");
    // The saved obscured line is carried over as it was: the passphrase never went through a process again.
    expect(config.match(/^password = (.*)$/m)[1]).toBe(obscuredBefore);
    expect(revealObscured(obscuredBefore)).toBe(PASS);
    expect(run.mock.calls.filter(([, args]) => args[0] === "obscure")).toHaveLength(1);
    // Rotating only the key keeps the passphrase too.
    const rotated = await backupCloudSetup({ ...b2, path: "homebox-2027", key: "K456" }, { run, secretsDirectory, rclone: "/" });
    expect(rotated.kept).toEqual(["passphrase"]);
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("key = K456");
  });

  it("still refuses a new passphrase for a folder that already holds sealed copies", async () => {
    const run = fakeRclone();
    const secretsDirectory = await sealedSecrets(run);
    await expect(backupCloudSetup({ ...b2, passphrase: "a different passphrase" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("were sealed with the passphrase you set before");
  });

  it("asks for the secret again when it belongs to another account or another provider", async () => {
    const run = fakeRclone();
    const secretsDirectory = await sealedSecrets(run);
    await expect(backupCloudSetup({ ...b2, account: "0099xyz" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("The application key is required (the saved one belongs to the account you changed)");
    await expect(backupCloudSetup({ provider: "s3", bucket: "bkt", region: "us-east-1", accessKeyId: "AK" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("The secret access key is required");
    // The passphrase is the owner's, not the provider's: a new provider with its own key keeps it.
    const s3 = await backupCloudSetup({ provider: "s3", bucket: "bkt", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, { run, secretsDirectory, rclone: "/" });
    expect(s3.kept).toEqual(["passphrase"]);
  });

  it("keeps a WebDAV password and a token as saved, obscured or not", async () => {
    const run = fakeRclone();
    const secretsDirectory = await tempDir();
    const webdav = { provider: "webdav", url: "https://cloud.example.com/remote.php/dav/files/me/", user: "me", path: "boxpilot" };
    await backupCloudSetup({ ...webdav, password: "p w", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    const pass = (await readFile(configPath(secretsDirectory), "utf8")).match(/^pass = (.*)$/m)[1];
    expect(revealObscured(pass)).toBe("p w");
    expect((await backupCloudSetup({ ...webdav, path: "elsewhere" }, { run, secretsDirectory, rclone: "/" })).kept).toEqual(["password", "passphrase"]);
    expect((await readFile(configPath(secretsDirectory), "utf8")).match(/^pass = (.*)$/m)[1]).toBe(pass);
    await expect(backupCloudSetup({ ...webdav, user: "someone" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("The password is required");

    const token = "{\"access_token\":\"x\"}";
    await backupCloudSetup({ provider: "dropbox", path: "boxpilot", token }, { run, secretsDirectory, rclone: "/" });
    expect((await backupCloudSetup({ provider: "dropbox", path: "other" }, { run, secretsDirectory, rclone: "/" })).kept).toEqual(["token", "passphrase"]);
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain(`token = ${token}`);
  });

  it("asks for a passphrase when none was saved, or the saved one cannot be read back", async () => {
    const run = fakeRclone();
    const fresh = await tempDir();
    await expect(backupCloudSetup({ ...b2, key: "K" }, { run, secretsDirectory: fresh, rclone: "/" })).rejects.toThrow("encryption passphrase of at least 12");
    const plain = await tempDir();
    await writeFile(configPath(plain), renderRcloneConfig(normalizeCloudDestination(b2), { key: "K" }));
    await expect(backupCloudSetup(b2, { run, secretsDirectory: plain, rclone: "/" })).rejects.toThrow("encryption passphrase of at least 12");
    const garbled = await sealedSecrets(run);
    await writeFile(configPath(garbled), (await readFile(configPath(garbled), "utf8")).replace(/^password = .*$/m, "password = not obscured"));
    await expect(backupCloudSetup({ ...b2, path: "new-folder" }, { run, secretsDirectory: garbled, rclone: "/" })).rejects.toThrow("encryption passphrase of at least 12");
  });
});

describe("testing the destination through the encrypted remote (M91)", () => {
  // Before: mkdir and lsjson ran on the plain remote only, so a wrong passphrase or broken crypt settings passed.
  it("writes a marker through the sealed remote and reads it back, and opens the newest snapshot already there", async () => {
    const bucket = { [`machine-snapshots/${artifact}`]: "snapshot bytes", [`machine-snapshots/${artifact}.meta.json`]: metaFor(artifact, "snapshot bytes") };
    const run = fakeRclone({ bucket });
    const secretsDirectory = await sealedSecrets(run);
    const tested = await backupCloudTest(b2, { run, secretsDirectory, rclone: "/", randomToken: () => "token-1" });
    expect(tested).toMatchObject({ reachable: true, sealed: true, sealedRoundTrip: true, existingCopiesReadable: true, newestSnapshot: artifact });
    const verbs = run.mock.calls.map(([, args]) => `${verbOf(args)} ${args[args.length - 1]}`);
    expect(verbs).toContain("rcat boxpilot-sealed:.boxpilot-readback");
    expect(verbs).toContain("cat boxpilot-sealed:.boxpilot-readback");
    expect(verbs).toContain(`cat boxpilot-sealed:machine-snapshots/${artifact}.meta.json`);
    // The marker goes on stdin, like every secret here.
    expect(run.mock.calls.find(([, args]) => args.includes("rcat"))[2].input).toBe("token-1");
  });

  it("fails when the saved passphrase does not open the copies already in the bucket", async () => {
    const bucket = { [`machine-snapshots/${artifact}`]: "x", [`machine-snapshots/${artifact}.meta.json`]: metaFor(artifact, "x") };
    const secretsDirectory = await sealedSecrets(fakeRclone());
    await expect(backupCloudTest(b2, { run: fakeRclone({ bucket, wrongPassphrase: true }), secretsDirectory, rclone: "/" })).rejects.toThrow("do not open with the saved passphrase");
  });

  it("fails when what was written through the encrypted remote reads back different", async () => {
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const run = vi.fn(async (_binary, args) => (args.includes("cat") ? { ok: true, stdout: "something else", stderr: "" } : { ok: true, stdout: "[]", stderr: "" }));
    await expect(backupCloudTest(b2, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("did not read back the same");
  });

  it("checks only the round trip while the bucket holds no snapshot yet", async () => {
    const run = fakeRclone();
    const secretsDirectory = await sealedSecrets(run);
    expect(await backupCloudTest(b2, { run, secretsDirectory, rclone: "/" })).toMatchObject({ sealedRoundTrip: true, existingCopiesReadable: null, newestSnapshot: null });
  });
});

describe("reading the newest snapshot back after each mirror (M91)", () => {
  // Before: the sync returned checksumVerified: false and nothing ever read a copy back.
  it("downloads and decrypts the newest machine snapshot and compares it with the one here", async () => {
    const bucket = { [`machine-snapshots/${artifact}`]: "snapshot bytes", [`machine-snapshots/${artifact}.meta.json`]: metaFor(artifact, "snapshot bytes") };
    const run = fakeRclone({ bucket });
    const secretsDirectory = await sealedSecrets(run);
    const root = await snapshotStore();
    await writeFile(path.join(root, older), "old");
    await writeFile(path.join(root, `${older}.meta.json`), metaFor(older, "old"));
    const synced = await backupCloudSync(b2, { run, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }], now: () => new Date("2026-11-24T03:00:00Z") });
    expect(synced.readBack).toEqual({ ok: true, verifiedAt: "2026-11-24T03:00:00.000Z", artifact, checksumSha256: sha256("snapshot bytes"), uploadedThisRun: false });
    expect(synced.boundary.readBackVerified).toBe(true);
    expect(synced.warnings).toBeUndefined();
    const hashCall = run.mock.calls.find(([, args]) => args.includes("hashsum"));
    expect(hashCall[1]).toEqual(expect.arrayContaining(["hashsum", "sha256", "--download", `boxpilot-sealed:machine-snapshots/${artifact}`]));
  });

  it("warns, and still reports the mirror, when the copy does not read back", async () => {
    const root = await snapshotStore();
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const bucket = { [`machine-snapshots/${artifact}`]: "snapshot bytes", [`machine-snapshots/${artifact}.meta.json`]: metaFor(artifact, "snapshot bytes") };
    // The record opens (it is checked before copying), the archive does not download.
    const broken = fakeRclone({ bucket });
    const run = vi.fn(async (binary, args, options) => (args.includes("hashsum") ? { ok: false, stdout: "", stderr: "failed to authenticate decrypted block - bad password?" } : broken(binary, args, options)));
    const wrong = await backupCloudSync(b2, { run, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }], now: () => new Date("2026-11-24T03:00:00Z") });
    expect(wrong).toMatchObject({ synced: true, readBack: { ok: false, artifact }, boundary: { readBackVerified: false } });
    expect(wrong.readBack.error).toContain("bad password");
    expect(wrong.warnings[0]).toContain("could not be read back");
    const damaged = await backupCloudSync(b2, { run: fakeRclone({ bucket, hashOverride: "f".repeat(64) }), secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }] });
    expect(damaged.readBack).toMatchObject({ ok: false, error: "the archive in the bucket decrypts to different bytes from the one here" });
  });

  it("says there was nothing to read back when no machine snapshot was mirrored", async () => {
    const run = fakeRclone();
    const secretsDirectory = await sealedSecrets(run);
    const synced = await backupCloudSync(b2, { run, secretsDirectory, rclone: "/", sources: [{ name: "controller-backups", root: secretsDirectory }] });
    expect(synced.readBack).toMatchObject({ ok: null, artifact: null });
    expect(run.mock.calls.some(([, args]) => args.includes("hashsum"))).toBe(false);
  });

  it("keeps the last good read-back through a failure, and raises a health alert until one reads back again", async () => {
    const good = cloudSyncRecord({ completedAt: "2026-11-23T03:00:00.000Z", filesTransferred: 2, bytesTransferred: "1 MiB", destination: "d", errors: 0, readBack: { ok: true, verifiedAt: "2026-11-23T03:10:00.000Z", artifact } }, null);
    expect(good.readBack).toMatchObject({ ok: true, at: "2026-11-23T03:10:00.000Z", lastVerifiedAt: "2026-11-23T03:10:00.000Z" });
    expect(evaluateCloudReadBack(good)).toEqual([]);
    const bad = cloudSyncRecord({ completedAt: "2026-11-24T03:00:00.000Z", filesTransferred: 0, bytesTransferred: null, destination: "d", readBack: { ok: false, checkedAt: "2026-11-24T03:05:00.000Z", artifact, error: "bad password?" } }, good);
    expect(bad.readBack).toMatchObject({ ok: false, error: "bad password?", lastVerifiedAt: "2026-11-23T03:10:00.000Z" });
    const [alert] = evaluateCloudReadBack(bad);
    expect(alert).toMatchObject({ key: "backup.cloud.unreadable", priority: "high", title: "The cloud copy could not be read back" });
    expect(alert.message).toContain("2026-11-23");

    const settings = new Map([["cloudDestinationLastSync", bad]]);
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn(), listSchedules: () => [] };
    const send = vi.fn(async () => ({}));
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => ({ kind: "ntfy" }), send }, store, now: () => new Date("2026-11-24T04:00:00Z") });
    expect((await alerts.check()).active).toContain("backup.cloud.unreadable");
    settings.set("cloudDestinationLastSync", cloudSyncRecord({ completedAt: "2026-11-25T03:00:00.000Z", readBack: { ok: true, verifiedAt: "2026-11-25T03:10:00.000Z", artifact } }, bad));
    const after = await alerts.check();
    expect(after.active).not.toContain("backup.cloud.unreadable");
    expect(after.sent).toContain("resolved:backup.cloud.unreadable");
  });
});

describe("the machine snapshots in the cloud, and fetching one (M91)", () => {
  const bytes = "the archive the old server wrote";
  const bucketWith = () => ({
    [`machine-snapshots/${artifact}`]: bytes, [`machine-snapshots/${artifact}.meta.json`]: metaFor(artifact, bytes),
    [`machine-snapshots/${older}`]: "old", "machine-snapshots/notes.txt": "not a snapshot",
  });

  it("lists them newest first, with whether each has its record and is already here", async () => {
    const run = fakeRclone({ bucket: bucketWith() });
    const secretsDirectory = await sealedSecrets(run);
    const snapshotRoot = await tempDir();
    await writeFile(path.join(snapshotRoot, older), "old");
    const listed = await backupCloudSnapshots({}, { run, secretsDirectory, rclone: "/", snapshotRoot });
    expect(listed).toEqual({ total: 2, snapshots: [
      { artifact, sizeBytes: Buffer.byteLength(bytes), modifiedAt: "2026-11-24T02:05:00Z", hasMeta: true, local: false },
      { artifact: older, sizeBytes: 3, modifiedAt: "2026-11-24T02:05:00Z", hasMeta: false, local: true },
    ] });
    expect(run.mock.calls.find(([, args]) => args.includes("lsjson"))[1]).toEqual(expect.arrayContaining(["lsjson", "--files-only", "boxpilot-sealed:machine-snapshots"]));
    // Nothing mirrored yet is an empty list, not a failure.
    expect(await backupCloudSnapshots({}, { run: fakeRclone(), secretsDirectory, rclone: "/", snapshotRoot })).toEqual({ total: 0, snapshots: [] });
    const refused = vi.fn(async () => ({ ok: false, stdout: "", stderr: "AccessDenied: 403" }));
    await expect(backupCloudSnapshots({}, { run: refused, secretsDirectory, rclone: "/", snapshotRoot })).rejects.toThrow("Could not list the encrypted copies: AccessDenied");
  });

  it("fetches one into the local store, checked against its sealed record, beside the record the restore reads", async () => {
    const run = fakeRclone({ bucket: bucketWith() });
    const secretsDirectory = await sealedSecrets(run);
    const snapshotRoot = path.join(await tempDir(), "machine-snapshots");
    const fetched = await backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot });
    expect(fetched).toMatchObject({ fetched: true, artifact, verified: true, sizeBytes: Buffer.byteLength(bytes), checksumSha256: sha256(bytes) });
    expect(await readFile(path.join(snapshotRoot, artifact), "utf8")).toBe(bytes);
    expect(JSON.parse(await readFile(path.join(snapshotRoot, `${artifact}.meta.json`), "utf8")).checksumSha256).toBe(sha256(bytes));
    await expect(stat(path.join(snapshotRoot, `${artifact}.partial`))).rejects.toThrow();
    // Never over one already here: run again, it keeps it and downloads nothing for it.
    await writeFile(path.join(snapshotRoot, artifact), "kept as it is");
    const again = await backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot });
    expect(again).toMatchObject({ fetched: false, snapshot: "here", apps: [] });
    expect(await readFile(path.join(snapshotRoot, artifact), "utf8")).toBe("kept as it is");
    expect(run.mock.calls.filter(([, args]) => args.includes("copyto"))).toHaveLength(1);
  });

  it("discards a download that does not match its record, and refuses one without a record", async () => {
    const bucket = bucketWith();
    bucket[`machine-snapshots/${artifact}`] = "tampered or damaged";
    const run = fakeRclone({ bucket });
    const secretsDirectory = await sealedSecrets(run);
    const snapshotRoot = await tempDir();
    await expect(backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot })).rejects.toThrow("does not match the checksum its record names");
    await expect(stat(path.join(snapshotRoot, artifact))).rejects.toThrow();
    await expect(stat(path.join(snapshotRoot, `${artifact}.partial`))).rejects.toThrow();
    await expect(stat(path.join(snapshotRoot, `${artifact}.meta.json`))).rejects.toThrow();
    await expect(backupCloudFetch({ artifact: older }, { run, secretsDirectory, rclone: "/", snapshotRoot })).rejects.toThrow("could not be read from the bucket");
    expect(run.mock.calls.some(([, args]) => args.includes("copyto") && args.includes(`boxpilot-sealed:machine-snapshots/${older}`))).toBe(false);
  });

  it("refuses a name that is not a snapshot's, no room for it, or a destination saved without a passphrase", async () => {
    const run = fakeRclone({ bucket: bucketWith() });
    const secretsDirectory = await sealedSecrets(run);
    const snapshotRoot = await tempDir();
    for (const name of ["../etc/passwd", "machine-snapshot-x.tar.gz", `${artifact}/../../x`]) await expect(backupCloudFetch({ artifact: name }, { run, secretsDirectory, rclone: "/", snapshotRoot })).rejects.toThrow("Name a machine snapshot");
    await expect(backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot, freeBytesOf: async () => 1024 })).rejects.toThrow("Nothing was fetched");
    const plain = await tempDir();
    await mkdir(plain, { recursive: true });
    await writeFile(configPath(plain), renderRcloneConfig(normalizeCloudDestination(b2), { key: "K" }));
    await expect(backupCloudFetch({ artifact }, { run, secretsDirectory: plain, rclone: "/", snapshotRoot })).rejects.toThrow("without an encryption passphrase");
    await expect(backupCloudSnapshots({}, { run, secretsDirectory: plain, rclone: "/", snapshotRoot })).rejects.toThrow("without an encryption passphrase");
  });
});

describe("a passphrase that does not open the copies already in the folder (M91, outside review)", () => {
  // Before: the guard needed a saved configuration, which a rebuilt server does not have, so setup took any passphrase;
  // the sync (--size-only) left every name already there as it was, sealed the new ones under the new passphrase, and
  // the read-back read back what it had just uploaded and recorded success.
  const sealedBucket = () => ({ [`machine-snapshots/${older}`]: "old server", [`machine-snapshots/${older}.meta.json`]: metaFor(older, "old server") });

  it("refuses it when a rebuilt server, with nothing saved, sets the destination up, and saves nothing", async () => {
    const run = fakeRclone({ bucket: sealedBucket(), sealedWith: PASS });
    const secretsDirectory = await tempDir();
    await expect(backupCloudSetup({ ...b2, key: "K123", passphrase: "not the one used before" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("This folder holds copies sealed with a different passphrase");
    await expect(stat(configPath(secretsDirectory))).rejects.toThrow();
    await expect(stat(`${configPath(secretsDirectory)}.checking`)).rejects.toThrow();
    // The one they were sealed with is taken, and the record was opened with the configuration about to be saved.
    await backupCloudSetup({ ...b2, key: "K123", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    expect(revealObscured((await readFile(configPath(secretsDirectory), "utf8")).match(/^password = (.*)$/m)[1])).toBe(PASS);
    const opened = run.mock.calls.filter(([, args]) => args.includes("cat") && args[args.length - 1] === `boxpilot-sealed:machine-snapshots/${older}.meta.json`);
    expect(opened.at(-1)[1][opened.at(-1)[1].indexOf("--config") + 1]).toBe(`${configPath(secretsDirectory)}.checking`);
  });

  it("refuses it when a saved destination is pointed at another folder holding copies sealed with another passphrase", async () => {
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const run = fakeRclone({ bucket: sealedBucket(), sealedWith: "the other server's passphrase" });
    await expect(backupCloudSetup({ ...b2, path: "other-server" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("sealed with a different passphrase");
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("remote = boxpilot:home-backups/homebox/sealed");
  });

  it("takes any passphrase for an empty folder, or one with no snapshot record, and refuses when the folder cannot be listed", async () => {
    const empty = await tempDir();
    await backupCloudSetup({ ...b2, key: "K", passphrase: "a brand new passphrase" }, { run: fakeRclone({ sealedWith: PASS }), secretsDirectory: empty, rclone: "/" });
    const noRecords = await tempDir();
    const bucket = { [`machine-snapshots/${older}`]: "no record beside it", "application-backups/immich/20261123T020000Z.tar.gz": "data" };
    await backupCloudSetup({ ...b2, key: "K", passphrase: "a brand new passphrase" }, { run: fakeRclone({ bucket, sealedWith: PASS }), secretsDirectory: noRecords, rclone: "/" });
    const unreachable = await tempDir();
    const refused = vi.fn(async (_binary, args, options) => (args.includes("lsjson") ? { ok: false, stdout: "", stderr: "AccessDenied: 403" } : fakeRclone()(_binary, args, options)));
    await expect(backupCloudSetup({ ...b2, key: "K", passphrase: PASS }, { run: refused, secretsDirectory: unreachable, rclone: "/" })).rejects.toThrow("Could not list the copies already in the folder to check the passphrase: AccessDenied: 403. Nothing was saved.");
    await expect(stat(configPath(unreachable))).rejects.toThrow();
  });

  it("does not ask the bucket again when the folder and passphrase are the ones already saved", async () => {
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const run = fakeRclone({ bucket: sealedBucket() });
    await backupCloudSetup({ ...b2, key: "K456" }, { run, secretsDirectory, rclone: "/" });
    expect(run.mock.calls.some(([, args]) => args.includes("lsjson") || args.includes("cat"))).toBe(false);
  });

  it("copies nothing when the copies already there do not open with the saved passphrase", async () => {
    // A configuration saved before this check, with another passphrase, as a rebuilt server's was.
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const root = await snapshotStore();
    const run = fakeRclone({ bucket: sealedBucket(), sealedWith: "the old server's passphrase" });
    await expect(backupCloudSync(b2, { run, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }] })).rejects.toThrow("This folder holds copies sealed with a different passphrase");
    await expect(backupCloudSync(b2, { run, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }] })).rejects.toThrow("Nothing was copied.");
    expect(run.mock.calls.some(([, args]) => args.includes("copy"))).toBe(false);
  });

  it("opens a copy already there before copying, and says whether the copy it read back was one this mirror uploaded", async () => {
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const root = await snapshotStore();
    const bucket = sealedBucket();
    const sealedRun = fakeRclone({ bucket, sealedWith: PASS });
    // The mirror uploads tonight's snapshot (the fake copy does not, so it is put there as rclone would).
    const run = vi.fn(async (binary, args, options) => {
      if (args.includes("copy")) { bucket[`machine-snapshots/${artifact}`] = "snapshot bytes"; bucket[`machine-snapshots/${artifact}.meta.json`] = metaFor(artifact, "snapshot bytes"); }
      return sealedRun(binary, args, options);
    });
    const synced = await backupCloudSync(b2, { run, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }], now: () => new Date("2026-11-24T03:00:00Z") });
    expect(synced.existingCopy).toEqual({ artifact: older, opened: true });
    expect(synced.readBack).toMatchObject({ ok: true, artifact, uploadedThisRun: true });
    const verbs = run.mock.calls.map(([, args]) => verbOf(args));
    expect(verbs.indexOf("cat")).toBeLessThan(verbs.indexOf("copy"));
    // An empty bucket: nothing to open first, and the read-back says it proved this mirror's own upload.
    const fresh = {};
    const firstRun = vi.fn(async (binary, args, options) => {
      if (args.includes("copy")) { fresh[`machine-snapshots/${artifact}`] = "snapshot bytes"; fresh[`machine-snapshots/${artifact}.meta.json`] = metaFor(artifact, "snapshot bytes"); }
      return fakeRclone({ bucket: fresh })(binary, args, options);
    });
    const first = await backupCloudSync(b2, { run: firstRun, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root }] });
    expect(first.existingCopy).toBeNull();
    expect(first.readBack).toMatchObject({ ok: true, uploadedThisRun: true });
  });
});

describe("fetching a snapshot brings each app's newest backup with it (M91, outside review)", () => {
  // Before: only the snapshot came down. Its restore looks for app data on this server, the mirror and the snapshot's
  // drive, so with the cloud the only copy left, every app was reinstalled empty.
  const snapshotBytes = "the archive the old server wrote";
  const apps = [{ id: "immich", installed: true, backups: 3 }, { id: "pihole", installed: true, backups: 1 }, { id: "vaultwarden", installed: true, backups: 1 }, { id: "gone", installed: false, backups: 0 }, { id: "nextcloud", installed: true, backups: 1 }, { id: "../etc", installed: true }];
  const snapshotMeta = JSON.stringify({ schemaVersion: 1, artifact, createdAt: "2026-11-24T02:00:00.000Z", sizeBytes: Buffer.byteLength(snapshotBytes), checksumSha256: sha256(snapshotBytes), contents: { apps } });
  const appRecord = (id, name, bytes, extra = {}) => JSON.stringify({ id, artifact: name, createdAt: "2026-11-23T02:00:00.000Z", sizeBytes: Buffer.byteLength(bytes), checksumSha256: sha256(bytes), ...extra });
  const bucketWith = () => ({
    [`machine-snapshots/${artifact}`]: snapshotBytes, [`machine-snapshots/${artifact}.meta.json`]: snapshotMeta,
    // immich: newer than the snapshot are an earlier release's record (cannot say what it is), a backup of the app a
    // restore installed empty, and a restore's safety copy; the restore takes none of them, so the nightly before the
    // snapshot is the one, and an older one is left.
    "application-backups/immich/20261125T020000Z.tar.gz": "unknown", "application-backups/immich/20261125T020000Z.json": appRecord("immich", "20261125T020000Z.tar.gz", "unknown"),
    "application-backups/immich/20261124T120000Z.tar.gz": "installed empty", "application-backups/immich/20261124T120000Z.json": appRecord("immich", "20261124T120000Z.tar.gz", "installed empty", { recordVersion: 2, snapshotRestore: { snapshot: artifact, installedAt: "2026-11-24T11:00:00.000Z", dataFrom: null } }),
    "application-backups/immich/20261124T030000Z.tar.gz": "empty app", "application-backups/immich/20261124T030000Z.json": appRecord("immich", "20261124T030000Z.tar.gz", "empty app", { recordVersion: 2, safetyCopy: { reason: "restore" } }),
    // nextcloud: a nightly after the snapshot, with this release's record, is its data.
    "application-backups/nextcloud/20261125T020000Z.tar.gz": "files", "application-backups/nextcloud/20261125T020000Z.json": appRecord("nextcloud", "20261125T020000Z.tar.gz", "files", { recordVersion: 2 }),
    "application-backups/immich/20261123T020000Z.tar.gz": "photos", "application-backups/immich/20261123T020000Z.json": appRecord("immich", "20261123T020000Z.tar.gz", "photos"),
    "application-backups/immich/20261120T020000Z.tar.gz": "older photos", "application-backups/immich/20261120T020000Z.json": appRecord("immich", "20261120T020000Z.tar.gz", "older photos"),
    // pihole: an archive with no record cannot be checked, so it is not trusted.
    "application-backups/pihole/20261123T020000Z.tar.gz": "lists",
    // vaultwarden: its record names a checksum the archive does not match.
    "application-backups/vaultwarden/20261123T020000Z.tar.gz": "tampered", "application-backups/vaultwarden/20261123T020000Z.json": appRecord("vaultwarden", "20261123T020000Z.tar.gz", "vault"),
  });
  async function stores() {
    const base = await tempDir();
    return { snapshotRoot: path.join(base, "machine-snapshots"), applicationBackupRoot: path.join(base, "backups", "catalog") };
  }

  it("fetches each app's newest backup that has a record, checked against it, and says per app what came down or why not", async () => {
    const run = fakeRclone({ bucket: bucketWith(), sealedWith: PASS });
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const { snapshotRoot, applicationBackupRoot } = await stores();
    const fetched = await backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot, applicationBackupRoot });
    expect(fetched).toMatchObject({ fetched: true, snapshot: "fetched", appsFetched: 2 });
    expect(await readFile(path.join(snapshotRoot, artifact), "utf8")).toBe(snapshotBytes);
    const immich = path.join(applicationBackupRoot, "immich");
    expect(await readFile(path.join(immich, "20261123T020000Z.tar.gz"), "utf8")).toBe("photos");
    // Beside its record, which the restore needs to trust it.
    expect(JSON.parse(await readFile(path.join(immich, "20261123T020000Z.json"), "utf8")).checksumSha256).toBe(sha256("photos"));
    for (const passed of ["20261125T020000Z", "20261124T120000Z", "20261124T030000Z"]) await expect(stat(path.join(immich, `${passed}.tar.gz`))).rejects.toThrow();
    expect(await readFile(path.join(applicationBackupRoot, "nextcloud", "20261125T020000Z.tar.gz"), "utf8")).toBe("files");
    await expect(stat(path.join(immich, "20261120T020000Z.tar.gz"))).rejects.toThrow();
    await expect(stat(path.join(immich, "20261123T020000Z.tar.gz.partial"))).rejects.toThrow();
    expect(fetched.apps).toEqual([
      { id: "immich", status: "fetched", archive: "20261123T020000Z.tar.gz", sizeBytes: 6, checksumSha256: sha256("photos"), reason: null },
      { id: "pihole", status: "none", archive: null, reason: "Its backups in the bucket have no record with a checksum, so none could be checked." },
      { id: "vaultwarden", status: "failed", archive: "20261123T020000Z.tar.gz", reason: "20261123T020000Z.tar.gz: it came down, but it does not match the checksum its record names, so it was discarded" },
      { id: "gone", status: "none", archive: null, reason: "No backup of it is in the bucket." },
      { id: "nextcloud", status: "fetched", archive: "20261125T020000Z.tar.gz", sizeBytes: 5, checksumSha256: sha256("files"), reason: null },
    ]);
    await expect(stat(path.join(applicationBackupRoot, "vaultwarden", "20261123T020000Z.tar.gz"))).rejects.toThrow();
    await expect(stat(path.join(applicationBackupRoot, "vaultwarden", "20261123T020000Z.json"))).rejects.toThrow();
    expect(fetched.warnings).toEqual([expect.stringContaining("vaultwarden: 20261123T020000Z.tar.gz: it came down, but it does not match")]);
    // An id that is not an app folder's name is never asked for.
    expect(run.mock.calls.some(([, args]) => args.some((arg) => String(arg).includes("../etc")))).toBe(false);
  });

  it("run again, keeps the snapshot and what is already here, and fetches only what is missing", async () => {
    const bucket = bucketWith();
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const { snapshotRoot, applicationBackupRoot } = await stores();
    await backupCloudFetch({ artifact }, { run: fakeRclone({ bucket }), secretsDirectory, rclone: "/", snapshotRoot, applicationBackupRoot });
    bucket["application-backups/vaultwarden/20261123T020000Z.tar.gz"] = "vault";
    const run = fakeRclone({ bucket });
    const again = await backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot, applicationBackupRoot });
    expect(again).toMatchObject({ fetched: true, snapshot: "here", appsFetched: 1 });
    expect(again.apps.find((app) => app.id === "nextcloud")).toMatchObject({ status: "here" });
    expect(again.apps.find((app) => app.id === "immich")).toMatchObject({ status: "here", archive: "20261123T020000Z.tar.gz" });
    expect(again.apps.find((app) => app.id === "vaultwarden")).toMatchObject({ status: "fetched" });
    const copied = run.mock.calls.filter(([, args]) => args.includes("copyto")).map(([, args]) => args[args.length - 2]);
    expect(copied).toEqual(["boxpilot-sealed:application-backups/vaultwarden/20261123T020000Z.tar.gz"]);
  });

  it("fetches nothing when the snapshot and the app backups together do not fit", async () => {
    const secretsDirectory = await sealedSecrets(fakeRclone());
    const { snapshotRoot, applicationBackupRoot } = await stores();
    const run = fakeRclone({ bucket: bucketWith() });
    // Room for the snapshot alone, with the margin, and not for the apps' backups as well.
    const freeBytesOf = async () => 256 * 1024 ** 2 + Buffer.byteLength(snapshotBytes) + 1;
    await expect(backupCloudFetch({ artifact }, { run, secretsDirectory, rclone: "/", snapshotRoot, applicationBackupRoot, freeBytesOf })).rejects.toThrow(`${artifact} and the newest backup of 3 app(s) need`);
    expect(run.mock.calls.some(([, args]) => args.includes("copyto"))).toBe(false);
    await expect(stat(path.join(snapshotRoot, artifact))).rejects.toThrow();
  });
});

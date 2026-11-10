import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { backupCloudSetup, backupCloudSync, backupCloudTest, configPath, revealObscured } from "./backup-cloud.mjs";
import { cloudTarget, isSealedConfig, normalizeCloudDestination, parseRcloneStats, renderRcloneConfig, validateCloudDestination } from "../backup-cloud.mjs";

const PASS = "orchard lantern river";
// rclone obscure answers on stdout; every other call succeeds quietly.
const withObscure = (other = async () => ({ ok: true, stdout: "", stderr: "" })) => vi.fn(async (binary, args, options) => (args[0] === "obscure" ? { ok: true, stdout: `obscured(${options.input})\n`, stderr: "" } : other(binary, args, options)));

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function secretsDir() { const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-rclone-")); directories.push(directory); return directory; }

describe("cloud destination model", () => {
  it("validates per provider and renders rclone sections", () => {
    expect(validateCloudDestination({ provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox" })).toEqual([]);
    expect(validateCloudDestination({ provider: "s3", bucket: "bkt", accessKeyId: "AKIA" })).toContain("set a region (AWS) or an endpoint (other S3 services)");
    expect(validateCloudDestination({ provider: "s3", bucket: "Bad Bucket", region: "us-east-1", accessKeyId: "AKIA" })).toContain("bucket is invalid");
    expect(validateCloudDestination({ provider: "ftp" })[0]).toContain("provider must be one of");
    expect(validateCloudDestination({ provider: "webdav", url: "http://insecure", user: "u" })).toContain("url is invalid");
    const b2 = normalizeCloudDestination({ provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox/" });
    expect(b2).toEqual({ provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox" });
    expect(cloudTarget(b2)).toBe("boxpilot:home-backups/homebox");
    expect(cloudTarget(normalizeCloudDestination({ provider: "drive" }))).toBe("boxpilot:boxpilot");
    expect(renderRcloneConfig(b2, { key: "K" })).toBe("# Managed by BoxPilot\n[boxpilot]\ntype = b2\naccount = 0012abc\nkey = K\nno_check_bucket = true\n");
    expect(renderRcloneConfig(normalizeCloudDestination({ provider: "s3", bucket: "bkt", endpoint: "https://s3.wasabisys.com", accessKeyId: "AK" }), { secretAccessKey: "SK" })).toContain("provider = Other\naccess_key_id = AK\nsecret_access_key = SK\nendpoint = https://s3.wasabisys.com");
    expect(renderRcloneConfig(normalizeCloudDestination({ provider: "dropbox", path: "backups" }), { token: "{\"access_token\":\"x\"}" })).toContain("type = dropbox\ntoken = {\"access_token\":\"x\"}");
    expect(parseRcloneStats("Transferred:   \t  12.345 MiB / 12.345 MiB, 100%, 1.2 MiB/s, ETA 0s\nErrors:                 0\nChecks:                 3 / 3, 100%\nTransferred:            2 / 2, 100%\n")).toEqual({ filesTransferred: 2, filesTotal: 2, bytesTransferred: "12.345 MiB", errors: 0 });
  });
});

// What rclone obscure really does (fs/config/obscure): AES-256-CTR under its published key, a fresh IV in front.
const rcloneKey = Buffer.from("9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638", "hex");
function obscure(text, iv = randomBytes(16)) { const cipher = createCipheriv("aes-256-ctr", rcloneKey, iv); return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final()]).toString("base64url"); }
const withRealObscure = () => vi.fn(async (_binary, args, options) => (args[0] === "obscure" ? { ok: true, stdout: `${obscure(options.input)}\n`, stderr: "" } : { ok: true, stdout: "", stderr: "" }));

describe("the passphrase a sealed folder keeps", () => {
  it("reads back what rclone obscure wrote, and nothing from a value that is not one", () => {
    // rclone's own test vector (obscure_test.go): "potato" under an IV of sixteen "a".
    expect(obscure("potato", Buffer.from("aaaaaaaaaaaaaaaa"))).toBe("YWFhYWFhYWFhYWFhYWFhYXMaGgIlEQ");
    expect(revealObscured("YWFhYWFhYWFhYWFhYWFhYXMaGgIlEQ")).toBe("potato");
    expect(revealObscured(obscure(PASS))).toBe(PASS);
    for (const bad of [null, "", "short", "obscured(orchard lantern river)", "a b"]) expect(revealObscured(bad)).toBeNull();
  });

  it("refuses a different passphrase for a folder that already holds sealed copies", async () => {
    // The copy compares sizes, so archives sealed under the first passphrase looked up to date: the mirror reported
    // success with nothing transferred while the bucket held copies only the lost passphrase opens.
    const secretsDirectory = await secretsDir();
    const run = withRealObscure();
    const b2 = { provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "k" };
    await backupCloudSetup({ ...b2, passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    const saved = await readFile(configPath(secretsDirectory), "utf8");
    await expect(backupCloudSetup({ ...b2, passphrase: "a different passphrase" }, { run, secretsDirectory, rclone: "/" }))
      .rejects.toThrow("The copies already in home-backups/homebox/sealed were sealed with the passphrase you set before. Keep that passphrase, or choose a new folder so the new copies do not sit beside ones this passphrase cannot open.");
    expect(await readFile(configPath(secretsDirectory), "utf8")).toBe(saved);   // the passphrase that opens the copies is still the saved one
    // The same passphrase again (a rotated key, say) is the ordinary re-save.
    await backupCloudSetup({ ...b2, key: "k2", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("key = k2");
    // A new folder starts with nothing sealed in it, so it may take a new passphrase; so may another provider.
    await backupCloudSetup({ ...b2, path: "homebox-2027", passphrase: "a different passphrase" }, { run, secretsDirectory, rclone: "/" });
    const moved = await readFile(configPath(secretsDirectory), "utf8");
    expect(moved).toContain("remote = boxpilot:home-backups/homebox-2027/sealed");
    expect(revealObscured(moved.match(/^password = (.*)$/m)[1])).toBe("a different passphrase");
    await backupCloudSetup({ provider: "dropbox", path: "homebox-2027", token: "{\"access_token\":\"x\"}", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    // A saved passphrase that cannot be read back cannot be shown to match, so the folder keeps it.
    const unreadable = (await readFile(configPath(secretsDirectory), "utf8")).replace(/^password = .*$/m, "password = not obscured");
    await writeFile(configPath(secretsDirectory), unreadable);
    await expect(backupCloudSetup({ provider: "dropbox", path: "homebox-2027", token: "{\"access_token\":\"x\"}", passphrase: PASS }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("sealed with the passphrase you set before");
  });

  it("lets a destination saved before the mirror was encrypted take its first passphrase", async () => {
    const secretsDirectory = await secretsDir();
    await writeFile(configPath(secretsDirectory), renderRcloneConfig(normalizeCloudDestination({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }), { key: "k" }));
    await backupCloudSetup({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "k", passphrase: PASS }, { run: withRealObscure(), secretsDirectory, rclone: "/" });
    expect(isSealedConfig(await readFile(configPath(secretsDirectory), "utf8"))).toBe(true);
  });
});

describe("cloud backup tasks", () => {
  // Linux only: POSIX file modes.
  it.skipIf(onWindows)("writes a root-only rclone.conf with the secret and reports the target", async () => {
    const secretsDirectory = await secretsDir();
    const run = withObscure();
    const result = await backupCloudSetup({ provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox", key: "K123", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    expect(result).toMatchObject({ configured: true, target: "boxpilot:home-backups/homebox", destination: { provider: "b2", account: "0012abc", sealed: true } });
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("key = K123");
    expect(((await stat(configPath(secretsDirectory))).mode & 0o777)).toBe(0o600);
    await expect(backupCloudSetup({ provider: "b2", account: "a", bucket: "bkt" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("application key is required");
    await expect(backupCloudSetup({ provider: "drive", token: "not-json" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("token JSON");
    // WebDAV passwords are obscured through rclone on stdin, never on a command line.
    const obscure = vi.fn(async (binary, args, options) => (args[0] === "obscure" ? { ok: true, stdout: `obscured(${options.input})\n`, stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    await backupCloudSetup({ provider: "webdav", url: "https://cloud.example.com/remote.php/dav/files/me/", user: "me", password: "p w", path: "boxpilot", passphrase: PASS }, { run: obscure, secretsDirectory, rclone: "/" });
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("pass = obscured(p w)");
    await expect(backupCloudSetup({ provider: "b2", account: "a", bucket: "bkt", key: "k", passphrase: PASS }, { run, secretsDirectory, rclone: "/nonexistent/rclone" })).rejects.toThrow("rclone is not installed");
  });

  // Linux only: POSIX file modes on the written config.
  it.skipIf(onWindows)("tells rclone not to check or create the bucket, so a key scoped to one bucket works", async () => {
    // A Cloudflare R2 token with Object Read & Write failed the destination test with 403
    // AccessDenied on `rclone mkdir`, while `lsf` of the same bucket with the same keys listed it:
    // rclone was checking the bucket existed and creating it when it thought otherwise, and neither
    // is a call an object-scoped key may make. The owner makes the bucket; this only copies into it.
    const secretsDirectory = await secretsDir();
    const run = withObscure(async () => ({ ok: true, stdout: "", stderr: "" }));
    await backupCloudSetup({ provider: "s3", endpoint: "https://account.r2.cloudflarestorage.com", bucket: "homebox-backups", path: "boxpilot", accessKeyId: "AK", secretAccessKey: "SK", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    const s3Config = await readFile(configPath(secretsDirectory), "utf8");
    expect(s3Config).toContain("no_check_bucket = true");
    expect(s3Config).toContain("provider = Other");   // an endpoint means an S3 service, not AWS
    expect(s3Config).toContain("acl = private");
    await backupCloudSetup({ provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox", key: "K123", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("no_check_bucket = true");
  });

  it("tests the destination by creating and listing the folder, and mirrors with rclone copy", async () => {
    const secretsDirectory = await secretsDir();
    const run = withObscure(async (binary, args) => {
      const verb = args.find((arg) => ["mkdir", "lsjson", "about", "copy"].includes(arg));
      if (verb === "lsjson") return { ok: true, stdout: JSON.stringify([{ Name: "controller-backups" }]), stderr: "" };
      if (verb === "about") return { ok: true, stdout: JSON.stringify({ free: 50 * 1024 ** 3 }), stderr: "" };
      if (verb === "copy") return { ok: true, stdout: "", stderr: "Transferred:   \t  1.000 MiB / 1.000 MiB, 100%\nErrors:                 0\nTransferred:            1 / 1, 100%\n" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await backupCloudSetup({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "k", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    const tested = await backupCloudTest({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, { run, secretsDirectory, rclone: "/" });
    expect(tested).toEqual({ reachable: true, writable: true, target: "boxpilot:home-backups/homebox", entries: 1, freeBytes: 50 * 1024 ** 3 });
    expect(run).toHaveBeenCalledWith("/", expect.arrayContaining(["--config", configPath(secretsDirectory), "mkdir", "boxpilot:home-backups/homebox"]), expect.anything());

    const sources = [{ name: "controller-backups", root: secretsDirectory }, { name: "missing", root: "/nonexistent/root" }];
    const synced = await backupCloudSync({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, { run, secretsDirectory, rclone: "/", sources, now: () => new Date("2026-08-21T21:30:00Z") });
    expect(synced).toMatchObject({ synced: true, encrypted: true, destination: "boxpilot:home-backups/homebox/sealed", completedAt: "2026-08-21T21:30:00.000Z", filesTransferred: 1, errors: 0, mirrored: [{ name: "controller-backups", filesTransferred: 1 }], boundary: { deletesPerformed: false } });
    const copyCall = run.mock.calls.find(([, args]) => args.includes("copy"));
    expect(copyCall[1]).toEqual(expect.arrayContaining(["copy", "--size-only", secretsDirectory, "boxpilot-sealed:controller-backups"]));
    // A sealed remote offers no hashes, so the copy compares sizes and must not say it checked contents.
    expect(copyCall[1]).not.toContain("--checksum");
    expect(synced.boundary.checksumVerified).toBe(false);
    expect(copyCall[1].some((arg) => arg.startsWith("boxpilot:"))).toBe(false);
    expect(copyCall[1]).not.toContain("sync");
    await expect(backupCloudTest({ provider: "b2", account: "a", bucket: "bkt" }, { run, secretsDirectory: await secretsDir(), rclone: "/" })).rejects.toThrow("Save the cloud destination first");
  });

  it("leaves machine-snapshot working folders, which hold secrets in the clear, out of the copy", async () => {
    const secretsDirectory = await secretsDir();
    const run = withObscure(async () => ({ ok: true, stdout: "", stderr: "Errors:                 0\nTransferred:            1 / 1, 100%\n" }));
    await backupCloudSetup({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "k", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    await backupCloudSync({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, { run, secretsDirectory, rclone: "/", sources: [{ name: "machine-snapshots", root: secretsDirectory }] });
    const copyCall = run.mock.calls.find(([, args]) => args.includes("copy"));
    expect(copyCall[1]).toEqual(expect.arrayContaining(["--exclude", "/.staging-*/**", "--exclude", "/.restore-*/**", "--exclude", "/restored/**"]));
  });

  it("leaves an app backup still being written out of every copy", async () => {
    // `<stamp>.tar.gz.partial` grows and is then renamed: copied, it would stay in the bucket as a
    // truncated archive, and its growing mid-transfer is an rclone error.
    const secretsDirectory = await secretsDir();
    const run = withObscure(async () => ({ ok: true, stdout: "", stderr: "Errors:                 0\nTransferred:            1 / 1, 100%\n" }));
    await backupCloudSetup({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "k", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    const sources = [{ name: "application-backups", root: secretsDirectory }, { name: "machine-snapshots", root: secretsDirectory }];
    await backupCloudSync({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, { run, secretsDirectory, rclone: "/", sources });
    const copyCalls = run.mock.calls.filter(([, args]) => args.includes("copy"));
    expect(copyCalls).toHaveLength(2);
    for (const [, args] of copyCalls) expect(args.join(" ")).toContain("--exclude *.partial");
  });

  it.skipIf(onWindows)("encrypts every copy with the owner's passphrase and refuses a plain destination", async () => {
    // App backups carry each app's .env (generated passwords, session secrets, data keys) beside the data those keys
    // seal; a plain bucket copy was the whole server for whoever read the bucket.
    const secretsDirectory = await secretsDir();
    const run = withObscure(async () => ({ ok: true, stdout: "", stderr: "Errors:                 0\nTransferred:            1 / 1, 100%\n" }));
    const b2 = { provider: "b2", account: "a", bucket: "home-backups", path: "homebox" };
    await expect(backupCloudSetup({ ...b2, key: "k" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("encryption passphrase");
    await expect(backupCloudSetup({ ...b2, key: "k", passphrase: "too short" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("at least 12");
    await expect(backupCloudSetup({ ...b2, key: "k", passphrase: "line\nbreak passphrase" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("encryption passphrase holds a line break");
    await backupCloudSetup({ ...b2, key: "k", passphrase: PASS }, { run, secretsDirectory, rclone: "/" });
    const config = await readFile(configPath(secretsDirectory), "utf8");
    expect(isSealedConfig(config)).toBe(true);
    expect(config).toContain("[boxpilot-sealed]\ntype = crypt\nremote = boxpilot:home-backups/homebox/sealed\nfilename_encryption = off\ndirectory_name_encryption = false\npassword = obscured(orchard lantern river)\n");
    expect(config).not.toContain(`= ${PASS}`);
    const obscureCall = run.mock.calls.find(([, args]) => args[0] === "obscure");
    expect(obscureCall[1]).toEqual(["obscure", "-"]); // on stdin, never on a command line

    // A destination saved by an older version: no sealed remote, so nothing is copied at all.
    const plain = await secretsDir();
    await writeFile(configPath(plain), renderRcloneConfig(normalizeCloudDestination(b2), { key: "k" }), { mode: 0o600 });
    const copier = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    await expect(backupCloudSync(b2, { run: copier, secretsDirectory: plain, rclone: "/", sources: [{ name: "application-backups", root: plain }] })).rejects.toThrow("not encrypted yet, so nothing was copied");
    expect(copier).not.toHaveBeenCalled();
  });
});

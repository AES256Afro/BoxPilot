import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupCloudSetup, backupCloudSync, backupCloudTest, configPath } from "./backup-cloud.mjs";
import { cloudTarget, normalizeCloudDestination, parseRcloneStats, renderRcloneConfig, validateCloudDestination } from "../backup-cloud.mjs";

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
    expect(renderRcloneConfig(b2, { key: "K" })).toBe("# Managed by BoxPilot\n[boxpilot]\ntype = b2\naccount = 0012abc\nkey = K\n");
    expect(renderRcloneConfig(normalizeCloudDestination({ provider: "s3", bucket: "bkt", endpoint: "https://s3.wasabisys.com", accessKeyId: "AK" }), { secretAccessKey: "SK" })).toContain("provider = Other\naccess_key_id = AK\nsecret_access_key = SK\nendpoint = https://s3.wasabisys.com");
    expect(renderRcloneConfig(normalizeCloudDestination({ provider: "dropbox", path: "backups" }), { token: "{\"access_token\":\"x\"}" })).toContain("type = dropbox\ntoken = {\"access_token\":\"x\"}");
    expect(parseRcloneStats("Transferred:   \t  12.345 MiB / 12.345 MiB, 100%, 1.2 MiB/s, ETA 0s\nErrors:                 0\nChecks:                 3 / 3, 100%\nTransferred:            2 / 2, 100%\n")).toEqual({ filesTransferred: 2, filesTotal: 2, bytesTransferred: "12.345 MiB", errors: 0 });
  });
});

describe("cloud backup tasks", () => {
  it("writes a root-only rclone.conf with the secret and reports the target", async () => {
    const secretsDirectory = await secretsDir();
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const result = await backupCloudSetup({ provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox", key: "K123" }, { run, secretsDirectory, rclone: "/" });
    expect(result).toMatchObject({ configured: true, target: "boxpilot:home-backups/homebox", destination: { provider: "b2", account: "0012abc" } });
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("key = K123");
    expect(((await stat(configPath(secretsDirectory))).mode & 0o777)).toBe(0o600);
    await expect(backupCloudSetup({ provider: "b2", account: "a", bucket: "bkt" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("application key is required");
    await expect(backupCloudSetup({ provider: "drive", token: "not-json" }, { run, secretsDirectory, rclone: "/" })).rejects.toThrow("token JSON");
    // WebDAV passwords are obscured through rclone on stdin, never on a command line.
    const obscure = vi.fn(async (binary, args, options) => (args[0] === "obscure" ? { ok: true, stdout: `obscured(${options.input})\n`, stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    await backupCloudSetup({ provider: "webdav", url: "https://cloud.example.com/remote.php/dav/files/me/", user: "me", password: "p w", path: "boxpilot" }, { run: obscure, secretsDirectory, rclone: "/" });
    expect(await readFile(configPath(secretsDirectory), "utf8")).toContain("pass = obscured(p w)");
    await expect(backupCloudSetup({ provider: "b2", account: "a", bucket: "bkt", key: "k" }, { run, secretsDirectory, rclone: "/nonexistent/rclone" })).rejects.toThrow("rclone is not installed");
  });

  it("tests the destination by creating and listing the folder, and mirrors with rclone copy", async () => {
    const secretsDirectory = await secretsDir();
    const run = vi.fn(async (binary, args) => {
      const verb = args.find((arg) => ["mkdir", "lsjson", "about", "copy"].includes(arg));
      if (verb === "lsjson") return { ok: true, stdout: JSON.stringify([{ Name: "controller-backups" }]), stderr: "" };
      if (verb === "about") return { ok: true, stdout: JSON.stringify({ free: 50 * 1024 ** 3 }), stderr: "" };
      if (verb === "copy") return { ok: true, stdout: "", stderr: "Transferred:   \t  1.000 MiB / 1.000 MiB, 100%\nErrors:                 0\nTransferred:            1 / 1, 100%\n" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await backupCloudSetup({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "k" }, { run, secretsDirectory, rclone: "/" });
    const tested = await backupCloudTest({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, { run, secretsDirectory, rclone: "/" });
    expect(tested).toEqual({ reachable: true, writable: true, target: "boxpilot:home-backups/homebox", entries: 1, freeBytes: 50 * 1024 ** 3 });
    expect(run).toHaveBeenCalledWith("/", expect.arrayContaining(["--config", configPath(secretsDirectory), "mkdir", "boxpilot:home-backups/homebox"]), expect.anything());

    const sources = [{ name: "controller-backups", root: secretsDirectory }, { name: "missing", root: "/nonexistent/root" }];
    const synced = await backupCloudSync({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, { run, secretsDirectory, rclone: "/", sources, now: () => new Date("2026-08-21T21:30:00Z") });
    expect(synced).toMatchObject({ synced: true, destination: "boxpilot:home-backups/homebox", completedAt: "2026-08-21T21:30:00.000Z", filesTransferred: 1, errors: 0, mirrored: [{ name: "controller-backups", filesTransferred: 1 }], boundary: { deletesPerformed: false } });
    const copyCall = run.mock.calls.find(([, args]) => args.includes("copy"));
    expect(copyCall[1]).toEqual(expect.arrayContaining(["copy", "--checksum", secretsDirectory, "boxpilot:home-backups/homebox/controller-backups"]));
    expect(copyCall[1]).not.toContain("sync");
    await expect(backupCloudTest({ provider: "b2", account: "a", bucket: "bkt" }, { run, secretsDirectory: await secretsDir(), rclone: "/" })).rejects.toThrow("Save the cloud destination first");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupRemoteInternals, backupRemoteKeygen, backupRemoteSync, backupRemoteTest } from "./backup-remote.mjs";

const directories = [];
const destination = { host: "nas.local", port: 22, user: "backup", path: "/srv/boxpilot" };

async function fixture({ withKey = true, withKnownHosts = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-remote-mirror-"));
  directories.push(root);
  const secretsDirectory = path.join(root, "secrets");
  await mkdir(secretsDirectory, { recursive: true });
  if (withKey) { await writeFile(path.join(secretsDirectory, "backup-mirror-key"), "PRIVATE"); await writeFile(path.join(secretsDirectory, "backup-mirror-key.pub"), "ssh-ed25519 AAAA boxpilot-backup-mirror\n"); }
  if (withKnownHosts) await writeFile(path.join(secretsDirectory, "backup-mirror-known_hosts"), "nas.local ssh-ed25519 BBBB\n");
  const sources = [{ name: "controller-backups", root: path.join(root, "controller") }, { name: "machine-snapshots", root: path.join(root, "missing") }];
  await mkdir(sources[0].root, { recursive: true });
  const calls = [];
  const run = vi.fn(async (binary, args) => {
    calls.push(`${binary} ${args.join(" ")}`);
    if (binary.endsWith("ssh-keygen") && args[0] === "-lf") return { ok: true, stdout: "256 SHA256:abcdef boxpilot-backup-mirror (ED25519)\n", stderr: "" };
    if (binary.endsWith("ssh-keygen") && args[0] === "-lF") return { ok: true, stdout: "# Host nas.local found: line 1\nnas.local ED25519 SHA256:hostkey123\n", stderr: "" };
    if (binary.endsWith("ssh-keygen")) { await writeFile(path.join(secretsDirectory, "backup-mirror-key"), "NEW"); await writeFile(path.join(secretsDirectory, "backup-mirror-key.pub"), "ssh-ed25519 CCCC boxpilot-backup-mirror\n"); return { ok: true, stdout: "", stderr: "" }; }
    if (binary.endsWith("/ssh")) return { ok: true, stdout: "/dev/sda1 1000000 400000 600000 40% /srv\n", stderr: "" };
    if (binary.endsWith("rsync")) return { ok: true, stdout: "Number of files: 4 (reg: 3, dir: 1)\nNumber of regular files transferred: 2\nTotal transferred file size: 1,048,576 bytes\n", stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected ${binary}` };
  });
  return { run, calls, secretsDirectory, sources };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("off-box SSH mirror tasks", () => {
  it("generates the key once and reports the public half", async () => {
    const { run, calls, secretsDirectory } = await fixture({ withKey: false, withKnownHosts: false });
    const first = await backupRemoteKeygen({}, { run, secretsDirectory });
    expect(first).toMatchObject({ created: true, publicKey: "ssh-ed25519 CCCC boxpilot-backup-mirror", fingerprint: "SHA256:abcdef" });
    expect(calls[0]).toContain("-t ed25519 -N  -C boxpilot-backup-mirror");
    const second = await backupRemoteKeygen({}, { run, secretsDirectory });
    expect(second.created).toBe(false);
  });

  it("tests the destination with batch-mode ssh, pins the host key on first use, and reports free space", async () => {
    const { run, calls, secretsDirectory } = await fixture({ withKnownHosts: false });
    const result = await backupRemoteTest(destination, { run, secretsDirectory });
    expect(result).toMatchObject({ reachable: true, writable: true, freeBytes: 600000 * 1024, hostKeyFingerprint: "SHA256:hostkey123", destination: "backup@nas.local:/srv/boxpilot" });
    expect(calls[0]).toContain("-o BatchMode=yes");
    expect(calls[0]).toContain("StrictHostKeyChecking=accept-new");
    expect(calls[0]).toContain("backup@nas.local mkdir -p /srv/boxpilot && test -w /srv/boxpilot && df -Pk /srv/boxpilot | tail -n 1");
    await expect(backupRemoteTest({ ...destination, path: "/srv/x y" }, { run, secretsDirectory })).rejects.toThrow("path must be absolute");
  });

  it("mirrors each existing backup root with strict host keys, never deletes, and sums the stats", async () => {
    const { run, calls, secretsDirectory, sources } = await fixture();
    const statExists = await import("node:fs/promises").then((fs) => fs.stat("/usr/bin/rsync").then(() => true, () => false));
    const promise = backupRemoteSync(destination, { run, secretsDirectory, sources, now: () => new Date("2026-08-21T18:00:00.000Z") });
    if (!statExists) { await expect(promise).rejects.toThrow("rsync is not installed"); return; }
    const result = await promise;
    expect(result).toMatchObject({ synced: true, completedAt: "2026-08-21T18:00:00.000Z", filesTransferred: 2, bytesTransferred: 1048576, mirrored: [{ name: "controller-backups" }], boundary: { deletesPerformed: false } });
    const rsyncCall = calls.find((call) => call.includes("rsync"));
    expect(rsyncCall).toContain("-a --checksum --partial --mkpath --stats");
    expect(rsyncCall).toContain("StrictHostKeyChecking=yes");
    expect(rsyncCall).not.toContain("--delete");
    expect(rsyncCall).toContain(`${sources[0].root}/ backup@nas.local:/srv/boxpilot/controller-backups/`);
  });

  it("refuses to sync before the key exists or the host key is pinned", async () => {
    const { run, secretsDirectory, sources } = await fixture({ withKnownHosts: false });
    await expect(backupRemoteSync(destination, { run, secretsDirectory, sources })).rejects.toThrow("Test the destination first");
    const bare = await fixture({ withKey: false, withKnownHosts: false });
    await expect(backupRemoteSync(destination, { run: bare.run, secretsDirectory: bare.secretsDirectory, sources })).rejects.toThrow("Generate the mirror key first");
    expect(backupRemoteInternals.parseRsyncStats("Number of regular files transferred: 12\nTotal transferred file size: 3,000 bytes")).toEqual({ filesTransferred: 12, bytesTransferred: 3000 });
  });
});

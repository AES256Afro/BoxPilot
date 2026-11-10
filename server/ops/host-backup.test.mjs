import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostBackupOperations } from "./host-backup.mjs";

/**
 * The off-box mirror's own two operations (M56.2). Both were in the registry and named by no test:
 * the one that makes the key the mirror authenticates with, and the one the page reads to say
 * whether the mirror is ready at all.
 */
const operation = (id) => hostBackupOperations().find((entry) => entry.id === id);

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  delete process.env.BOXPILOT_SECRETS_DIRECTORY;
});

async function secretsDirectory(files = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-mirror-"));
  directories.push(directory);
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents);
  process.env.BOXPILOT_SECRETS_DIRECTORY = directory;
  return directory;
}

describe("making the off-box mirror key", () => {
  it("stages the keygen task, and is medium with nothing to choose", async () => {
    const found = operation("backup.remote.setup");
    expect(found).toMatchObject({ risk: "medium", readOnly: false });
    expect(Object.keys(found.parameters?.fields ?? {})).toEqual([]);
    const runUnit = { runTask: vi.fn(async () => ({ created: true })) };
    await found.run({}, { runUnit, jobLog: { path: "/tmp/job.log" } });
    expect(runUnit.runTask).toHaveBeenCalledWith("backup.remote.keygen", {}, expect.objectContaining({ logPath: "/tmp/job.log" }));
  });
});

describe("reading whether the off-box mirror is ready", () => {
  it("reports a key, its fingerprint, the pinned host keys and rsync", async () => {
    await secretsDirectory({
      "backup-mirror-key.pub": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 boxpilot-backup-mirror\n",
      // One comment and one blank line, neither of which is a pinned host key.
      "backup-mirror-known_hosts": "# written by BoxPilot\n\ndestination.example ssh-ed25519 AAAA\n[dest]:2222 ssh-ed25519 BBBB\n",
    });
    const run = vi.fn(async () => ({ ok: true, stdout: "256 SHA256:abc123 boxpilot-backup-mirror (ED25519)\n" }));
    const read = await operation("backup.remote.inspect").run({}, { run });
    expect(read).toMatchObject({ keyReady: true, fingerprint: "SHA256:abc123", hostKeysPinned: 2 });
    expect(read.publicKey).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 boxpilot-backup-mirror");
    expect(typeof read.rsyncInstalled).toBe("boolean");
  });

  it("says the key is not ready rather than failing, when nothing has been set up", async () => {
    await secretsDirectory();
    const run = vi.fn(async () => ({ ok: true, stdout: "" }));
    const read = await operation("backup.remote.inspect").run({}, { run });
    expect(read).toMatchObject({ keyReady: false, publicKey: null, fingerprint: null, hostKeysPinned: 0 });
    // No key, so there is nothing to take a fingerprint of and ssh-keygen is not run.
    expect(run).not.toHaveBeenCalled();
  });

  it("still answers when ssh-keygen fails or is missing", async () => {
    await secretsDirectory({ "backup-mirror-key.pub": "ssh-ed25519 AAAA key\n" });
    const failing = await operation("backup.remote.inspect").run({}, { run: async () => ({ ok: false, stdout: "" }) });
    expect(failing).toMatchObject({ keyReady: true, fingerprint: null });
    const throwing = await operation("backup.remote.inspect").run({}, { run: async () => { throw new Error("ENOENT"); } });
    expect(throwing).toMatchObject({ keyReady: true, fingerprint: null });
  });

  it("is a read that needs no role of its own: it returns a public key and counts, nothing private", () => {
    expect(operation("backup.remote.inspect")).toMatchObject({ readOnly: true, risk: "low", minimumRole: null });
  });
});

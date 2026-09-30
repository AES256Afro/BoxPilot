// @vitest-environment node
/**
 * Boot-critical files survive a power cut mid-write (reliability audit, 2026-09-29): the old file
 * or the new one, never an empty or half-written one. What a crash does is simulated by a write
 * that fails part-way; the real fsync ordering is checked by recording the calls.
 */
import { lstat, mkdtemp, open, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { writeFileDurably } from "./durable-file.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function folder() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-durable-"));
  directories.push(directory);
  return directory;
}

const fstab = "UUID=0000-0001 / ext4 defaults 0 1\n# boxpilot:media\nUUID=0000-0002 /mnt/media ext4 defaults,nofail 0 2\n";

describe("writing a boot-critical file", () => {
  it("replaces it whole and leaves no temporary file behind", async () => {
    const directory = await folder();
    const file = path.join(directory, "fstab");
    await writeFile(file, "old\n");
    await writeFileDurably(file, fstab);
    expect(await readFile(file, "utf8")).toBe(fstab);
    expect(await readdir(directory)).toEqual(["fstab"]);
  });

  it("keeps the old file intact when the write fails part-way, where writeFile leaves it cut short", async () => {
    const directory = await folder();
    const file = path.join(directory, "fstab");
    // A handle whose write gets half the text out and then dies, as a power cut would.
    const dying = {
      ...fsPromises,
      open: async (target, flag, mode) => {
        const handle = await open(target, flag, mode);
        return Object.assign(Object.create(handle), {
          writeFile: async (data) => { await handle.write(String(data).slice(0, 10)); throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }); },
          sync: () => handle.sync(), close: () => handle.close(), chmod: (value) => handle.chmod(value),
        });
      },
    };
    await writeFile(file, fstab);
    await expect(writeFileDurably(file, "UUID=0000-0003 /mnt/new ext4 defaults,nofail 0 2\n", {}, { fs: dying })).rejects.toThrow("EIO");
    expect(await readFile(file, "utf8")).toBe(fstab);
    expect(await readdir(directory)).toEqual(["fstab"]);

    // What the root tasks did before: truncate, then write. The same failure leaves ten bytes of fstab.
    const inPlace = await open(file, "w");
    await inPlace.write("UUID=0000-0003 /mnt/new".slice(0, 10));
    await inPlace.close();
    expect(readFileSync(file, "utf8")).toBe("UUID=0000-");
  });

  it("puts the data on disk before the rename, and the rename on disk before it returns", async () => {
    const directory = await folder();
    const file = path.join(directory, "daemon.json");
    await writeFile(file, "{}\n");
    const calls = [];
    const recording = {
      ...fsPromises,
      open: async (target, flag, mode) => {
        const handle = await open(target, flag, mode);
        const name = target === directory ? "folder" : path.basename(target) === "daemon.json" ? "target" : "temporary";
        return Object.assign(Object.create(handle), {
          writeFile: async (data, options) => { calls.push(`write ${name}`); return handle.writeFile(data, options); },
          sync: async () => { calls.push(`sync ${name}`); try { await handle.sync(); } catch { /* a folder on Windows */ } },
          close: () => handle.close(), chmod: (value) => handle.chmod(value),
        });
      },
      rename: async (from, to) => { calls.push("rename"); return fsPromises.rename(from, to); },
    };
    await writeFileDurably(file, "{\"log-driver\": \"local\"}\n", {}, { fs: recording });
    expect(calls).toEqual(["write temporary", "sync temporary", "rename", "sync folder"]);
    expect(await readFile(file, "utf8")).toBe("{\"log-driver\": \"local\"}\n");
  });

  it("creates a backup copy only when none is there, as writeFile's wx flag does", async () => {
    const directory = await folder();
    const file = path.join(directory, "fstab.boxpilot-20260929T000000Z");
    await writeFileDurably(file, fstab, { mode: 0o644, flag: "wx" });
    expect(await readFile(file, "utf8")).toBe(fstab);
    await expect(writeFileDurably(file, "other\n", { mode: 0o644, flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(file, "utf8")).toBe(fstab);
  });

  // POSIX modes: the umask and chmod mean nothing on Windows.
  it.skipIf(onWindows)("keeps the mode of the file it replaces, and gives a new one the mode asked for", async () => {
    const directory = await folder();
    const kept = path.join(directory, "smb.conf");
    await writeFile(kept, "old\n", { mode: 0o640 });
    await fsPromises.chmod(kept, 0o640);
    await writeFileDurably(kept, "[global]\n", { mode: 0o600 });
    expect((await stat(kept)).mode & 0o777).toBe(0o640);
    const created = path.join(directory, "share-nas.cred");
    await writeFileDurably(created, "username=nas\n", { mode: 0o600 });
    expect((await stat(created)).mode & 0o777).toBe(0o600);
  });

  it("is what every root task writes with, bar the few named below and why", async () => {
    // fstab, smb.conf, exports, daemon.json, sshd's drop-in, the hosts file, BoxPilot's own env:
    // the root tasks write the files a boot depends on. None may truncate one in place again.
    const exceptions = new Map([
      ["agents.mjs", "writes one script into a folder it has just made with mkdtemp"],
      ["ups.mjs", "NUT's files; left to the power work in flight (M39) rather than changed under it"],
      // smb.conf and exports already go through a temporary file and a rename; the security audit in
      // flight changes both files' imports, so these follow once it has landed.
      ["nfs.mjs", "exports is written to a temporary file and renamed; converted after the security audit lands"],
      ["samba.mjs", "smb.conf is written to a temporary file and renamed; converted after the security audit lands"],
    ]);
    const folder = fileURLToPath(new URL("./tasks/", import.meta.url));
    const offenders = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".mjs") || name.endsWith(".test.mjs") || exceptions.has(name)) continue;
      const source = await readFile(path.join(folder, name), "utf8");
      if (/import\s*\{[^}]*\bwriteFile\b[^}]*\}\s*from\s*"node:fs\/promises"/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  // Symbolic links an unprivileged user may create.
  it.skipIf(onWindows)("writes through a symbolic link and leaves the link a link", async () => {
    const directory = await folder();
    const real = path.join(directory, "hosts.real");
    const link = path.join(directory, "hosts");
    await writeFile(real, "127.0.0.1 localhost\n");
    await symlink(real, link);
    await writeFileDurably(link, "127.0.0.1 localhost\n127.0.1.1 homeserver\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, "utf8")).toBe("127.0.0.1 localhost\n127.0.1.1 homeserver\n");
  });
});

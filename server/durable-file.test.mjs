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
import { copyFileExclusively, mkdirWithoutFollowing, readFileWithoutFollowing, replaceFileWithoutFollowing, writeFileDurably } from "./durable-file.mjs";

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

// R4S2-1: a file in a folder an archive was unpacked into (an app restored from a backup, the
// backup drive's mirror) is never written, read or copied through a link at its name: the archive
// can hold `.env.tmp` as a link to /etc/cron.d/x or to BoxPilot's own code.
describe("a file in a folder an archive was unpacked into", () => {
  it("is replaced by removing its temporary name, creating that exclusively, and renaming it over", async () => {
    const directory = await folder();
    const file = path.join(directory, ".env");
    await writeFile(file, "OLD=1\n");
    await writeFile(`${file}.tmp`, "left by an archive\n");
    const calls = [];
    const recording = {
      ...fsPromises,
      rm: async (target, options) => { calls.push(`rm ${path.basename(target)}`); return fsPromises.rm(target, options); },
      open: async (target, flag, mode) => { if (target !== directory) calls.push(`open ${path.basename(target)} ${flag}`); return open(target, flag, mode); },
      rename: async (from, to) => { calls.push(`rename ${path.basename(from)} ${path.basename(to)}`); return fsPromises.rename(from, to); },
    };
    await replaceFileWithoutFollowing(file, "NEW=1\n", { mode: 0o600 }, { fs: recording });
    expect(calls).toEqual(["rm .env.tmp", "open .env.tmp wx", "rename .env.tmp .env"]);
    expect(await readFile(file, "utf8")).toBe("NEW=1\n");
    expect(await readdir(directory)).toEqual([".env"]);
  });

  it("is never replaced when something takes the temporary name back before it is created", async () => {
    const directory = await folder();
    const file = path.join(directory, "compose.yaml");
    await writeFile(file, "services: {}\n");
    // The temporary name taken again between its removal and its exclusive creation, as a link
    // that reappears would take it: the exclusive create refuses, and nothing is renamed.
    const racing = { ...fsPromises, rm: async (target, options) => { await fsPromises.rm(target, options); if (target.endsWith(".tmp")) await writeFile(target, "planted\n"); } };
    await expect(replaceFileWithoutFollowing(file, "services: { x: {} }\n", {}, { fs: racing })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(file, "utf8")).toBe("services: {}\n");
  });

  // Symbolic links an unprivileged user may create.
  it.skipIf(onWindows)("replaces a link at its name or its temporary name, never what either points at", async () => {
    const directory = await folder();
    const outside = await folder();
    const victim = path.join(outside, "victim");
    await writeFile(victim, "untouched");
    for (const [name, at] of [[".env", ".env"], ["compose.yaml", "compose.yaml.tmp"]]) {
      await symlink(victim, path.join(directory, at));
      await replaceFileWithoutFollowing(path.join(directory, name), `${name} written\n`);
      expect((await lstat(path.join(directory, name))).isFile()).toBe(true);
      expect(await readFile(path.join(directory, name), "utf8")).toBe(`${name} written\n`);
    }
    // A link to a file that is not there yet (/etc/nologin) is not created through either.
    await symlink(path.join(outside, "not-yet"), path.join(directory, "boxpilot.json.tmp"));
    await replaceFileWithoutFollowing(path.join(directory, "boxpilot.json"), "{}");
    expect(await readdir(outside)).toEqual(["victim"]);
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect((await readdir(directory)).sort()).toEqual([".env", "boxpilot.json", "compose.yaml"]);
  });

  // Symbolic links an unprivileged user may create.
  it.skipIf(onWindows)("is read only when it is a regular file", async () => {
    const directory = await folder();
    const outside = await folder();
    await writeFile(path.join(outside, "secret"), "root's");
    await writeFile(path.join(directory, "plain"), "plain");
    await symlink(path.join(outside, "secret"), path.join(directory, "link"));
    expect(await readFileWithoutFollowing(path.join(directory, "plain"))).toBe("plain");
    await expect(readFileWithoutFollowing(path.join(directory, "link"))).rejects.toMatchObject({ code: "ELOOP" });
    await expect(readFileWithoutFollowing(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFileWithoutFollowing(directory)).rejects.toMatchObject({ code: "EINVAL" });
  });

  // Symbolic links an unprivileged user may create.
  it.skipIf(onWindows)("is copied only from a regular file, and only to a name nothing holds", async () => {
    const directory = await folder();
    const outside = await folder();
    const victim = path.join(outside, "victim");
    await writeFile(victim, "untouched");
    await writeFile(path.join(directory, "archive"), "archive bytes");
    await symlink(victim, path.join(directory, "linked-source"));
    await symlink(victim, path.join(directory, "linked-target"));
    await expect(copyFileExclusively(path.join(directory, "linked-source"), path.join(directory, "copy"))).rejects.toMatchObject({ code: "ELOOP" });
    await expect(copyFileExclusively(path.join(directory, "archive"), path.join(directory, "linked-target"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(victim, "utf8")).toBe("untouched");
    await copyFileExclusively(path.join(directory, "archive"), path.join(directory, "copy"), { mode: 0o600 });
    expect(await readFile(path.join(directory, "copy"), "utf8")).toBe("archive bytes");
    // Root's own file, which may be a link (/etc/fstab), is followed when the caller says so.
    await copyFileExclusively(path.join(directory, "linked-source"), path.join(directory, "followed"), { followSource: true });
    expect(await readFile(path.join(directory, "followed"), "utf8")).toBe("untouched");
  });

  // Symbolic links an unprivileged user may create.
  it.skipIf(onWindows)("has its folders made of real folders, never created through a link", async () => {
    const directory = await folder();
    const outside = await folder();
    await mkdirWithoutFollowing(directory, "provisioning/dashboards", { mode: 0o755 });
    expect((await stat(path.join(directory, "provisioning", "dashboards"))).isDirectory()).toBe(true);
    await symlink(outside, path.join(directory, "linked"));
    await expect(mkdirWithoutFollowing(directory, "linked/dashboards")).rejects.toMatchObject({ code: "ELOOP" });
    await expect(mkdirWithoutFollowing(directory, "../climbed")).rejects.toThrow(/climbs out/);
    expect(await readdir(outside)).toEqual([]);
  });
});

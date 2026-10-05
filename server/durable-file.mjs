/**
 * Writing a file so a power cut leaves either the old one or the new one, never half of either.
 *
 * `fs.writeFile` truncates the file and then writes it. A power cut between the two - the owner's
 * server lost power on 2026-09-29 - can leave /etc/fstab, /etc/docker/daemon.json, sshd's drop-in or
 * smb.conf empty or cut short, and each of those decides whether the next boot mounts the drives,
 * starts the apps, lets the owner in over SSH or serves the shares. Write-then-rename alone is not
 * enough either: without an fsync the rename can reach the disk before the data it points at.
 *
 * `writeFileDurably(file, data, options)` takes what `fs.writeFile` takes, so a root task can use it
 * as the `writeFile` of its injectable `files`, and does this instead:
 *   1. write a temporary file beside the target and fsync it;
 *   2. give it the target's owner and mode when the target exists (a new file gets `mode`, less the
 *      umask, as writeFile would give it);
 *   3. rename it over the target (over what a symbolic link points at, so the link stays a link) and
 *      fsync the folder, so the rename itself is on disk.
 * `flag: "wx"` (a backup copy that must not replace anything) creates the file exclusively and
 * fsyncs it. Any other `flag` is passed to `fs.writeFile` as asked. A target whose owner this process
 * cannot give the new file (not root, someone else's file) is written in place, as before.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod as fsChmod, chown as fsChown, lstat as fsLstat, mkdir as fsMkdir, open as fsOpen, realpath as fsRealpath, rename as fsRename, rm as fsRm, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

const defaultFs = { open: fsOpen, rename: fsRename, stat: fsStat, lstat: fsLstat, mkdir: fsMkdir, rm: fsRm, unlink: fsUnlink, chown: fsChown, chmod: fsChmod, realpath: fsRealpath, writeFile: fsWriteFile };

/** Open for reading without following a link at the name (ELOOP) or waiting on a pipe. O_NOFOLLOW is 0 on Windows. */
const readNoFollow = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** The error a link or a folder where a file was expected gives: ELOOP, as open(O_NOFOLLOW) says it. */
function notAFile(file, info) {
  return Object.assign(new Error(`${file} is ${info.isSymbolicLink() ? "a symbolic link" : "not a regular file"}`), { code: info.isSymbolicLink() ? "ELOOP" : "EINVAL" });
}

/** Fsync a folder so a rename in it survives a power cut. Some platforms cannot open one for it; that is not an error. */
export async function syncDirectory(directory, { fs = defaultFs } = {}) {
  let handle = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch { /* Windows, or a filesystem without directory fsync: the rename stands as written */ } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAndSync(fs, file, data, { flag, mode, encoding }) {
  const handle = await fs.open(file, flag, mode);
  try {
    await handle.writeFile(data, { encoding });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeFileDurably(file, data, options = {}, { fs = defaultFs } = {}) {
  const { mode = 0o666, flag = "w", encoding = "utf8" } = typeof options === "string" ? { encoding: options } : options ?? {};
  if (flag === "wx") {
    await writeAndSync(fs, file, data, { flag: "wx", mode, encoding });
    await syncDirectory(path.dirname(path.resolve(file)), { fs });
    return;
  }
  if (flag !== "w") { await fs.writeFile(file, data, options); return; }
  const target = await fs.realpath(file).catch(() => path.resolve(file));
  const existing = await fs.stat(target).catch(() => null);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeAndSync(fs, temporary, data, { flag: "wx", mode: existing ? 0o600 : mode, encoding });
    if (existing) {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      const gid = typeof process.getgid === "function" ? process.getgid() : null;
      if (uid !== null && (existing.uid !== uid || existing.gid !== gid)) {
        try {
          await fs.chown(temporary, existing.uid, existing.gid);
        } catch (error) {
          if (error?.code !== "EPERM") throw error;
          // Not ours to give away: write it where it is, as writeFile always did.
          await fs.unlink(temporary).catch(() => {});
          await fs.writeFile(file, data, options);
          return;
        }
      }
      // After chown, which clears set-id bits; and exact, where open() applied the umask.
      await fs.chmod(temporary, existing.mode & 0o7777);
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  await syncDirectory(directory, { fs });
}

/*
 * Files in a folder whose contents came from somewhere else.
 *
 * writeFileDurably writes onto what a symbolic link points at, on purpose: /etc/fstab may be one.
 * Inside a folder an archive was unpacked into (an app restored from a backup, a snapshot, the
 * backup drive's mirror) that is exactly what must never happen: the archive can hold `.env`, or
 * the `.env.tmp` it is written under, as a link to /etc/cron.d/x or to BoxPilot's own code, and
 * root would write through it. The helpers below never follow a link at the name they act on.
 */

/**
 * Replace `file` with `data` without following a link at its name or at its temporary one:
 *   1. remove `<file>.tmp`, whatever it is (a link goes, never what it points at);
 *   2. create it exclusively - O_CREAT|O_EXCL refuses a link that reappears there - write, fsync;
 *   3. rename it over `file`, which replaces the entry at that name (a link included), never the
 *      file a link there points at, and fsync the folder.
 * The new file is this process's, with `mode` less the umask. The folder itself is the caller's to
 * trust: only the last component is not followed.
 */
export async function replaceFileWithoutFollowing(file, data, { mode = 0o600, encoding = "utf8" } = {}, { fs = defaultFs } = {}) {
  const temporary = `${file}.tmp`;
  await fs.rm(temporary, { recursive: true, force: true });
  try {
    await writeAndSync(fs, temporary, data, { flag: "wx", mode, encoding });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(path.dirname(path.resolve(file)), { fs });
}

/**
 * Read a regular file without following a link at its name: ENOENT when nothing is there, ELOOP for
 * a link, EINVAL for a folder, a pipe or a device. A link read through would hand root's reading of
 * any file on the server to whatever reads the result.
 */
export async function readFileWithoutFollowing(file, { encoding = "utf8" } = {}, { fs = defaultFs } = {}) {
  const info = await fs.lstat(file);   // O_NOFOLLOW is not there on Windows; this is
  if (!info.isFile()) throw notAFile(file, info);
  const handle = await fs.open(file, readNoFollow);
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw notAFile(file, current);
    return await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

/**
 * Copy `source` to `target`, a new file: the target is created exclusively, so a link (or anything
 * else) already at that name is refused rather than written through, and the source must be a
 * regular file, never followed when it is a link (`followSource` for a trusted one of root's own,
 * /etc/fstab, which may be a link). Fsynced; the caller renames it into place.
 */
export async function copyFileExclusively(source, target, { mode = 0o600, followSource = false } = {}, { fs = defaultFs } = {}) {
  if (!followSource) {
    const info = await fs.lstat(source);
    if (!info.isFile()) throw notAFile(source, info);
  }
  const input = await fs.open(source, followSource ? fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) : readNoFollow);
  try {
    const info = await input.stat();
    if (!info.isFile()) throw notAFile(source, info);
    const output = await fs.open(target, "wx", mode);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        for (let written = 0; written < bytesRead;) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
      }
      await output.sync();
    } catch (error) {
      await output.close().catch(() => {});
      await fs.unlink(target).catch(() => {});
      throw error;
    }
    await output.close();
  } finally {
    await input.close();
  }
}

/**
 * `base/relative` as a folder made of real folders only, creating what is missing one level at a
 * time: a link, or a file, on the way is refused, so nothing is ever created or written through one.
 * `base` is the caller's to trust. Returns the full path.
 */
export async function mkdirWithoutFollowing(base, relative, { mode = 0o700 } = {}, { fs = defaultFs } = {}) {
  let current = path.resolve(base);
  for (const part of String(relative ?? "").split(/[\\/]+/).filter((piece) => piece && piece !== ".")) {
    if (part === "..") throw new Error(`${relative} climbs out of ${base}`);
    current = path.join(current, part);
    let info = await fs.lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) {
      await fs.mkdir(current, { mode }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink()) throw Object.assign(new Error(`${current} is a symbolic link; nothing is created or written through it`), { code: "ELOOP" });
    if (!info.isDirectory()) throw Object.assign(new Error(`${current} is not a folder`), { code: "ENOTDIR" });
  }
  return current;
}

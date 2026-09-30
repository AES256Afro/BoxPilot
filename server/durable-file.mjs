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
import { chmod as fsChmod, chown as fsChown, open as fsOpen, realpath as fsRealpath, rename as fsRename, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

const defaultFs = { open: fsOpen, rename: fsRename, stat: fsStat, unlink: fsUnlink, chown: fsChown, chmod: fsChmod, realpath: fsRealpath, writeFile: fsWriteFile };

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

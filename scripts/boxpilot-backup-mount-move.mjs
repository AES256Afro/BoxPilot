#!/usr/bin/env node
/**
 * Move the backup destination from /mnt/boxpilot-backup to /mnt/boxpilot/backup, or put one move
 * back. Run as root by scripts/boxpilot-upgrade.sh; the same move is the `storage.backup.relocate`
 * operation. See server/tasks/backup-mount-move.mjs.
 *
 *   node scripts/boxpilot-backup-mount-move.mjs                  # move (does nothing when there is nothing to move)
 *   node scripts/boxpilot-backup-mount-move.mjs undo <fstab-copy> # put back the move that saved <fstab-copy>
 *
 * Prints `fstab-copy=<path>` after a move, for the upgrade script to undo it on a rollback.
 */
import { moveBackupMount, undoBackupMountMove } from "../server/tasks/backup-mount-move.mjs";

const log = (line, stream = "stdout") => (stream === "stderr" ? console.error(line) : console.log(line));
const [command = "move", argument] = process.argv.slice(2);

try {
  if (command === "move") {
    const result = await moveBackupMount({}, { log });
    if (result.moved) console.log(`fstab-copy=${result.fstabCopy}`);
  } else if (command === "undo") {
    await undoBackupMountMove({ fstabCopy: argument }, { log });
  } else {
    console.error("Usage: boxpilot-backup-mount-move.mjs [move | undo <fstab-copy>]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

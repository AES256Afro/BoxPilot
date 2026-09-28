/**
 * Root-side halves of the disk-space cleanup (M30.8), run by scripts/boxpilot-run.mjs inside
 * boxpilot-run@.service. They are tasks rather than helper work for the reason the tree removal
 * is: the helper runs with ProtectSystem=strict, so /var/log/journal and /var/cache/apt are
 * read-only to it. Each checks its bounds again; the spec is the helper's, but a floor is cheap.
 */
import { fixedRun } from "../exec.mjs";
import { cleanupBounds, journalVacuumArgs, parseJournalVacuum } from "../space-recovery.mjs";

const journalctl = "/usr/bin/journalctl";
const aptGet = "/usr/bin/apt-get";

const within = (value, min, max) => value === null || (Number.isInteger(value) && value >= min && value <= max);

/**
 * `journalctl --vacuum-size/--vacuum-time` to the bound the owner chose. journald deletes archived
 * files only; the file it is writing is never among them.
 */
export async function journalVacuum({ maxBytes = null, maxAgeDays = null, ...rest } = {}, { run = fixedRun } = {}) {
  if (Object.keys(rest).length) throw new Error("The journal vacuum takes only maxBytes and maxAgeDays");
  if (maxBytes === null && maxAgeDays === null) throw new Error("The journal vacuum needs a size bound, an age bound, or both");
  if (!within(maxBytes, cleanupBounds.journalMinBytes, cleanupBounds.journalMaxBytes)) throw new Error(`The journal size bound must be a whole number of bytes from ${cleanupBounds.journalMinBytes} to ${cleanupBounds.journalMaxBytes}`);
  if (!within(maxAgeDays, cleanupBounds.journalMinAgeDays, cleanupBounds.journalMaxAgeDays)) throw new Error(`The journal age bound must be a whole number of days from ${cleanupBounds.journalMinAgeDays} to ${cleanupBounds.journalMaxAgeDays}`);
  const result = await run(journalctl, journalVacuumArgs({ maxBytes, maxAgeDays }), { timeout: 9 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (!result.ok) throw new Error(`journalctl could not vacuum the journal: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  // journalctl reports what it did on stderr.
  const reported = parseJournalVacuum(`${result.stdout}\n${result.stderr}`);
  return { vacuumed: true, deleted: reported.deleted.length, deletedFiles: reported.deleted.slice(0, 200).map((file) => file.path), freedBytes: reported.freedBytes };
}

/** `apt-get clean`: downloaded packages and the rebuildable caches. While an install holds APT's lock it fails and removes nothing. */
export async function aptClean(parameters = {}, { run = fixedRun } = {}) {
  if (Object.keys(parameters ?? {}).length) throw new Error("apt-get clean takes no parameters");
  const result = await run(aptGet, ["clean"], { timeout: 9 * 60_000 });
  if (!result.ok) throw new Error(`apt-get clean failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { cleaned: true };
}

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { cloudTarget, normalizeCloudDestination, parseRcloneStats, renderRcloneConfig } from "../backup-cloud.mjs";

/**
 * Cloud backup mirror with rclone (root side, runs in boxpilot-run@ with network).
 * The rclone configuration, including keys and tokens, lives at
 * /etc/boxpilot/secrets/rclone.conf (root, 0600) and is the only place secrets are kept.
 * Sync is `rclone copy`: nothing is ever deleted at the destination.
 */

const defaults = {
  secretsDirectory: process.env.BOXPILOT_SECRETS_DIRECTORY ?? "/etc/boxpilot/secrets",
  rclone: "/usr/bin/rclone",
  sources: [
    { name: "controller-backups", root: process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller" },
    { name: "application-backups", root: path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog") },
    { name: "machine-snapshots", root: process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots" },
  ],
};
export const configPath = (secretsDirectory = defaults.secretsDirectory) => path.join(secretsDirectory, "rclone.conf");
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

async function requireRclone(rclone) {
  const present = await access(rclone).then(() => true, () => false);
  if (!present) throw new Error("rclone is not installed; install it from the Backups page first");
}

/** Write the rclone remote. Secrets arrive as parameters (kept in memory by the job service) and go straight into the 0600 file. */
export async function backupCloudSetup(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  const secrets = {};
  if (destination.provider === "b2") { if (typeof parameters.key !== "string" || !parameters.key) throw new Error("The application key is required"); secrets.key = parameters.key; }
  if (destination.provider === "s3") { if (typeof parameters.secretAccessKey !== "string" || !parameters.secretAccessKey) throw new Error("The secret access key is required"); secrets.secretAccessKey = parameters.secretAccessKey; }
  if (destination.provider === "webdav") {
    if (typeof parameters.password !== "string" || !parameters.password) throw new Error("The password is required");
    const obscured = await run(rclone, ["obscure", "-"], { timeout: 15_000, input: `${parameters.password}` });
    if (!obscured.ok) throw new Error(`rclone obscure failed: ${tail(obscured.stderr)}`);
    secrets.passwordObscured = obscured.stdout.trim();
  }
  if (["drive", "onedrive", "dropbox"].includes(destination.provider)) {
    if (typeof parameters.token !== "string" || !/^\{.*"access_token".*\}$/s.test(parameters.token.trim())) throw new Error("Paste the whole token JSON printed by rclone authorize (it starts with {\"access_token\")");
    secrets.token = parameters.token.trim().replace(/\s*\n\s*/g, "");
  }
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configPath(secretsDirectory), renderRcloneConfig(destination, secrets), { mode: 0o600 });
  log?.(`Wrote ${configPath(secretsDirectory)} for ${destination.provider} (${cloudTarget(destination)}); secrets never leave this file`, "stdout");
  return { configured: true, destination, target: cloudTarget(destination) };
}

/** Create the destination folder and list it, proving the credentials work. */
export async function backupCloudTest(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  await stat(configPath(secretsDirectory)).catch(() => { throw new Error("Save the cloud destination first"); });
  const target = cloudTarget(destination);
  const common = ["--config", configPath(secretsDirectory), "--contimeout", "30s", "--timeout", "2m", "--low-level-retries", "2", "--retries", "1"];
  log?.(`$ rclone mkdir ${target}`, "stdout");
  const created = await run(rclone, [...common, "mkdir", target], { timeout: 120_000 });
  if (!created.ok) throw new Error(`Could not reach ${target}: ${tail(created.stderr) || "rclone failed"}`);
  const listed = await run(rclone, [...common, "lsjson", "--max-depth", "1", target], { timeout: 120_000 });
  if (!listed.ok) throw new Error(`Could not list ${target}: ${tail(listed.stderr)}`);
  let entries = 0;
  try { entries = JSON.parse(listed.stdout).length; } catch { entries = 0; }
  const about = await run(rclone, [...common, "about", "--json", "boxpilot:"], { timeout: 60_000 });
  let freeBytes = null;
  try { freeBytes = about.ok ? JSON.parse(about.stdout).free ?? null : null; } catch { freeBytes = null; }
  log?.(`${target} is reachable and writable (${entries} item(s) present${freeBytes !== null ? `, ${Math.round(freeBytes / 1024 ** 3)} GiB free` : ""})`, "stdout");
  return { reachable: true, writable: true, target, entries, freeBytes };
}

/** Copy every local backup root to the destination. rclone copy never deletes remotely. */
export async function backupCloudSync(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone, sources = defaults.sources, now = () => new Date() } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  await stat(configPath(secretsDirectory)).catch(() => { throw new Error("Save the cloud destination first"); });
  const target = cloudTarget(destination);
  const common = ["--config", configPath(secretsDirectory), "--contimeout", "30s", "--timeout", "10m", "--transfers", "4", "--checkers", "8", "--stats", "1h", "--stats-one-line", "-v"];
  const mirrored = [];
  let filesTransferred = 0; let errors = 0;
  for (const source of sources) {
    const exists = await stat(source.root).then((info) => info.isDirectory(), () => false);
    if (!exists) continue;
    log?.(`$ rclone copy --checksum ${source.root} ${target}/${source.name}`, "stdout");
    const result = await run(rclone, [...common, "copy", "--checksum", source.root, `${target}/${source.name}`], { timeout: 6 * 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    const stats = parseRcloneStats(`${result.stdout}\n${result.stderr}`);
    if (!result.ok) throw new Error(`rclone copy failed for ${source.name}: ${tail(result.stderr)}`);
    filesTransferred += stats.filesTransferred; errors += stats.errors;
    mirrored.push({ name: source.name, ...stats });
  }
  // Nothing to copy is not a copy, and errors mean this did not do what it says it did.
  if (mirrored.length === 0) throw new Error("There is nothing to mirror yet: take a backup or a machine snapshot first, then run this again.");
  if (errors > 0) throw new Error(`rclone reported ${errors} error(s) while copying, so this mirror is not complete. Check the log and run it again.`);
  const completedAt = now().toISOString();
  log?.(`Mirrored ${mirrored.length} backup root(s) to ${target}: ${filesTransferred} file(s) transferred`, "stdout");
  return { synced: true, destination: target, completedAt, mirrored, filesTransferred, bytesTransferred: mirrored.map((entry) => entry.bytesTransferred).filter(Boolean).join(" + ") || null, errors, boundary: { deletesPerformed: false, checksumVerified: true } };
}

import { createDecipheriv } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { writeFileDurably as writeFile } from "../durable-file.mjs";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { cloudTarget, isSealedConfig, minimumPassphraseLength, normalizeCloudDestination, parseRcloneStats, renderRcloneConfig, sealedFolder, sealedRemote, sealedTarget } from "../backup-cloud.mjs";

/**
 * Cloud backup mirror with rclone (root side, runs in boxpilot-run@ with network).
 * The rclone configuration, including keys and tokens, lives at
 * /etc/boxpilot/secrets/rclone.conf (root, 0600) and is the only place secrets are kept.
 * Sync is `rclone copy`: nothing is ever deleted at the destination. It copies only through the encrypted
 * remote (see sealedRemote): application backups hold each app's .env and machine snapshots every app's settings.
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

/**
 * What `rclone obscure` wrote, read back. Obscuring is not encryption: it is AES-256-CTR under a key printed in
 * rclone's source (fs/config/obscure), a fresh IV in front, base64url without padding, so two obscurings of one
 * passphrase never match and the saved one has to be read to be compared. Read here rather than by `rclone reveal`,
 * which takes the value on its command line, where every local user could see it for a moment.
 */
const rcloneObscureKey = Buffer.from("9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638", "hex");
export function revealObscured(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 16) return null;
  const decipher = createDecipheriv("aes-256-ctr", rcloneObscureKey, bytes.subarray(0, 16));
  return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8");
}

/** The saved destination's kind, the folder its sealed copies went to and the passphrase that sealed them; null when nothing sealed was saved. */
function savedSeal(config) {
  if (!isSealedConfig(config)) return null;
  const [plain, sealed = ""] = String(config).split(`[${sealedRemote}]\n`);
  const line = (text, name) => text.match(new RegExp(`^${name} = (.*)$`, "m"))?.[1] ?? null;
  return { type: line(plain, "type"), remote: line(sealed, "remote"), passphrase: revealObscured(line(sealed, "password")) };
}

/** Write the rclone remote. Secrets arrive as parameters (kept in memory by the job service) and go straight into the 0600 file. */
export async function backupCloudSetup(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  const secrets = {};
  // One line each (M50): the task writes them into the rclone file, and only the operation's check refused a line break before.
  for (const name of ["key", "secretAccessKey", "password", "passphrase"]) if (typeof parameters[name] === "string" && /[\r\n]/.test(parameters[name])) throw new Error(`The ${name === "key" ? "application key" : name === "secretAccessKey" ? "secret access key" : name === "passphrase" ? "encryption passphrase" : "password"} holds a line break`);
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
  if (typeof parameters.passphrase !== "string" || parameters.passphrase.length < minimumPassphraseLength) throw new Error(`An encryption passphrase of at least ${minimumPassphraseLength} characters is required: app backups hold each app's secrets, so nothing leaves this server unencrypted`);
  // The copy compares sizes (a sealed remote offers no hashes), so archives already sealed under another passphrase
  // look up to date and stay: the mirror would report success while the folder held copies only the old passphrase opens.
  const before = savedSeal(await readFile(configPath(secretsDirectory), "utf8").catch(() => null));
  const folder = `${cloudTarget(destination)}/${sealedFolder}`;
  if (before && before.type === destination.provider && before.remote === folder && before.passphrase !== parameters.passphrase) {
    throw new Error(`The copies already in ${folder.replace(/^boxpilot:/, "")} were sealed with the passphrase you set before. Keep that passphrase, or choose a new folder so the new copies do not sit beside ones this passphrase cannot open.`);
  }
  // Obscured the way rclone keeps every password in its config, on stdin, never on a command line.
  const sealed = await run(rclone, ["obscure", "-"], { timeout: 15_000, input: `${parameters.passphrase}` });
  if (!sealed.ok || !sealed.stdout.trim()) throw new Error(`rclone obscure failed: ${tail(sealed.stderr)}`);
  secrets.passphraseObscured = sealed.stdout.trim();
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configPath(secretsDirectory), renderRcloneConfig(destination, secrets), { mode: 0o600 });
  log?.(`Wrote ${configPath(secretsDirectory)} for ${destination.provider} (${cloudTarget(destination)}); copies go through ${sealedTarget()}, encrypted with your passphrase; secrets never leave this file`, "stdout");
  return { configured: true, destination: { ...destination, sealed: true }, target: cloudTarget(destination) };
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

/**
 * A snapshot or restore that stops half way leaves `.staging-*` or `.restore-*` beside the machine
 * snapshots, and a restore stages files for review under `restored/`. Each holds the controller
 * database and every app's .env unencrypted, so none of them leave the box.
 */
const machineSnapshotExcludes = ["--exclude", "/.staging-*/**", "--exclude", "/.restore-*/**", "--exclude", "/restored/**"];
/**
 * An app backup still being written (`<stamp>.tar.gz.partial`, renamed once whole). Copied, it would
 * stay in the bucket as a truncated archive, since rclone copy never deletes; growing or renamed
 * mid-transfer, it is an rclone error.
 */
const inProgressExcludes = ["--exclude", "*.partial"];

/** Copy every local backup root to the destination. rclone copy never deletes remotely. */
export async function backupCloudSync(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone, sources = defaults.sources, now = () => new Date() } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  const config = await readFile(configPath(secretsDirectory), "utf8").catch(() => { throw new Error("Save the cloud destination first"); });
  // A destination saved before the mirror was encrypted has no sealed remote: refuse rather than copy every app's
  // secrets into the bucket in the clear. Saving the destination again with a passphrase adds it.
  if (!isSealedConfig(config)) throw new Error("The cloud mirror is not encrypted yet, so nothing was copied: app backups hold each app's passwords and keys. Set the destination again with an encryption passphrase, then mirror. Copies an older version left in the bucket unencrypted stay there until you delete them.");
  cloudTarget(destination); // the destination must still be a valid one
  const target = sealedTarget();
  const common = ["--config", configPath(secretsDirectory), "--contimeout", "30s", "--timeout", "10m", "--transfers", "4", "--checkers", "8", "--stats", "1h", "--stats-one-line", "-v"];
  const mirrored = [];
  let filesTransferred = 0; let errors = 0;
  // By size: the sealed remote has no hashes to offer, so `--checksum` fell back to sizes anyway while reading as more.
  for (const source of sources) {
    const exists = await stat(source.root).then((info) => info.isDirectory(), () => false);
    if (!exists) continue;
    log?.(`$ rclone copy --size-only ${source.root} ${target}${source.name}`, "stdout");
    const excludes = source.name === "machine-snapshots" ? machineSnapshotExcludes : [];
    const result = await run(rclone, [...common, "copy", "--size-only", ...inProgressExcludes, ...excludes, source.root, `${target}${source.name}`], { timeout: 6 * 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    const stats = parseRcloneStats(`${result.stdout}\n${result.stderr}`);
    if (!result.ok) throw new Error(`rclone copy failed for ${source.name}: ${tail(result.stderr)}`);
    filesTransferred += stats.filesTransferred; errors += stats.errors;
    mirrored.push({ name: source.name, ...stats });
  }
  // Nothing to copy is not a copy, and errors mean this did not do what it says it did.
  if (mirrored.length === 0) throw new Error("There is nothing to mirror yet: take a backup or a machine snapshot first, then run this again.");
  if (errors > 0) throw new Error(`rclone reported ${errors} error(s) while copying, so this mirror is not complete. Check the log and run it again.`);
  const completedAt = now().toISOString();
  log?.(`Mirrored ${mirrored.length} backup root(s) to ${target} (encrypted, in ${cloudTarget(destination)}/sealed): ${filesTransferred} file(s) transferred`, "stdout");
  return { synced: true, encrypted: true, destination: `${cloudTarget(destination)}/sealed`, completedAt, mirrored, filesTransferred, bytesTransferred: mirrored.map((entry) => entry.bytesTransferred).filter(Boolean).join(" + ") || null, errors, boundary: { deletesPerformed: false, checksumVerified: false } };
}

import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { writeFileDurably as writeFile } from "../durable-file.mjs";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { cloudTarget, isSealedConfig, minimumPassphraseLength, normalizeCloudDestination, parseRcloneStats, renderRcloneConfig, sealedFolder, sealedRemote, sealedSnapshotFolder, sealedTarget } from "../backup-cloud.mjs";
import { snapshotNamePattern } from "../machine-snapshot-helper.mjs";

/**
 * Cloud backup mirror with rclone (root side, runs in boxpilot-run@ with network).
 * The rclone configuration, including keys and tokens, lives at
 * /etc/boxpilot/secrets/rclone.conf (root, 0600) and is the only place secrets are kept.
 * Sync is `rclone copy`: nothing is ever deleted at the destination. It copies only through the encrypted
 * remote (see sealedRemote): application backups hold each app's .env and machine snapshots every app's settings.
 */

const applicationBackupRoot = path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog");
const defaults = {
  secretsDirectory: process.env.BOXPILOT_SECRETS_DIRECTORY ?? "/etc/boxpilot/secrets",
  rclone: "/usr/bin/rclone",
  applicationBackupRoot,
  sources: [
    { name: "controller-backups", root: process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller" },
    { name: "application-backups", root: applicationBackupRoot },
    { name: "machine-snapshots", root: process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots" },
  ],
  snapshotRoot: process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots",
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
  const obscured = line(sealed, "password");
  return { type: line(plain, "type"), remote: line(sealed, "remote"), passphrase: revealObscured(obscured), passphraseObscured: obscured };
}

/**
 * The provider section of a saved rclone.conf as BoxPilot wrote it (renderRcloneConfig): its kind, the
 * fields a secret belongs to, and the secrets themselves. Read so that saving the destination again
 * with a secret left empty keeps the saved one (M91): renaming the folder or rotating the key no longer
 * means typing the passphrase twice more, where a slip would seal new copies with a passphrase nobody
 * knows. Null when nothing was saved.
 */
function savedProvider(config) {
  if (typeof config !== "string" || !config.includes("[boxpilot]\n")) return null;
  const section = config.split("[boxpilot]\n")[1].split(/^\[/m)[0];
  const line = (name) => { const value = section.match(new RegExp(`^${name} = (.*)$`, "m"))?.[1]; return value === undefined || value === "" ? null : value; };
  return { type: line("type"), account: line("account"), accessKeyId: line("access_key_id"), url: line("url"), user: line("user"), key: line("key"), secretAccessKey: line("secret_access_key"), passwordObscured: line("pass"), token: line("token") };
}

/**
 * Whether a saved secret still belongs to the destination being saved: the same provider and the same
 * account the secret signs in as. A new key ID with the old application key, or another WebDAV user
 * with the old password, is a secret that cannot work, so it must be typed.
 */
function sameAccount(saved, destination) {
  if (!saved || saved.type !== destination.provider) return false;
  if (destination.provider === "b2") return saved.account === destination.account;
  if (destination.provider === "s3") return saved.accessKeyId === destination.accessKeyId;
  if (destination.provider === "webdav") return saved.user === destination.user && saved.url === destination.url;
  return true;
}

/**
 * Write the rclone remote. Secrets arrive as parameters (kept in memory by the job service) and go straight into the 0600 file.
 * A secret left empty keeps the one already saved for the same provider and account (M91); the passphrase left empty keeps the
 * saved one whatever else changes, and a different one is still refused for a folder that already holds sealed copies.
 */
export async function backupCloudSetup(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  const secrets = {};
  const kept = [];
  // One line each (M50): the task writes them into the rclone file, and only the operation's check refused a line break before.
  for (const name of ["key", "secretAccessKey", "password", "passphrase"]) if (typeof parameters[name] === "string" && /[\r\n]/.test(parameters[name])) throw new Error(`The ${name === "key" ? "application key" : name === "secretAccessKey" ? "secret access key" : name === "passphrase" ? "encryption passphrase" : "password"} holds a line break`);
  const savedConfig = await readFile(configPath(secretsDirectory), "utf8").catch(() => null);
  const saved = savedProvider(savedConfig);
  const reusable = sameAccount(saved, destination) ? saved : null;
  const given = (name) => (typeof parameters[name] === "string" && parameters[name] !== "" ? parameters[name] : null);
  /** The secret typed, else the saved one for this account (noted as kept), else null. */
  const typedOrKept = (name, savedValue) => {
    const typed = given(name);
    if (typed !== null) return typed;
    if (savedValue) { kept.push(name); return savedValue; }
    return null;
  };
  // Said when the saved one is for another account, so "required" does not read as a fault in what was kept.
  const another = saved && saved.type === destination.provider && !reusable ? " (the saved one belongs to the account you changed)" : "";
  if (destination.provider === "b2") { secrets.key = typedOrKept("key", reusable?.key); if (!secrets.key) throw new Error(`The application key is required${another}`); }
  if (destination.provider === "s3") { secrets.secretAccessKey = typedOrKept("secretAccessKey", reusable?.secretAccessKey); if (!secrets.secretAccessKey) throw new Error(`The secret access key is required${another}`); }
  if (destination.provider === "webdav") {
    const typed = given("password");
    if (typed !== null) {
      const obscured = await run(rclone, ["obscure", "-"], { timeout: 15_000, input: `${typed}` });
      if (!obscured.ok) throw new Error(`rclone obscure failed: ${tail(obscured.stderr)}`);
      secrets.passwordObscured = obscured.stdout.trim();
    } else if (reusable?.passwordObscured) {
      kept.push("password");
      secrets.passwordObscured = reusable.passwordObscured;
    } else throw new Error(`The password is required${another}`);
  }
  if (["drive", "onedrive", "dropbox"].includes(destination.provider)) {
    const typed = given("token");
    if (typed !== null) {
      if (!/^\{.*"access_token".*\}$/s.test(typed.trim())) throw new Error("Paste the whole token JSON printed by rclone authorize (it starts with {\"access_token\")");
      secrets.token = typed.trim().replace(/\s*\n\s*/g, "");
    } else if (reusable?.token) {
      kept.push("token");
      secrets.token = reusable.token;
    } else throw new Error("Paste the whole token JSON printed by rclone authorize (it starts with {\"access_token\")");
  }
  const before = savedSeal(savedConfig);
  const typedPassphrase = given("passphrase");
  // Kept only when the saved one can be read back: a passphrase that cannot be shown is not one to seal new copies with.
  const keepPassphrase = typedPassphrase === null && Boolean(before?.passphrase) && Boolean(before?.passphraseObscured);
  const passphrase = keepPassphrase ? before.passphrase : typedPassphrase;
  if (typeof passphrase !== "string" || passphrase.length < minimumPassphraseLength) throw new Error(`An encryption passphrase of at least ${minimumPassphraseLength} characters is required: app backups hold each app's secrets, so nothing leaves this server unencrypted`);
  // The copy compares sizes (a sealed remote offers no hashes), so archives already sealed under another passphrase
  // look up to date and stay: the mirror would report success while the folder held copies only the old passphrase opens.
  const folder = `${cloudTarget(destination)}/${sealedFolder}`;
  if (before && before.type === destination.provider && before.remote === folder && before.passphrase !== passphrase) {
    throw new Error(`The copies already in ${folder.replace(/^boxpilot:/, "")} were sealed with the passphrase you set before. Keep that passphrase, or choose a new folder so the new copies do not sit beside ones this passphrase cannot open.`);
  }
  if (keepPassphrase) {
    kept.push("passphrase");
    secrets.passphraseObscured = before.passphraseObscured;
  } else {
    // Obscured the way rclone keeps every password in its config, on stdin, never on a command line.
    const sealed = await run(rclone, ["obscure", "-"], { timeout: 15_000, input: `${passphrase}` });
    if (!sealed.ok || !sealed.stdout.trim()) throw new Error(`rclone obscure failed: ${tail(sealed.stderr)}`);
    secrets.passphraseObscured = sealed.stdout.trim();
  }
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  // The guard above needs a saved configuration, which a rebuilt server does not have (nor one pointed at another
  // server's folder): it would seal new copies beside old ones under a passphrase that does not open them, and the
  // read-back would prove only what it had just written. So unless this is the folder and passphrase already saved,
  // the configuration is written aside and the copies already in the folder are opened with it first (M91).
  const unchanged = before && before.type === destination.provider && before.remote === folder && before.passphrase === passphrase;
  const rendered = renderRcloneConfig(destination, secrets);
  if (!unchanged) {
    const pending = `${configPath(secretsDirectory)}.checking`;
    await writeFile(pending, rendered, { mode: 0o600 });
    try {
      log?.(`$ rclone lsjson ${sealedTarget()}${sealedSnapshotFolder}, then open the newest record there with this passphrase`, "stdout");
      const seal = await existingSeal(run, rclone, flagsFor(pending));
      if (seal.error) throw new Error(`${seal.error} Nothing was saved.`);
      log?.(seal.artifact ? `Opened ${seal.artifact}.meta.json with this passphrase: it is the one the copies there were sealed with` : "No machine snapshot is in this folder yet, so there was nothing to open", "stdout");
    } catch (error) {
      await rm(pending, { force: true });
      throw error;
    }
    await rename(pending, configPath(secretsDirectory));
  } else await writeFile(configPath(secretsDirectory), rendered, { mode: 0o600 });
  log?.(`Wrote ${configPath(secretsDirectory)} for ${destination.provider} (${cloudTarget(destination)}); copies go through ${sealedTarget()}, encrypted with your passphrase; secrets never leave this file${kept.length ? `; kept the saved ${kept.join(" and ")}` : ""}`, "stdout");
  return { configured: true, destination: { ...destination, sealed: true }, target: cloudTarget(destination), kept };
}

/** A file's sha256, streamed. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    createReadStream(filePath).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => resolve(digest.digest("hex")));
  });
}

/** A machine snapshot's metadata as written beside it (machine-snapshot-helper), when it names a checksum. */
function parseSnapshotMeta(text, artifact) {
  let meta;
  try { meta = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!meta || typeof meta !== "object" || typeof meta.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(meta.checksumSha256)) return null;
  if (meta.artifact !== undefined && meta.artifact !== artifact) return null;
  return meta;
}

/** The machine snapshots the sealed remote lists, newest first, from `rclone lsjson`; null when it could not be listed. */
async function sealedSnapshots(run, rclone, common) {
  const listed = await run(rclone, [...common, "lsjson", "--files-only", `${sealedTarget()}${sealedSnapshotFolder}`], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (!listed.ok) {
    // Nothing mirrored yet: the folder is not there, which is an empty list, not a failure.
    if (/directory not found/i.test(listed.stderr)) return { entries: [], error: null };
    return { entries: null, error: tail(listed.stderr) || "rclone failed" };
  }
  let rows;
  try { rows = JSON.parse(listed.stdout || "[]"); } catch { return { entries: null, error: "rclone answered with something that is not a listing" }; }
  if (!Array.isArray(rows)) return { entries: null, error: "rclone answered with something that is not a listing" };
  const names = new Set(rows.map((row) => row?.Name).filter((name) => typeof name === "string"));
  const entries = rows
    .filter((row) => typeof row?.Name === "string" && snapshotNamePattern.test(row.Name))
    .map((row) => ({ artifact: row.Name, sizeBytes: Number.isFinite(row.Size) && row.Size >= 0 ? row.Size : null, modifiedAt: typeof row.ModTime === "string" ? row.ModTime : null, hasMeta: names.has(`${row.Name}.meta.json`) }))
    .sort((left, right) => right.artifact.localeCompare(left.artifact));
  return { entries, error: null };
}

/** Read a machine snapshot's metadata through the sealed remote: decrypting it proves the saved passphrase opens what is there. */
async function readSealedMeta(run, rclone, common, artifact) {
  const read = await run(rclone, [...common, "cat", `${sealedTarget()}${sealedSnapshotFolder}/${artifact}.meta.json`], { timeout: 120_000 });
  if (!read.ok) return { meta: null, error: tail(read.stderr) || "rclone failed" };
  const meta = parseSnapshotMeta(read.stdout, artifact);
  return meta ? { meta, error: null } : { meta: null, error: `${artifact}.meta.json did not decrypt to a snapshot record` };
}

const flagsFor = (configFile, timeout = "2m") => ["--config", configFile, "--contimeout", "30s", "--timeout", timeout, "--low-level-retries", "2", "--retries", "1"];
const commonFlags = (secretsDirectory, timeout = "2m") => flagsFor(configPath(secretsDirectory), timeout);

/**
 * Whether the passphrase in a configuration opens the copies already in its folder (M91): the newest machine snapshot
 * record there, decrypted. `error` says why not; an empty folder, or one with no snapshot record yet, is fine
 * (`artifact` null). Every snapshot the folder lists comes back as `listed`, so a read-back can say whether the copy it
 * proved was one already there. Which rclone message means a wrong passphrase is PLAUSIBLE (crypt's "failed to
 * authenticate decrypted block"); any failure to open refuses, the wording only picks the likelier cause.
 */
async function existingSeal(run, rclone, common) {
  const snapshots = await sealedSnapshots(run, rclone, common);
  if (snapshots.entries === null) return { error: `Could not list the copies already in the folder to check the passphrase: ${snapshots.error}.`, artifact: null, listed: [] };
  const listed = snapshots.entries.map((entry) => entry.artifact);
  const newest = snapshots.entries.find((entry) => entry.hasMeta) ?? null;
  if (!newest) return { error: null, artifact: null, listed };
  const opened = await readSealedMeta(run, rclone, common, newest.artifact);
  if (opened.meta) return { error: null, artifact: newest.artifact, listed };
  const wrong = /authenticate|bad password|decrypt|not a snapshot record/i.test(opened.error ?? "");
  return {
    error: wrong
      ? `This folder holds copies sealed with a different passphrase: ${newest.artifact}.meta.json does not open with it. Use the passphrase they were sealed with, or choose a new folder.`
      : `The copies already in the folder could not be opened to check the passphrase (${newest.artifact}.meta.json: ${opened.error}).`,
    artifact: newest.artifact,
    listed,
  };
}
const readSealedConfig = async (secretsDirectory) => {
  const config = await readFile(configPath(secretsDirectory), "utf8").catch(() => { throw new Error("Save the cloud destination first"); });
  if (!isSealedConfig(config)) throw new Error("The cloud destination was saved without an encryption passphrase. Set it again with one first.");
  return config;
};

/**
 * Create the destination folder and list it, proving the credentials work; then prove the sealed remote works both ways
 * (M91): a small marker written through it and read back, and, when sealed copies are already there, the newest machine
 * snapshot's record decrypted with the saved passphrase. A rebuilt server given a passphrase that differs by a letter
 * passes the round trip (it seals and opens with the same wrong one); only reading an existing copy catches it.
 */
export async function backupCloudTest(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone, randomToken = () => randomBytes(16).toString("hex") } = {}) {
  const destination = normalizeCloudDestination(parameters);
  await requireRclone(rclone);
  const config = await readFile(configPath(secretsDirectory), "utf8").catch(() => { throw new Error("Save the cloud destination first"); });
  const target = cloudTarget(destination);
  const common = commonFlags(secretsDirectory);
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
  if (!isSealedConfig(config)) return { reachable: true, writable: true, target, entries, freeBytes, sealed: false, sealedRoundTrip: null, existingCopiesReadable: null, newestSnapshot: null };

  // The round trip: what goes in through the sealed remote comes back out the same. One fixed name, overwritten each test.
  const marker = `${sealedTarget()}.boxpilot-readback`;
  const token = randomToken();
  log?.(`$ rclone rcat ${marker}, then rclone cat it back`, "stdout");
  const wrote = await run(rclone, [...common, "rcat", marker], { timeout: 120_000, input: token });
  if (!wrote.ok) throw new Error(`Could not write through the encrypted remote: ${tail(wrote.stderr) || "rclone failed"}`);
  const readBack = await run(rclone, [...common, "cat", marker], { timeout: 120_000 });
  if (!readBack.ok) throw new Error(`Could not read back through the encrypted remote: ${tail(readBack.stderr) || "rclone failed"}`);
  if (readBack.stdout.trim() !== token) throw new Error("What was written through the encrypted remote did not read back the same, so copies made through it could not be trusted. Set the destination again.");

  // The copies already there: the newest snapshot's record, opened with the saved passphrase.
  const snapshots = await sealedSnapshots(run, rclone, common);
  if (snapshots.entries === null) throw new Error(`Could not list the encrypted copies: ${snapshots.error}`);
  const newest = snapshots.entries.find((entry) => entry.hasMeta) ?? null;
  if (newest) {
    const opened = await readSealedMeta(run, rclone, common, newest.artifact);
    if (!opened.meta) throw new Error(`The copies already in the bucket do not open with the saved passphrase (${newest.artifact}: ${opened.error}). If this server was rebuilt, set the destination again with the passphrase you used before.`);
    log?.(`Read ${newest.artifact}.meta.json back through the encrypted remote: the saved passphrase opens the copies there`, "stdout");
  } else log?.("No machine snapshot is in the bucket yet, so only the round trip was checked", "stdout");
  return { reachable: true, writable: true, target, entries, freeBytes, sealed: true, sealedRoundTrip: true, existingCopiesReadable: newest ? true : null, newestSnapshot: newest?.artifact ?? null };
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
  // Before anything is copied (M91): the copies already there must open with the saved passphrase. Copying compares
  // sizes, so under another passphrase every name already there would stay as it is and only new ones would be sealed
  // with this one, and the read-back afterwards would prove only a copy this server had just written.
  log?.(`$ rclone cat ${target}${sealedSnapshotFolder}/<newest>.meta.json, before copying`, "stdout");
  const seal = await existingSeal(run, rclone, commonFlags(secretsDirectory));
  if (seal.error) throw new Error(`${seal.error} Nothing was copied.`);
  if (seal.artifact) log?.(`Opened ${seal.artifact}.meta.json, already in the bucket, with the saved passphrase`, "stdout");
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
  const readBack = await readBackNewestSnapshot({ run, log, rclone, secretsDirectory, sources, mirrored, now, alreadyThere: new Set(seal.listed) });
  const warnings = readBack.ok === false ? [`The newest machine snapshot could not be read back from the bucket: ${readBack.error}`] : [];
  // existingCopy: the copy already in the bucket that was opened before copying, the one proof here of a copy this run did not write.
  return { synced: true, encrypted: true, destination: `${cloudTarget(destination)}/sealed`, completedAt, mirrored, filesTransferred, bytesTransferred: mirrored.map((entry) => entry.bytesTransferred).filter(Boolean).join(" + ") || null, errors, existingCopy: seal.artifact ? { artifact: seal.artifact, opened: true } : null, readBack, ...(warnings.length ? { warnings } : {}), boundary: { deletesPerformed: false, checksumVerified: false, readBackVerified: readBack.ok === true } };
}

/** The newest machine snapshot in a local folder that has its record beside it, with that record; null when there is none. */
async function newestLocalSnapshot(root) {
  const names = (await readdir(root).catch(() => [])).filter((name) => snapshotNamePattern.test(name)).sort().reverse();
  for (const artifact of names) {
    const meta = parseSnapshotMeta(await readFile(path.join(root, `${artifact}.meta.json`), "utf8").catch(() => null), artifact);
    if (meta) return { artifact, meta };
  }
  return null;
}

/**
 * After a mirror (M91): read the newest machine snapshot back through the sealed remote and compare it with the one here.
 * Its record is decrypted and must name the same checksum; then the archive itself is downloaded, decrypted and hashed
 * (`rclone hashsum sha256 --download`), and must match. That is the copy a rebuild would start from, so this is the one
 * proof that matters: right passphrase, working crypt settings, and bytes in the bucket that open to the archive written
 * here. `cryptcheck` was the other way, but it needs the provider's own hash of each object, which WebDAV does not keep
 * and S3 does not give for a multipart upload, so it could not prove the large files on half the providers. A snapshot
 * holds settings and the database, not app data, so downloading the newest one is a bounded cost. Never throws: the
 * mirror itself succeeded, and a failure here is the job's warning and a health alert (evaluateCloudReadBack).
 */
async function readBackNewestSnapshot({ run, log, rclone, secretsDirectory, sources, mirrored, now, alreadyThere = new Set() }) {
  const at = () => now().toISOString();
  const source = sources.find((entry) => entry.name === "machine-snapshots");
  if (!source || !mirrored.some((entry) => entry.name === "machine-snapshots")) return { ok: null, checkedAt: at(), artifact: null, reason: "No machine snapshot was mirrored, so there was none to read back." };
  const local = await newestLocalSnapshot(source.root);
  if (!local) return { ok: null, checkedAt: at(), artifact: null, reason: "No machine snapshot with its record is here, so there was none to read back." };
  const { artifact, meta } = local;
  const common = commonFlags(secretsDirectory, "10m");
  const failed = (error) => { log?.(`Read-back of ${artifact} failed: ${error}`, "stderr"); return { ok: false, checkedAt: at(), artifact, error }; };
  log?.(`$ rclone cat ${sealedTarget()}${sealedSnapshotFolder}/${artifact}.meta.json`, "stdout");
  const opened = await readSealedMeta(run, rclone, common, artifact);
  if (!opened.meta) return failed(`its record did not open: ${opened.error}`);
  if (opened.meta.checksumSha256 !== meta.checksumSha256) return failed("the record in the bucket names a different checksum from the one here");
  log?.(`$ rclone hashsum sha256 --download ${sealedTarget()}${sealedSnapshotFolder}/${artifact}`, "stdout");
  const hashed = await run(rclone, [...common, "hashsum", "sha256", "--download", `${sealedTarget()}${sealedSnapshotFolder}/${artifact}`], { timeout: 2 * 60 * 60_000 });
  if (!hashed.ok) return failed(`it did not download and decrypt: ${tail(hashed.stderr) || "rclone failed"}`);
  const sum = hashed.stdout.match(/^([a-f0-9]{64})\s/m)?.[1] ?? null;
  if (!sum) return failed("rclone did not report its checksum");
  if (sum !== meta.checksumSha256) return failed("the archive in the bucket decrypts to different bytes from the one here");
  // Said, since a copy this run uploaded proves this run's sealing, and only one already there proves the old copies open.
  const wasThere = alreadyThere.has(artifact);
  log?.(`Read ${artifact} back from the bucket: it decrypts to the archive here (sha256 ${sum.slice(0, 12)}…); ${wasThere ? "it was in the bucket before this mirror" : "this mirror uploaded it"}`, "stdout");
  return { ok: true, verifiedAt: at(), artifact, checksumSha256: sum, uploadedThisRun: !wasThere };
}

/**
 * The machine snapshots in the bucket (M91), newest first: what a rebuilt server can fetch. Read through the sealed
 * remote, so the names are the archives' own; `local` says one is already in the snapshot store here.
 */
export async function backupCloudSnapshots(_parameters = {}, { run = fixedRun, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone, snapshotRoot = defaults.snapshotRoot, limit = 50 } = {}) {
  await requireRclone(rclone);
  await readSealedConfig(secretsDirectory);
  const listed = await sealedSnapshots(run, rclone, commonFlags(secretsDirectory));
  if (listed.entries === null) throw new Error(`Could not list the encrypted copies: ${listed.error}`);
  const snapshots = [];
  for (const entry of listed.entries.slice(0, limit)) {
    const here = await stat(path.join(snapshotRoot, entry.artifact)).then(() => true, () => false);
    snapshots.push({ ...entry, local: here });
  }
  return { snapshots, total: listed.entries.length };
}

/** An app id as the catalog names its folder, and an app backup's archive name (app-backups.mjs). */
const appIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const appBackupNamePattern = /^\d{8}T\d{6}Z\.tar\.gz$/;
/** How many of an app's newest archives are looked at for one a restore would take as its data. */
const appCandidatesRead = 10;
/** Kept free beyond what a fetch brings down, so a fetch is never what fills the disk a restore is about to need. */
const fetchReserveBytes = 256 * 1024 ** 2;

/** An app backup's record (`<stamp>.json`, app-backups.mjs) when it names a checksum and fits the archive beside it. */
function parseAppRecord(text, id, name) {
  let record;
  try { record = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!record || typeof record !== "object" || typeof record.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.checksumSha256)) return null;
  if (record.artifact !== undefined && record.artifact !== name) return null;
  if (record.id !== undefined && record.id !== id) return null;
  return record;
}

/**
 * Why a restore would not take an archive with this record as the app's data, or null when it would: the rule of
 * machine-snapshot-helper's unusableBecause, as far as a record goes. Never a restore's safety copy, nor a backup of the
 * app a snapshot restore had installed without its data; and one dated after the snapshot only with a record this
 * release writes (recordVersion 2), which says it is neither. Fetching one the restore passes over would leave the app
 * empty all the same, so the next older one is fetched instead.
 */
function notTheAppsData(record, name, takenAt) {
  if (record.safetyCopy) return "a restore's safety copy";
  if (record.snapshotRestore && typeof record.snapshotRestore === "object" && !record.snapshotRestore.dataFrom) return "a backup of the app installed without its data";
  if (takenAt && name.slice(0, 16) > takenAt && !(Number(record.recordVersion) >= 2)) return "taken after the snapshot by an earlier BoxPilot, whose record cannot say it is the app's data";
  return null;
}

/**
 * Which of an app's archives in the bucket to fetch: the newest that has a record naming its checksum (the restore
 * trusts no archive without one) and that a restore would take as the app's data (notTheAppsData). `here` when that one
 * is already in the store here. `takenAt` is the snapshot's stamp. Never throws.
 */
async function planAppArchive(run, rclone, common, id, appRoot, takenAt) {
  const folder = `${sealedTarget()}application-backups/${id}`;
  const listed = await run(rclone, [...common, "lsjson", "--files-only", folder], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (!listed.ok) {
    if (/directory not found/i.test(listed.stderr)) return { id, status: "none", reason: "No backup of it is in the bucket." };
    return { id, status: "failed", reason: `Its backups could not be listed: ${tail(listed.stderr) || "rclone failed"}` };
  }
  let rows;
  try { rows = JSON.parse(listed.stdout || "[]"); } catch { rows = null; }
  if (!Array.isArray(rows)) return { id, status: "failed", reason: "rclone answered with something that is not a listing" };
  const names = new Set(rows.map((row) => row?.Name).filter((name) => typeof name === "string"));
  const archives = [...names].filter((name) => appBackupNamePattern.test(name)).sort().reverse();
  const recorded = archives.filter((name) => names.has(name.replace(/\.tar\.gz$/, ".json")));
  if (!recorded.length) return { id, status: "none", reason: archives.length ? "Its backups in the bucket have no record with a checksum, so none could be checked." : "No backup of it is in the bucket." };
  let lastProblem = null;
  const passedOver = [];
  for (const name of recorded.slice(0, appCandidatesRead)) {
    const read = await run(rclone, [...common, "cat", `${folder}/${name.replace(/\.tar\.gz$/, ".json")}`], { timeout: 120_000 });
    const record = read.ok ? parseAppRecord(read.stdout, id, name) : null;
    if (!record) { lastProblem = `the record of ${name} ${read.ok ? "does not name a checksum for it" : `did not open: ${tail(read.stderr) || "rclone failed"}`}`; continue; }
    const not = notTheAppsData(record, name, takenAt);
    if (not) { passedOver.push(`${name} (${not})`); continue; }
    if (await stat(path.join(appRoot, id, name)).then(() => true, () => false)) return { id, status: "here", archive: name, reason: "Its newest backup in the bucket is already here." };
    const row = rows.find((entry) => entry?.Name === name);
    const sizeBytes = Number.isFinite(record.sizeBytes) && record.sizeBytes >= 0 ? record.sizeBytes : Number.isFinite(row?.Size) && row.Size >= 0 ? row.Size : null;
    return { id, status: "planned", archive: name, record, sizeBytes, folder };
  }
  if (lastProblem) return { id, status: "failed", reason: `No backup of it could be checked: ${lastProblem}.` };
  return { id, status: "none", reason: `None of its newest ${passedOver.length} backup(s) in the bucket is one a restore would take as its data: ${passedOver.join("; ")}.` };
}

/**
 * Download one file from the sealed remote beside where it goes (`<name>.partial`, which no mirror copies and no listing
 * shows), check it against the checksum its record names, write the record, then rename it into place: the stores list
 * archives, and one listed without its record could not be verified. Throws with the partial removed.
 */
async function fetchVerified({ run, rclone, common, log, source, finalPath, recordPath, record, expectedBytes }) {
  const partial = `${finalPath}.partial`;
  await rm(partial, { force: true });
  log?.(`$ rclone copyto ${source} ${partial}`, "stdout");
  const copied = await run(rclone, [...common, "copyto", source, partial], { timeout: 4 * 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (!copied.ok) { await rm(partial, { force: true }); throw new Error(`the download failed: ${tail(copied.stderr) || "rclone failed"}`); }
  const sum = await sha256File(partial).catch(() => null);
  const size = await stat(partial).then((info) => info.size, () => null);
  if (sum !== record.checksumSha256 || (expectedBytes !== null && size !== expectedBytes)) {
    await rm(partial, { force: true });
    throw new Error("it came down, but it does not match the checksum its record names, so it was discarded");
  }
  await chmod(partial, 0o600);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(partial, finalPath);
  return { sizeBytes: size, checksumSha256: sum };
}

/** The filesystem a folder is on, to add up what lands on each. */
const deviceOf = (directory) => stat(directory).then((info) => info.dev, () => directory);

/**
 * Fetch one machine snapshot from the bucket (M91), and each app's newest backup with it, into this server's own stores,
 * where the ordinary restore takes over. A snapshot holds the apps' settings, not their data: its restore looks for the
 * data on this server, the backup drive's mirror and the snapshot's drive, so with the cloud the only copy left, a
 * snapshot fetched alone restored every app empty. So for each app the snapshot lists, its newest backup in the bucket
 * that has a record with a checksum (not a restore's safety copy) comes down into the application backup store too.
 * Everything is checked first: the snapshot's record is decrypted (the crypt format authenticates every block under the
 * passphrase, so a record that opens is one this owner sealed), each app's record likewise, and the disk must hold all
 * of it with a margin, or nothing is fetched. Then each file goes through `.partial`, its checksum, and a rename after
 * its record. Never replaces a file already here: a snapshot already here is kept and only the app backups missing
 * here are fetched, so running it again finishes a fetch an app's download failed in. One app failing does not undo
 * the rest; the result says per app what came down, or why not.
 */
export async function backupCloudFetch(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, rclone = defaults.rclone, snapshotRoot = defaults.snapshotRoot, applicationBackupRoot = defaults.applicationBackupRoot, freeBytesOf = freeBytesAt } = {}) {
  const artifact = parameters?.artifact;
  if (typeof artifact !== "string" || !snapshotNamePattern.test(artifact)) throw new Error("Name a machine snapshot (machine-snapshot-<time>-<id>.tar.gz)");
  await requireRclone(rclone);
  await readSealedConfig(secretsDirectory);
  const root = path.resolve(snapshotRoot);
  const appRoot = path.resolve(applicationBackupRoot);
  const finalPath = path.join(root, artifact);
  const metaPath = `${finalPath}.meta.json`;
  const snapshotHere = await stat(finalPath).then(() => true, () => false);
  const common = commonFlags(secretsDirectory, "10m");
  log?.(`$ rclone cat ${sealedTarget()}${sealedSnapshotFolder}/${artifact}.meta.json`, "stdout");
  const opened = await readSealedMeta(run, rclone, common, artifact);
  if (!opened.meta) throw new Error(`The record of ${artifact} could not be read from the bucket (${opened.error}), so the archive could not be checked. Nothing was fetched.`);
  const { meta } = opened;
  const expectedBytes = Number.isFinite(meta.sizeBytes) && meta.sizeBytes >= 0 ? meta.sizeBytes : null;

  // What the snapshot's apps need, read before anything is downloaded.
  const takenAt = /^machine-snapshot-(\d{8}T\d{6}Z)-/.exec(artifact)?.[1] ?? null;
  const ids = [...new Set((Array.isArray(meta.contents?.apps) ? meta.contents.apps : []).map((app) => app?.id).filter((id) => typeof id === "string" && appIdPattern.test(id)))];
  const plans = [];
  for (const id of ids) {
    log?.(`$ rclone lsjson ${sealedTarget()}application-backups/${id}`, "stdout");
    plans.push(await planAppArchive(run, rclone, common, id, appRoot, takenAt));
  }
  const planned = plans.filter((plan) => plan.status === "planned");

  await mkdir(root, { recursive: true, mode: 0o700 });
  if (planned.length) await mkdir(appRoot, { recursive: true, mode: 0o700 });
  // Room for all of it with a margin, added up per filesystem, so a fetch cannot be what fills the disk.
  const needs = [
    ...(snapshotHere ? [] : [{ directory: root, bytes: expectedBytes ?? 0 }]),
    ...planned.map((plan) => ({ directory: appRoot, bytes: plan.sizeBytes ?? 0 })),
  ];
  const byDevice = new Map();
  for (const need of needs) {
    const device = await deviceOf(need.directory);
    const entry = byDevice.get(device) ?? { directory: need.directory, bytes: 0 };
    entry.bytes += need.bytes;
    byDevice.set(device, entry);
  }
  for (const { directory, bytes } of byDevice.values()) {
    const free = await freeBytesOf(directory).catch(() => null);
    if (free !== null && free < bytes + fetchReserveBytes) throw new Error(`${snapshotHere ? "" : `${artifact} and `}the newest backup of ${planned.length} app(s) need ${Math.ceil(bytes / 1024 ** 2)} MiB and ${directory} has ${Math.floor(free / 1024 ** 2)} MiB free. Nothing was fetched.`);
  }

  let size = null; let sum = null;
  if (snapshotHere) {
    log?.(`${artifact} is already in the snapshot store here; it is kept as it is, and only the app backups missing here are fetched`, "stdout");
  } else {
    try {
      ({ sizeBytes: size, checksumSha256: sum } = await fetchVerified({ run, rclone, common, log, source: `${sealedTarget()}${sealedSnapshotFolder}/${artifact}`, finalPath, recordPath: metaPath, record: meta, expectedBytes }));
    } catch (error) {
      throw new Error(`${artifact}: ${error instanceof Error ? error.message : String(error)}. Nothing was placed in the snapshot store.`);
    }
    log?.(`Fetched ${artifact} (${size} bytes, sha256 ${sum.slice(0, 12)}…) into ${root}`, "stdout");
  }

  const apps = [];
  for (const plan of plans) {
    if (plan.status !== "planned") { apps.push({ id: plan.id, status: plan.status, archive: plan.archive ?? null, reason: plan.reason }); continue; }
    const directory = path.join(appRoot, plan.id);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const fetched = await fetchVerified({ run, rclone, common, log, source: `${plan.folder}/${plan.archive}`, finalPath: path.join(directory, plan.archive), recordPath: path.join(directory, plan.archive.replace(/\.tar\.gz$/, ".json")), record: plan.record, expectedBytes: Number.isFinite(plan.record.sizeBytes) ? plan.record.sizeBytes : null });
      log?.(`Fetched ${plan.id}'s backup ${plan.archive} (${fetched.sizeBytes} bytes) into ${directory}`, "stdout");
      apps.push({ id: plan.id, status: "fetched", archive: plan.archive, sizeBytes: fetched.sizeBytes, checksumSha256: fetched.checksumSha256, reason: null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log?.(`${plan.id}'s backup ${plan.archive} was not fetched: ${reason}`, "stderr");
      apps.push({ id: plan.id, status: "failed", archive: plan.archive, reason: `${plan.archive}: ${reason}` });
    }
  }
  const failed = apps.filter((app) => app.status === "failed");
  const warnings = failed.map((app) => `${app.id}: ${app.reason} Run the fetch again to retry it; a restore brings ${app.id} back without its data until then.`);
  log?.(`Restore ${artifact} from the Restore tab: ${apps.filter((app) => app.status === "fetched" || app.status === "here").length} of ${apps.length} app(s) have their newest backup here`, "stdout");
  return {
    fetched: !snapshotHere || apps.some((app) => app.status === "fetched"),
    artifact, root, snapshot: snapshotHere ? "here" : "fetched",
    sizeBytes: snapshotHere ? null : size, checksumSha256: snapshotHere ? null : sum, verified: true,
    createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
    applicationBackupRoot: appRoot, apps, appsFetched: apps.filter((app) => app.status === "fetched").length,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Free bytes on the filesystem holding a folder. */
async function freeBytesAt(directory) {
  const info = await statfs(directory);
  return Number(info.bavail) * Number(info.bsize);
}

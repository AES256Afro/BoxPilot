import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { normalizeDestination } from "../backup-destination.mjs";

/**
 * Off-box backup mirror over SSH (root side, runs in boxpilot-run@ with network).
 * The key pair lives under /etc/boxpilot/secrets and never leaves the server; the operator
 * authorizes its public half on the destination. The first test pins the host key
 * (accept-new); every later connection requires that exact key.
 */

const defaults = {
  secretsDirectory: "/etc/boxpilot/secrets",
  sources: [
    { name: "controller-backups", root: process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller" },
    { name: "application-backups", root: path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog") },
    { name: "machine-snapshots", root: process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots" },
  ],
};

function paths(secretsDirectory) {
  return { key: path.join(secretsDirectory, "backup-mirror-key"), publicKey: path.join(secretsDirectory, "backup-mirror-key.pub"), knownHosts: path.join(secretsDirectory, "backup-mirror-known_hosts") };
}

function sshOptions(files, destination, { strict }) {
  return ["-i", files.key, "-p", String(destination.port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", `StrictHostKeyChecking=${strict ? "yes" : "accept-new"}`, "-o", `UserKnownHostsFile=${files.knownHosts}`, "-o", "IdentitiesOnly=yes"];
}

async function fingerprint(run, publicKeyPath) {
  const result = await run("/usr/bin/ssh-keygen", ["-lf", publicKeyPath], { timeout: 15_000 });
  return result.ok ? result.stdout.trim().split(/\s+/)[1] ?? null : null;
}

/** Create the mirror key pair once; later calls just report the public key. */
export async function backupRemoteKeygen(_parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory } = {}) {
  const files = paths(secretsDirectory);
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await stat(files.key);
  } catch {
    log?.("$ ssh-keygen -t ed25519 -f backup-mirror-key (no passphrase; the key never leaves this server)", "stdout");
    const result = await run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "boxpilot-backup-mirror", "-f", files.key], { timeout: 30_000 });
    if (!result.ok) throw new Error(`ssh-keygen failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
    created = true;
  }
  await chmod(files.key, 0o600);
  const publicKey = (await readFile(files.publicKey, "utf8")).trim();
  return { created, publicKey, fingerprint: await fingerprint(run, files.publicKey) };
}

/** Connect, create the destination directory, and report free space. Pins the host key on first use. */
export async function backupRemoteTest(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory } = {}) {
  const destination = normalizeDestination(parameters);
  const files = paths(secretsDirectory);
  await stat(files.key).catch(() => { throw new Error("Generate the mirror key first"); });
  log?.(`$ ssh ${destination.user}@${destination.host} -p ${destination.port} mkdir -p ${destination.path} && df -Pk ${destination.path}`, "stdout");
  const result = await run("/usr/bin/ssh", [...sshOptions(files, destination, { strict: false }), `${destination.user}@${destination.host}`, `mkdir -p ${destination.path} && test -w ${destination.path} && df -Pk ${destination.path} | tail -n 1`], { timeout: 60_000 });
  if (!result.ok) throw new Error(`Could not use ${destination.user}@${destination.host}:${destination.path}: ${result.stderr.trim().split("\n").slice(-2).join(" ") || "ssh failed"}`);
  const columns = result.stdout.trim().split(/\s+/);
  const availableKiB = Number.parseInt(columns[3] ?? "", 10);
  const hostKey = await run("/usr/bin/ssh-keygen", ["-lF", destination.port === 22 ? destination.host : `[${destination.host}]:${destination.port}`, "-f", files.knownHosts], { timeout: 15_000 });
  const hostKeyFingerprint = hostKey.ok ? hostKey.stdout.split("\n").find((line) => /SHA256:/.test(line))?.trim().split(/\s+/).find((part) => part.startsWith("SHA256:")) ?? null : null;
  log?.(`Destination is writable${Number.isFinite(availableKiB) ? `; ${Math.round(availableKiB / 1024)} MiB free` : ""}; host key ${hostKeyFingerprint ?? "pinned"}`, "stdout");
  return { reachable: true, writable: true, freeBytes: Number.isFinite(availableKiB) ? availableKiB * 1024 : null, hostKeyFingerprint, destination: `${destination.user}@${destination.host}:${destination.path}` };
}

function parseRsyncStats(stdout) {
  const number = (label) => { const match = stdout.match(new RegExp(`${label}: ([\\d,]+)`)); return match ? Number.parseInt(match[1].replaceAll(",", ""), 10) : 0; };
  return { filesTransferred: number("Number of regular files transferred"), bytesTransferred: number("Total transferred file size") };
}

/** Push every local backup root to the destination with checksum verification. Never deletes remotely. */
export async function backupRemoteSync(parameters = {}, { run = fixedRun, log = null, secretsDirectory = defaults.secretsDirectory, sources = defaults.sources, now = () => new Date() } = {}) {
  const destination = normalizeDestination(parameters);
  const files = paths(secretsDirectory);
  await stat(files.key).catch(() => { throw new Error("Generate the mirror key first"); });
  await stat(files.knownHosts).catch(() => { throw new Error("Test the destination first so its host key is pinned"); });
  const rsync = await stat("/usr/bin/rsync").then(() => "/usr/bin/rsync", () => null);
  if (!rsync) throw new Error("rsync is not installed on this server; install it from the Backups page first");
  const transport = ["ssh", ...sshOptions(files, destination, { strict: true })].join(" ");
  const mirrored = [];
  let filesTransferred = 0; let bytesTransferred = 0;
  for (const source of sources) {
    const exists = await stat(source.root).then((info) => info.isDirectory(), () => false);
    if (!exists) continue;
    const target = `${destination.user}@${destination.host}:${destination.path}/${source.name}/`;
    log?.(`$ rsync -a --checksum --mkpath ${source.root}/ ${target}`, "stdout");
    const result = await run(rsync, ["-a", "--checksum", "--partial", "--mkpath", "--stats", "--timeout=600", "-e", transport, `${source.root}/`, target], { timeout: 6 * 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (!result.ok) throw new Error(`rsync failed for ${source.name}: ${result.stderr.trim().split("\n").slice(-2).join(" ")}`);
    const stats = parseRsyncStats(result.stdout);
    filesTransferred += stats.filesTransferred; bytesTransferred += stats.bytesTransferred;
    mirrored.push({ name: source.name, ...stats });
  }
  const completedAt = now().toISOString();
  log?.(`Mirrored ${mirrored.length} backup root(s): ${filesTransferred} file(s), ${bytesTransferred} bytes transferred`, "stdout");
  return { synced: true, destination: `${destination.user}@${destination.host}:${destination.path}`, completedAt, mirrored, filesTransferred, bytesTransferred, boundary: { deletesPerformed: false, checksumVerified: true } };
}

export const backupRemoteInternals = { parseRsyncStats, paths };

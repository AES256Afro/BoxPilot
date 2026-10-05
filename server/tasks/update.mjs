import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { productVersion } from "../version.mjs";
import { defaultEnvPath, readWebEnv } from "./firewall.mjs";

/**
 * Self-update (root side, runs inside boxpilot-run@ with network). Re-checks that the release
 * tag still points at the commit the owner reviewed, then hands the existing upgrade script to
 * a detached transient unit: it downloads the tag, builds it, swaps /opt/boxpilot, restarts
 * both services, and rolls back if the health check does not report the new version. The task
 * returns as soon as that unit is running, so the job finishes before BoxPilot restarts.
 */

export const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const shaPattern = /^[a-f0-9]{40}$/;
const repository = process.env.BOXPILOT_REPO ?? "AES256Afro/BoxPilot";
/** The upgrade script's lock (M36): held by a running upgrade for its whole run. */
export const upgradeLockPath = process.env.BOXPILOT_UPGRADE_LOCK ?? "/run/boxpilot-upgrade.lock";

/**
 * Whether an upgrade is running now, and which, from the script's own lock: `flock -n` exits 1 when
 * it is held. Null when none is. Anything else (no flock) says nothing either way and is left to the
 * script, which takes the same lock before it changes anything.
 */
/**
 * The web service's health check as this machine reaches it: the port its env file gives it, on
 * loopback unless it listens on one other address. The upgrade's check (and the doctor's) used to
 * be 127.0.0.1:8787 whatever the port.
 */
export function localHealthUrl({ webHost, webPort }) {
  const host = ["", "0.0.0.0", "::"].includes(webHost ?? "") ? "127.0.0.1" : webHost.includes(":") ? `[${webHost}]` : webHost;
  return `http://${host}:${webPort}/api/v1/health`;
}

export async function runningUpgrade({ run = fixedRun, lockPath = upgradeLockPath, read = readFile } = {}) {
  const probe = await run("/usr/bin/flock", ["-n", lockPath, "/bin/true"], { timeout: 10_000 });
  if (probe.ok || probe.code !== 1) return null;
  const holder = await read(lockPath, "utf8").then((text) => text.replace(/\s+/g, " ").trim()).catch(() => "");
  return holder || `it holds ${lockPath}`;
}

export async function systemUpdate({ tag, expectedCommit } = {}, {
  run = fixedRun,
  log = null,
  fetchImpl = globalThis.fetch,
  installDir = process.env.BOXPILOT_INSTALL_DIR ?? "/opt/boxpilot",
  stagingDirectory = "/run/boxpilot",
  nodeBinary = process.execPath,
  now = () => new Date(),
  lockPath = upgradeLockPath,
  envPath = defaultEnvPath,
} = {}) {
  if (typeof tag !== "string" || !releaseTagPattern.test(tag)) throw new Error("Release tag must look like v1.2.3");
  if (typeof expectedCommit !== "string" || !shaPattern.test(expectedCommit)) throw new Error("Expected commit must be a full SHA-1");

  log?.(`Checking that ${tag} still points at ${expectedCommit.slice(0, 12)}`, "stdout");
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(tag)}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `BoxPilot/${productVersion}`, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub could not resolve ${tag} (status ${response.status})`);
  const commit = await response.json();
  if (commit?.sha !== expectedCommit) throw new Error(`${tag} now points at ${String(commit?.sha ?? "unknown").slice(0, 12)}, not the reviewed ${expectedCommit.slice(0, 12)}; check the release again`);

  // Two updates two seconds apart left the owner's server with two previous trees and the service
  // started twice (M36). The script refuses a second run itself; this says so in the job instead of
  // starting a unit that would only refuse.
  const running = await runningUpgrade({ run, lockPath });
  if (running) throw new Error(`Another BoxPilot update is already running (${running}). Nothing was started; wait for it to finish, then check the version before updating again.`);

  const stamp = now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const scriptCopy = path.join(stagingDirectory, `update-${stamp}.sh`);
  await mkdir(stagingDirectory, { recursive: true });
  // Run a copy: the script replaces the directory it lives in.
  await copyFile(path.join(installDir, "scripts", "boxpilot-upgrade.sh"), scriptCopy);
  await chmod(scriptCopy, 0o700);

  const unit = `boxpilot-update-${stamp}`;
  // Where the new version must answer, from the service's env file. The script reads that file
  // itself now; this hands it over as well, so the check does not depend on which script is
  // installed. Without it, every update on a box installed with --port rolled back.
  const healthUrl = localHealthUrl(await readWebEnv({ envPath }));
  // The script downloads by the reviewed commit, not the tag, so a moved tag cannot swap the code in.
  log?.(`$ systemd-run --unit ${unit} /bin/sh ${scriptCopy} ${expectedCommit}`, "stdout");
  const started = await run("/usr/bin/systemd-run", ["--quiet", "--unit", unit, "--description", `BoxPilot update to ${tag}`, `--setenv=BOXPILOT_NODE_BIN=${nodeBinary}`, `--setenv=BOXPILOT_UPDATE_UNIT=${unit}`, `--setenv=BOXPILOT_HEALTH_URL=${healthUrl}`, "/bin/sh", scriptCopy, expectedCommit], { timeout: 30_000 });
  if (!started.ok) throw new Error(`Could not start the update unit: ${started.stderr.split("\n").slice(-2).join(" ")}`);
  log?.("Update unit started. BoxPilot restarts when the build finishes and rolls back on a failed health check.", "stdout");
  return { started: true, unit, tag, expectedCommit, fromVersion: productVersion, startedAt: now().toISOString() };
}

import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { productVersion } from "../version.mjs";

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

export async function systemUpdate({ tag, expectedCommit } = {}, {
  run = fixedRun,
  log = null,
  fetchImpl = globalThis.fetch,
  installDir = process.env.BOXPILOT_INSTALL_DIR ?? "/opt/boxpilot",
  stagingDirectory = "/run/boxpilot",
  nodeBinary = process.execPath,
  now = () => new Date(),
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

  const stamp = now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const scriptCopy = path.join(stagingDirectory, `update-${stamp}.sh`);
  await mkdir(stagingDirectory, { recursive: true });
  // Run a copy: the script replaces the directory it lives in.
  await copyFile(path.join(installDir, "scripts", "boxpilot-upgrade.sh"), scriptCopy);
  await chmod(scriptCopy, 0o700);

  const unit = `boxpilot-update-${stamp}`;
  // The script downloads by the reviewed commit, not the tag, so a moved tag cannot swap the code in.
  log?.(`$ systemd-run --unit ${unit} /bin/sh ${scriptCopy} ${expectedCommit}`, "stdout");
  const started = await run("/usr/bin/systemd-run", ["--quiet", "--unit", unit, "--description", `BoxPilot update to ${tag}`, `--setenv=BOXPILOT_NODE_BIN=${nodeBinary}`, "/bin/sh", scriptCopy, expectedCommit], { timeout: 30_000 });
  if (!started.ok) throw new Error(`Could not start the update unit: ${started.stderr.split("\n").slice(-2).join(" ")}`);
  log?.("Update unit started. BoxPilot restarts when the build finishes and rolls back on a failed health check.", "stdout");
  return { started: true, unit, tag, expectedCommit, fromVersion: productVersion, startedAt: now().toISOString() };
}

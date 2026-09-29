/**
 * Root tasks for the agents runtime (M37), run by scripts/boxpilot-run.mjs in boxpilot-run@.service,
 * which has the network and the rights these need. Root does only what needs root - the OpenMP
 * library Unsloth's llama.cpp links, the runner's system user, its state directory, the unit - and
 * everything that touches the runner's own files runs as the runner's user through runuser, so no
 * root process ever writes where a compromised runner could have planted a link.
 *
 * - agents.install         Unsloth, by its own installer (GGUF-only, no autostart) as the runner's
 *                          user, into the runner's state directory. The installer's SHA-256 and the
 *                          version it installed are kept; the runtime says when that version is not
 *                          the one the spike measured (models.mjs, testedUnslothVersion).
 * - agents.enable/disable  the capped runner unit, on or off.
 * - agents.model.download  a GGUF and its vision projector, checked byte for byte (download.mjs).
 * - agents.model.remove    a downloaded model that is not the one in use.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerUnit } from "../agents/caps.mjs";
import { agentsPaths, readModelParameters } from "../agents/host.mjs";
import { testedUnslothVersion } from "../agents/models.mjs";

const systemctl = "/usr/bin/systemctl";
const runuser = "/usr/sbin/runuser";
const installerUrl = "https://unsloth.ai/install.sh";
const downloadScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "boxpilot-agents-download.mjs");
const trustedInstallerHosts = /(^|\.)(unsloth\.ai|githubusercontent\.com|github\.com)$/;

async function ensureUser(run, paths) {
  const known = await run("/usr/bin/id", ["-u", paths.user], { timeout: 10_000 });
  if (known.ok) return false;
  const made = await run("/usr/sbin/useradd", ["--system", "--home-dir", paths.state, "--no-create-home", "--shell", "/usr/sbin/nologin", "--user-group", paths.user], { timeout: 30_000 });
  if (!made.ok) throw new Error(`Could not create the ${paths.user} user: ${made.stderr.split("\n").slice(-1)[0]}`);
  return true;
}

/** The runner's state directory, owned by the runner, as systemd's StateDirectory= makes it. */
async function ensureStateDirectory(run, paths) {
  const made = await run("/usr/bin/install", ["-d", "-o", paths.user, "-g", paths.user, "-m", "0750", paths.state], { timeout: 30_000 });
  if (!made.ok) throw new Error(`Could not make ${paths.state}`);
}

/** Run a program as the runner's user, with a clean environment of our choosing. */
const asRunner = (run, paths, command, args, options = {}) => run(runuser, ["-u", paths.user, "--", "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", `HOME=${paths.state}`, ...(options.env ?? []), command, ...args], { timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, ...(options.onLine ? { onLine: options.onLine } : {}) });

export async function agentsInstall(_parameters = {}, { log = () => {}, run, fetcher = fetch, paths = agentsPaths } = {}) {
  const apt = await run("/usr/bin/apt-get", ["install", "-y", "--no-install-recommends", "libgomp1", "ca-certificates", "curl"], { timeout: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } });
  if (!apt.ok) throw new Error("Could not install the OpenMP library Unsloth's llama.cpp needs (libgomp1)");
  const created = await ensureUser(run, paths);
  log(created ? `Created the ${paths.user} user` : `The ${paths.user} user exists`, "stdout");
  await ensureStateDirectory(run, paths);

  const response = await fetcher(installerUrl, { redirect: "follow", signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "BoxPilot agents runtime" } });
  const final = new URL(response.url || installerUrl);
  if (final.protocol !== "https:" || !trustedInstallerHosts.test(final.hostname)) throw new Error(`Refused the installer from ${final.hostname}`);
  if (!response.ok) throw new Error(`${final.hostname} answered ${response.status}`);
  const script = await response.text();
  if (script.length > 1024 * 1024 || !script.startsWith("#!")) throw new Error("The Unsloth installer did not look like a shell script");
  const sha256 = createHash("sha256").update(script).digest("hex");
  log(`Unsloth installer ${installerUrl}, SHA-256 ${sha256}`, "stdout");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "boxpilot-unsloth-"));
  const scriptPath = path.join(scratch, "install.sh");
  await writeFile(scriptPath, script, { mode: 0o644 });
  await chmod(scratch, 0o755);
  try {
    // As the runner's user, never as root: the installer then leaves the system alone, and the
    // compilers it would apt-install as root are not wanted (the prebuilt llama.cpp needs none).
    const installed = await asRunner(run, paths, "/bin/sh", [scriptPath], {
      env: ["UNSLOTH_NO_TORCH=1", "UNSLOTH_SKIP_AUTOSTART=1", `UNSLOTH_STUDIO_HOME=${paths.runtime}`],
      timeout: 45 * 60_000, onLine: (line) => log(line, "stdout"),
    });
    if (!installed.ok) throw new Error(`The Unsloth installer failed: ${String(installed.stderr).split("\n").filter(Boolean).slice(-2).join(" ")}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const binary = path.join(paths.runtime, "bin", "unsloth");
  const version = await asRunner(run, paths, binary, ["--version"], { env: [`UNSLOTH_STUDIO_HOME=${paths.runtime}`], timeout: 60_000 });
  if (!version.ok) throw new Error(`Unsloth was installed but ${binary} does not answer`);
  const installedVersion = (version.stdout.split("\n").pop() ?? "").replace(/[^A-Za-z0-9.+ -]/g, "").trim().slice(0, 60);
  const tested = installedVersion.includes(testedUnslothVersion);
  if (!tested) log(`Installed Unsloth ${installedVersion}; BoxPilot was measured with ${testedUnslothVersion}. It runs with --disable-tools and loopback only either way.`, "stderr");
  return { installed: true, version: installedVersion, testedVersion: testedUnslothVersion, tested, installerSha256: sha256, path: binary };
}

export async function agentsEnable(_parameters = {}, { log = () => {}, run, paths = agentsPaths } = {}) {
  const token = await stat(paths.token).catch(() => null);
  if (!token?.isFile()) throw new Error("Turn Agents on in the Agents section first: that makes the runner's key");
  const unit = await run(systemctl, ["cat", runnerUnit], { timeout: 15_000 });
  if (!unit.ok) throw new Error(`${runnerUnit} is not installed; upgrade BoxPilot to get it`);
  if (await ensureUser(run, paths)) log(`Created the ${paths.user} user`, "stdout");
  const started = await run(systemctl, ["enable", "--now", runnerUnit], { timeout: 90_000 });
  if (!started.ok) throw new Error(`systemctl could not start ${runnerUnit}: ${started.stderr.split("\n").slice(-2).join(" ")}`);
  const active = await run(systemctl, ["is-active", runnerUnit], { timeout: 15_000 });
  if (active.stdout.trim() !== "active") throw new Error(`${runnerUnit} did not stay running; journalctl -u ${runnerUnit} says why`);
  return { unit: runnerUnit, active: true };
}

export async function agentsDisable(_parameters = {}, { run } = {}) {
  const stopped = await run(systemctl, ["disable", "--now", runnerUnit], { timeout: 90_000 });
  if (!stopped.ok && !/not loaded|does not exist|No such file/i.test(stopped.stderr)) throw new Error(`systemctl could not stop ${runnerUnit}: ${stopped.stderr.split("\n").slice(-2).join(" ")}`);
  const active = await run(systemctl, ["is-active", runnerUnit], { timeout: 15_000 });
  return { unit: runnerUnit, active: active.stdout.trim() === "active" };
}

/** Hand a download or a removal to the runner's user, and read its answer from its last line. */
async function inRunnersCache(action, parameters, { log, run, paths, timeout }) {
  await ensureUser(run, paths);
  await ensureStateDirectory(run, paths);
  const lines = [];
  const result = await asRunner(run, paths, process.execPath, [downloadScript, action, paths.state, JSON.stringify(parameters)], {
    timeout,
    onLine: (line) => { lines.push(line); if (!line.startsWith("{")) log(line, "stdout"); },
  });
  const last = [...String(result.stdout ?? "").split("\n"), ...lines].reverse().find((line) => line.trim().startsWith("{"));
  let answer = null;
  try { answer = JSON.parse(last ?? "null"); } catch { answer = null; }
  if (!answer) throw new Error(`The ${action} did not finish: ${String(result.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" ") || "no answer"}`);
  if (!answer.ok) throw new Error(answer.error ?? `The ${action} failed`);
  return answer.result;
}

export async function agentsModelDownload(parameters = {}, { log = () => {}, run, paths = agentsPaths } = {}) {
  const model = readModelParameters(parameters);
  return inRunnersCache("download", { repo: model.repo, file: model.file, projector: model.projector }, { log, run, paths, timeout: 6 * 3600_000 });
}

export async function agentsModelRemove(parameters = {}, { log = () => {}, run, paths = agentsPaths } = {}) {
  const model = readModelParameters(parameters);
  if (parameters.current === `${model.repo}/${model.file}`) throw new Error("That is the model agents use now; switch to another first");
  return inRunnersCache("remove", { repo: model.repo, file: model.file, projector: model.projector, current: parameters.current ?? null }, { log, run, paths, timeout: 5 * 60_000 });
}

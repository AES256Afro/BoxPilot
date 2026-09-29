/**
 * Root tasks for the agents runtime (M37), run by scripts/boxpilot-run.mjs in boxpilot-run@.service,
 * which has the network and the rights these need: a system user, a directory under /opt, a unit
 * to enable, and downloads. Each checks its own parameters again.
 *
 * - agents.install         Unsloth, installed by its own installer as the unprivileged runner user
 *                          (never as root), into /opt/boxpilot-agents/unsloth, then made read-only
 *                          to that user. The installer's SHA-256 is kept in the result.
 * - agents.enable/disable  the capped runner unit, on or off.
 * - agents.model.download  a GGUF (and its vision projector) from huggingface.co into the runner's
 *                          Hugging Face cache, every byte checked against the SHA-256 Hugging Face
 *                          publishes for it, free space checked first.
 * - agents.model.remove    a downloaded model that is not the one in use.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readlink, rename, rm, stat, statfs, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runnerUnit } from "../agents/caps.mjs";
import { agentsPaths, cacheDirectory, cachedFile, readModelParameters } from "../agents/host.mjs";

const systemctl = "/usr/bin/systemctl";
const installerUrl = "https://unsloth.ai/install.sh";
const trustedHosts = /(^|\.)(huggingface\.co|hf\.co|unsloth\.ai|githubusercontent\.com|github\.com)$/;

async function ensureUser(run, paths) {
  const known = await run("/usr/bin/id", ["-u", paths.user], { timeout: 10_000 });
  if (known.ok) return false;
  const made = await run("/usr/sbin/useradd", ["--system", "--home-dir", paths.state, "--no-create-home", "--shell", "/usr/sbin/nologin", "--user-group", paths.user], { timeout: 30_000 });
  if (!made.ok) throw new Error(`Could not create the ${paths.user} user: ${made.stderr.split("\n").slice(-1)[0]}`);
  return true;
}

/** Fetch one URL over HTTPS from a host this task trusts, following redirects only to such hosts. */
async function fetchTrusted(url, { fetcher = fetch, timeoutMs = 60_000 } = {}) {
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "BoxPilot agents runtime" } });
  const final = new URL(response.url || url);
  if (final.protocol !== "https:" || !trustedHosts.test(final.hostname)) throw new Error(`Refused a download from ${final.hostname}`);
  if (!response.ok) throw new Error(`${final.hostname} answered ${response.status}`);
  return response;
}

export async function agentsInstall(_parameters = {}, { log = () => {}, run, fetcher = fetch, paths = agentsPaths } = {}) {
  const apt = await run("/usr/bin/apt-get", ["install", "-y", "--no-install-recommends", "libgomp1", "ca-certificates", "curl"], { timeout: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } });
  if (!apt.ok) throw new Error("Could not install the OpenMP runtime Unsloth's llama.cpp needs (libgomp1)");
  const created = await ensureUser(run, paths);
  log(created ? `Created the ${paths.user} user` : `The ${paths.user} user exists`, "stdout");
  await mkdir(paths.home, { recursive: true, mode: 0o755 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o755 });
  const workHome = path.join(paths.home, ".install-home");
  await mkdir(workHome, { recursive: true, mode: 0o700 });
  for (const target of [paths.runtime, workHome]) {
    const owned = await run("/usr/bin/chown", ["-R", `${paths.user}:${paths.user}`, target], { timeout: 60_000 });
    if (!owned.ok) throw new Error(`Could not hand ${target} to ${paths.user} for the install`);
  }

  const response = await fetchTrusted(installerUrl, { fetcher });
  const script = await response.text();
  if (script.length > 512 * 1024 || !script.startsWith("#!")) throw new Error("The Unsloth installer did not look like a shell script");
  const sha256 = createHash("sha256").update(script).digest("hex");
  log(`Unsloth installer ${installerUrl}, SHA-256 ${sha256}`, "stdout");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "boxpilot-unsloth-"));
  const scriptPath = path.join(scratch, "install.sh");
  await writeFile(scriptPath, script, { mode: 0o644 });
  await chmod(scratch, 0o755);
  try {
    // As the runner's user, never as root: the installer then leaves the system alone.
    const installed = await run("/usr/sbin/runuser", ["-u", paths.user, "--", "/usr/bin/env", `HOME=${workHome}`, "UNSLOTH_NO_TORCH=1", "UNSLOTH_SKIP_AUTOSTART=1", `UNSLOTH_STUDIO_HOME=${paths.runtime}`, "/bin/sh", scriptPath], { timeout: 45 * 60_000, maxBuffer: 16 * 1024 * 1024, onLine: (line) => log(line, "stdout") });
    if (!installed.ok) throw new Error(`The Unsloth installer failed: ${String(installed.stderr).split("\n").filter(Boolean).slice(-2).join(" ")}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const binary = path.join(paths.runtime, "bin", "unsloth");
  const version = await run(binary, ["--version"], { timeout: 60_000 });
  if (!version.ok) throw new Error(`Unsloth was installed but ${binary} does not answer`);
  // Read-only to the runner from here on: it runs Unsloth, it cannot change it.
  await run("/usr/bin/chown", ["-R", "root:root", paths.runtime], { timeout: 5 * 60_000 });
  await run("/usr/bin/chmod", ["-R", "go-w", paths.runtime], { timeout: 5 * 60_000 });
  await rm(workHome, { recursive: true, force: true });
  return { installed: true, version: version.stdout.split("\n").pop().trim().slice(0, 80), installerSha256: sha256, path: binary };
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

/** Stream a URL to a file, hashing as it goes; the file is kept only when size and hash match. */
async function downloadVerified(url, target, { size, sha256, fetcher, log, label }) {
  const response = await fetchTrusted(url, { fetcher, timeoutMs: 6 * 3600_000 });
  if (!response.body) throw new Error(`No body for ${label}`);
  const partial = `${target}.incomplete`;
  const hash = createHash("sha256");
  let received = 0;
  let nextReport = 0.05;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (received > size) { callback(new Error(`${label} is larger than Hugging Face said`)); return; }
      if (received / size >= nextReport) { log(`${label}: ${Math.floor((received / size) * 100)}% of ${(size / 1e9).toFixed(2)} GB`, "stdout"); nextReport += 0.05; }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial, { mode: 0o644 }));
    const digest = hash.digest("hex");
    if (received !== size) throw new Error(`${label} arrived with ${received} bytes, not ${size}`);
    if (digest !== sha256) throw new Error(`${label} did not match its SHA-256; it was not kept`);
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}

export async function agentsModelDownload(parameters = {}, { log = () => {}, run, fetcher = fetch, paths = agentsPaths } = {}) {
  const model = readModelParameters(parameters);
  const info = await (await fetchTrusted(`https://huggingface.co/api/models/${model.repo}/revision/main?blobs=true`, { fetcher })).json();
  const commit = typeof info?.sha === "string" && /^[a-f0-9]{40}$/.test(info.sha) ? info.sha : null;
  if (!commit) throw new Error("Hugging Face did not say which revision is current");
  const siblings = new Map((Array.isArray(info.siblings) ? info.siblings : []).map((entry) => [entry?.rfilename, entry]));
  const wanted = [model.file, ...(model.projector ? [model.projector] : [])].map((file) => {
    const entry = siblings.get(file);
    const sha256 = entry?.lfs?.sha256 ?? entry?.lfs?.oid;
    const size = entry?.lfs?.size ?? entry?.size;
    if (!entry || !/^[a-f0-9]{64}$/.test(sha256 ?? "") || !Number.isInteger(size) || size <= 0) throw new Error(`${model.repo} has no ${file} with a published checksum`);
    return { file, sha256, size };
  });
  const base = cacheDirectory(paths.state, model.repo);
  await mkdir(path.join(base, "blobs"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(base, "snapshots", commit), { recursive: true, mode: 0o755 });
  await mkdir(path.join(base, "refs"), { recursive: true, mode: 0o755 });
  const missing = [];
  for (const entry of wanted) {
    const blob = path.join(base, "blobs", entry.sha256);
    const have = await stat(blob).catch(() => null);
    if (have?.size === entry.size) { log(`${entry.file} is already downloaded`, "stdout"); continue; }
    missing.push(entry);
  }
  const needed = missing.reduce((sum, entry) => sum + entry.size, 0);
  const free = await statfs(paths.state).then((fs) => fs.bavail * fs.bsize, () => null);
  if (free !== null && needed * 1.1 + 2e9 > free) throw new Error(`Not enough space: ${(needed / 1e9).toFixed(1)} GB to download and ${(free / 1e9).toFixed(1)} GB free`);
  for (const entry of missing) {
    await downloadVerified(`https://huggingface.co/${model.repo}/resolve/${commit}/${encodeURIComponent(entry.file)}`, path.join(base, "blobs", entry.sha256), { size: entry.size, sha256: entry.sha256, fetcher, log, label: entry.file });
  }
  for (const entry of wanted) {
    const link = path.join(base, "snapshots", commit, entry.file);
    const target = path.join("..", "..", "blobs", entry.sha256);
    const current = await readlink(link).catch(() => null);
    if (current !== target) { await unlink(link).catch(() => {}); await symlink(target, link); }
  }
  await writeFile(path.join(base, "refs", "main"), commit, { mode: 0o644 });
  // The runner reads the cache as its own user.
  await run("/usr/bin/chown", ["-R", `${paths.user}:${paths.user}`, path.join(paths.state, "hf")], { timeout: 5 * 60_000 }).catch(() => null);
  return { ...model, commit, bytes: wanted.reduce((sum, entry) => sum + entry.size, 0), downloaded: missing.map((entry) => entry.file) };
}

export async function agentsModelRemove(parameters = {}, { paths = agentsPaths } = {}) {
  const model = readModelParameters(parameters);
  if (parameters.current === `${model.repo}/${model.file}`) throw new Error("That is the model agents use now; switch to another first");
  const removed = [];
  for (const file of [model.file, ...(model.projector ? [model.projector] : [])]) {
    const found = await cachedFile(paths.state, model.repo, file);
    if (!found) continue;
    await rm(found.path, { force: true });
    await rm(path.join(cacheDirectory(paths.state, model.repo), "snapshots", found.commit, file), { force: true });
    removed.push(file);
  }
  return { ...model, removed };
}

/**
 * The model server, as the agents runner keeps it (M37): started when a run needs it, stopped when
 * nothing has used it for a while, and always a child of the runner, so it lives in the runner's
 * cgroup and under the same hard caps (deploy/boxpilot-agents.service). Stopped means no model at
 * all: no process, no memory held, 0% processor.
 *
 * Built to the Unsloth spike (docs/spikes/2026-09-unsloth-headless.md):
 *
 * - unsloth: `unsloth run --model <repo:quant> --api-only --disable-tools -H 127.0.0.1 -p <port>
 *   --context-length 8192 --parallel 1 --threads 4 -c 8192 --ctx-checkpoints 4 --batch-size 512
 *   --cache-ram 1024`, offline against the models the download operation put in the Hugging Face
 *   cache.
 *   - --disable-tools is not optional: Studio's server-side tools (Python, a shell, web search) are on
 *     by default for every bind in the release the spike measured.
 *   - -c 8192 is passed through to llama-server as well as --context-length, because Unsloth's idle
 *     reload forgets --context-length and relaunches at the GGUF's 262,144 tokens, which the memory
 *     cap kills. --ctx-checkpoints 4 stops the hybrid model's checkpoints growing memory after load.
 *   - Threads: one for each whole processor in the runner's quota (caps.mjs: four); more spend the
 *     quota faster and then sit throttled, as the spike measured at one processor.
 *   - --batch-size 512: llama-server notices a closed connection between batches, so a call the
 *     runner gives up on stops within 512 tokens instead of 2,048 (the physical batch is 512 anyway,
 *     so reading is no slower).
 *   - --cache-ram 1024: llama-server keeps earlier prompts in memory to reuse them (8 GiB unless
 *     told), and each of this hybrid model's holds its checkpoints too; a gigabyte keeps the last
 *     few inside the 8 GB memory cap.
 *   - UNSLOTH_MODEL_IDLE_TTL=900: Unsloth frees the model itself after 15 quiet minutes (about 2 GB)
 *     and reloads it in about 4 s on the next request; this runner stops the whole server, its Python
 *     backend too, after the owner's longer idle time (an hour by default).
 *   - UNSLOTH_STUDIO_PASSWORD: Studio's management API stays mounted under --api-only and creates an
 *     admin account on first start; its password is a secret the runner keeps in its own state
 *     (0600), not the generated one Studio would print. Studio takes it only as the first password:
 *     given again once one is set, `unsloth run` stops at once ("an Unsloth admin password is
 *     already set"). So it is passed until a start has taken it (studio-password.set, in the
 *     runner's state), and a start refused that way - a password set before that file existed - is
 *     tried once more without it.
 *   - The API key Studio mints ("API Key: sk-unsloth-...", kept in its auth folder) is read from the
 *     output or that file, sent on every request, and never logged or reported. Lines that carry a
 *     key or a password never reach the log tail either.
 *   - Every request names the model (the repo): once Unsloth has unloaded it, /v1/models lists every
 *     GGUF in the cache, not only this one.
 * - llama-server: llama.cpp's own server from the same install, with no Studio layer (and no AGPL
 *   code running). ADR-005 leaves this choice to the owner; the spike measured it for embeddings, not
 *   chat. It gets its key from a file here (--api-key-file) and has no idle unload of its own.
 * - external: a model server the owner already runs on this machine; never started or stopped here.
 * - fake: server/agents/fake-model.mjs, for tests, the demo and the real-systemd cap test.
 */
import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDirectory, cachedFile } from "./host.mjs";

const fakeModelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-model.mjs");
const keyPattern = /API Key:\s*(sk-[A-Za-z0-9_-]{8,200})/;
const keyShape = /^sk-[A-Za-z0-9_-]{8,200}$/;
const secretLine = /password|api[ _-]?key|secret|bearer/i;
// Its own process group on Linux, so stopping it stops what it started too (Studio's llama-server).
const ownGroup = process.platform !== "win32";
export const unslothIdleUnloadSeconds = 900;
export const contextCheckpoints = 4;
export const promptBatch = 512;
export const promptCacheMiB = 1024;
/** In the runner's state once Studio has taken its admin password: it is not passed again. */
export const studioPasswordSetFile = "studio-password.set";
const passwordAlreadySet = /admin password is already set/i;

export class ModelUnavailable extends Error {
  constructor(message, reason = "model-unavailable") { super(message); this.reason = reason; }
}

/** A free loopback port: bind to 0, read it, close. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/**
 * A secret the runner keeps in its own state: read when it is there, made (0600, never over an
 * existing file or a link) when it is not. The runner's state is the runner's alone (0750).
 */
export async function ownSecret(file) {
  const info = await lstat(file).catch(() => null);
  if (info) {
    if (!info.isFile()) throw new ModelUnavailable(`${path.basename(file)} is not a plain file`);
    const value = (await readFile(file, "utf8")).trim();
    if (value.length >= 20) return value;
  }
  const value = randomBytes(24).toString("base64url");
  await writeFile(file, `${value}\n`, { mode: 0o600, flag: info ? "w" : "wx" });
  return value;
}

/** Studio keeps the key it minted in its auth folder; read when the start's output did not say it. */
export async function storedUnslothKey(runtimeDir) {
  const folder = path.join(runtimeDir, "auth");
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.startsWith(".cli_api_key")).sort();
  for (const name of names) {
    const info = await lstat(path.join(folder, name)).catch(() => null);
    if (!info?.isFile() || info.size > 1024) continue;
    const value = (await readFile(path.join(folder, name), "utf8").catch(() => "")).trim();
    if (keyShape.test(value)) return value;
  }
  return null;
}

/** Where llama.cpp's server is in Unsloth's install; the first that is there. */
export const llamaServerCandidates = ["bin/llama-server", "llama.cpp/build/bin/llama-server", "llama.cpp/llama-server", "llama.cpp/bin/llama-server"];

export async function findLlamaServer(runtimeDir, { override = process.env.BOXPILOT_AGENTS_LLAMA_SERVER ?? null } = {}) {
  for (const candidate of override ? [override] : llamaServerCandidates.map((relative) => path.join(runtimeDir, relative))) {
    const info = await lstat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  throw new ModelUnavailable("llama-server was not found in the Unsloth install", "no-model");
}

/** A downloaded model's file by its snapshot link, as llama-server is handed it. */
async function modelFile(stateDir, repo, file) {
  const found = await cachedFile(stateDir, repo, file);
  if (!found) throw new ModelUnavailable(`${file} is not downloaded`, "no-model");
  return path.join(cacheDirectory(stateDir, repo), "snapshots", found.commit, file);
}

const basePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The command that serves this runtime's model on `port`. Pure: the files and secrets it needs are
 * found first (`prepare`), so what is run can be read and tested as a list of words.
 */
export function serverCommand(runtime, { port, runtimeDir, stateDir, node = process.execPath, fake = {}, secrets = {}, files = {} }) {
  const threads = String(Math.max(1, Math.trunc(runtime.threads ?? 1)));
  const context = String(runtime.contextTokens ?? 8192);
  if (runtime.driver === "fake") {
    return { command: node, args: [fakeModelPath, "--port", String(port), "--busy-threads", String(fake.busyThreads ?? 0), "--busy-ms", String(fake.busyMs ?? 0)], env: {} };
  }
  const quiet = { HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", HOME: stateDir };
  if (runtime.driver === "unsloth") {
    if (!/^[A-Za-z0-9._/-]{1,160}:[A-Za-z0-9._-]{1,60}$/.test(runtime.model ?? "")) throw new ModelUnavailable("No model is chosen for agents", "no-model");
    if (!secrets.studioPassword) throw new ModelUnavailable("Unsloth Studio's password is missing");
    return {
      command: path.join(runtimeDir, "bin", "unsloth"),
      args: ["run", "--model", runtime.model, "--api-only", "--disable-tools", "-H", "127.0.0.1", "-p", String(port),
        "--context-length", context, "--parallel", "1", "--threads", threads,
        // Passed through to llama-server: kept by Unsloth's idle reload, which forgets --context-length.
        "-c", context, "--ctx-checkpoints", String(contextCheckpoints), "--batch-size", String(promptBatch), "--cache-ram", String(promptCacheMiB)],
      env: {
        ...quiet,
        PATH: `${path.join(runtimeDir, "bin")}:${basePath}`,
        HF_HOME: path.join(stateDir, "hf"),
        HF_HUB_OFFLINE: "1",
        UNSLOTH_STUDIO_HOME: runtimeDir,
        UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK: "1",
        UNSLOTH_MODEL_IDLE_TTL: String(unslothIdleUnloadSeconds),
        // Only until Studio has it: given again, `unsloth run` refuses to start.
        ...(secrets.studioPasswordSet ? {} : { UNSLOTH_STUDIO_PASSWORD: secrets.studioPassword }),
      },
    };
  }
  if (runtime.driver === "llama-server") {
    if (!files.binary || !files.model || !secrets.apiKeyFile) throw new ModelUnavailable("No model is chosen for agents", "no-model");
    return {
      command: files.binary,
      args: ["-m", files.model, ...(files.projector ? ["--mmproj", files.projector] : []), "--alias", runtime.requestModel ?? "agents",
        "--host", "127.0.0.1", "--port", String(port), "-c", context, "--parallel", "1", "--threads", threads,
        "--ctx-checkpoints", String(contextCheckpoints), "--batch-size", String(promptBatch), "--cache-ram", String(promptCacheMiB), "--jinja", "--no-webui", "--api-key-file", secrets.apiKeyFile],
      env: { ...quiet, PATH: basePath, LD_LIBRARY_PATH: path.dirname(files.binary) },
    };
  }
  throw new ModelUnavailable(`The ${runtime.driver} runtime is not started by the runner`);
}

export function createRuntime({
  spawn = spawnProcess,
  client,
  runtimeDir = process.env.BOXPILOT_AGENTS_RUNTIME ?? "/var/lib/boxpilot-agents/unsloth",
  stateDir = process.env.BOXPILOT_AGENTS_STATE ?? "/var/lib/boxpilot-agents",
  now = () => Date.now(),
  startTimeoutMs = 15 * 60_000,
  // Studio answers /v1/models before the model is in its list; after this long answering, it is used.
  listWaitMs = 120_000,
  driverOverride = process.env.BOXPILOT_AGENTS_DRIVER_OVERRIDE ?? null,
  fake = { busyThreads: Number(process.env.BOXPILOT_AGENTS_FAKE_BUSY_THREADS ?? 0), busyMs: Number(process.env.BOXPILOT_AGENTS_FAKE_BUSY_MS ?? 0) },
  log = () => {},
  pollMs = 1_000,
} = {}) {
  let child = null;   // { process, spec, endpoint, apiKey, model, startedAt, lastUsed, idleStopMs }
  let phase = "idle";
  let starting = null;

  const specOf = (runtime) => [runtime.driver, runtime.model, runtime.requestModel, runtime.file, runtime.projector, runtime.contextTokens, runtime.threads].map((part) => part ?? "").join("|");

  /** The secrets and files a start needs, found before anything is run. */
  const passwordSetPath = path.join(stateDir, studioPasswordSetFile);
  async function prepare(runtime) {
    if (runtime.driver === "unsloth") {
      const studioPassword = await ownSecret(path.join(stateDir, "studio-password"));
      return { secrets: { studioPassword, studioPasswordSet: Boolean((await lstat(passwordSetPath).catch(() => null))?.isFile()) }, files: {} };
    }
    if (runtime.driver === "llama-server") {
      const apiKeyFile = path.join(stateDir, "llama-server.key");
      const apiKey = await ownSecret(apiKeyFile);
      const files = { binary: await findLlamaServer(runtimeDir), model: await modelFile(stateDir, runtime.repo, runtime.file), projector: runtime.projector ? await modelFile(stateDir, runtime.repo, runtime.projector) : null };
      return { secrets: { apiKeyFile }, files, apiKey };
    }
    return { secrets: {}, files: {} };
  }

  const answersFor = (models, name) => models.some((entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.name.toLowerCase().startsWith(`${name.toLowerCase()}:`));

  async function waitReady(entry, runtime, signal) {
    const deadline = now() + startTimeoutMs;
    let answeringSince = null;
    while (now() < deadline) {
      if (signal?.aborted) throw new ModelUnavailable("The run stopped while the model was starting");
      if (entry.exited) throw new ModelUnavailable(`The model server stopped while starting${entry.tail.length ? `: ${entry.tail.slice(-3).join(" | ")}` : ""}`);
      if (entry.driver === "unsloth" && !entry.apiKey && now() - entry.startedAt > 5_000) entry.apiKey = await storedUnslothKey(runtimeDir);
      if (entry.apiKey || entry.driver === "fake") {
        const models = await client.models(entry.endpoint, { apiKey: entry.apiKey, timeoutMs: 2_000 }).catch(() => null);
        if (entry.driver === "fake" && models?.length) return models[0].name;
        if (Array.isArray(models) && entry.driver !== "fake") {
          const name = runtime.requestModel ?? models[0]?.name;
          answeringSince ??= now();
          if (name && (answersFor(models, name) || now() - answeringSince >= listWaitMs)) return name;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new ModelUnavailable(`The model server did not answer within ${Math.round(startTimeoutMs / 60_000)} minutes`);
  }

  async function start(runtime, signal, { retried = false } = {}) {
    await stop("switching");
    const port = await freePort();
    let prepared;
    try {
      prepared = await prepare(runtime);
    } catch (error) {
      if (error instanceof ModelUnavailable) throw error;
      throw new ModelUnavailable(`The model server could not be prepared: ${error.message}`);
    }
    const { command, args, env } = serverCommand(runtime, { port, runtimeDir, stateDir, fake, secrets: prepared.secrets, files: prepared.files });
    const entry = { driver: runtime.driver, spec: specOf(runtime), endpoint: `http://127.0.0.1:${port}`, apiKey: prepared.apiKey ?? null, model: null, startedAt: now(), lastUsed: now(), idleStopMs: runtime.idleStopMs ?? 3_600_000, tail: [], exited: false };
    phase = "starting";
    let spawned;
    try {
      spawned = spawn(command, args, { env: { PATH: basePath, LANG: "C.UTF-8", ...env }, stdio: ["ignore", "pipe", "pipe"], detached: ownGroup });
    } catch (error) {
      phase = "idle";
      throw new ModelUnavailable(`The model server could not be started: ${error.message}`);
    }
    entry.process = spawned;
    const read = (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const key = keyPattern.exec(line);
        if (key) entry.apiKey = key[1];
        if (passwordAlreadySet.test(line)) entry.passwordAlreadySet = true;
        // Kept for a failure message. A line that carries a key or a password is not kept at all:
        // Studio prints its generated admin password on first start.
        if (key || secretLine.test(line)) continue;
        const clean = line.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]").trim();
        if (clean) { entry.tail.push(clean.slice(0, 300)); if (entry.tail.length > 30) entry.tail.shift(); }
      }
    };
    spawned.stdout?.on("data", read);
    spawned.stderr?.on("data", read);
    spawned.once("error", (error) => { entry.exited = true; entry.tail.push(`could not start: ${error.message}`); });
    spawned.once("exit", (code, signalName) => {
      entry.exited = true;
      if (child === entry) { child = null; phase = "idle"; log(`model server exited (${code ?? signalName})`); }
    });
    child = entry;
    try {
      entry.model = await waitReady(entry, runtime, signal);
    } catch (error) {
      await stop("failed to start");
      // Studio already has its admin password (set before BoxPilot kept track): again without it.
      if (entry.passwordAlreadySet && runtime.driver === "unsloth" && !prepared.secrets.studioPasswordSet && !retried) {
        await notePasswordSet();
        log("Studio's admin password was already set; starting again without passing it");
        return start(runtime, signal, { retried: true });
      }
      throw entry.passwordAlreadySet ? new ModelUnavailable("Unsloth Studio refused to start: its admin password is already set, and starting without passing it failed too") : error;
    }
    phase = "running";
    entry.loadMs = now() - entry.startedAt;
    if (runtime.driver === "unsloth" && !prepared.secrets.studioPasswordSet) await notePasswordSet();
    return entry;
  }

  /** Studio has its admin password now: later starts leave it out. */
  async function notePasswordSet() {
    await writeFile(passwordSetPath, `${new Date(now()).toISOString()}\n`, { mode: 0o600 }).catch((error) => log(`could not note that Studio's password is set: ${error.message}`));
  }

  /**
   * A model ready to answer: the running one when it is the one asked for, otherwise a fresh start
   * (which is counted as the run's load time). External servers are only checked.
   */
  async function ensure(requested, { signal } = {}) {
    const runtime = driverOverride ? { ...requested, driver: driverOverride } : requested;
    if (runtime.driver === "external") {
      if (!runtime.endpoint) throw new ModelUnavailable("No model server address is set for agents", "no-model");
      const models = await client.models(runtime.endpoint, { timeoutMs: 5_000 }).catch(() => null);
      if (!models?.length) throw new ModelUnavailable("The model server on this machine did not answer");
      return { endpoint: runtime.endpoint, apiKey: null, model: models[0].name, loadMs: 0 };
    }
    if (child && !child.exited && child.spec === specOf(runtime) && phase === "running") {
      child.lastUsed = now();
      child.idleStopMs = runtime.idleStopMs ?? child.idleStopMs;
      return { endpoint: child.endpoint, apiKey: child.apiKey, model: child.model, loadMs: 0 };
    }
    starting ??= start(runtime, signal).finally(() => { starting = null; });
    const entry = await starting;
    return { endpoint: entry.endpoint, apiKey: entry.apiKey, model: entry.model, loadMs: entry.loadMs ?? 0 };
  }

  function touch() { if (child) child.lastUsed = now(); }

  /** A signal to the server and everything it started; the process alone where there are no groups. */
  function signalServer(entry, signalName) {
    const pid = entry?.process?.pid;
    if (ownGroup && Number.isInteger(pid) && pid > 1) {
      try { process.kill(-pid, signalName); return; } catch { /* the group is gone: the process alone */ }
    }
    try { entry?.process?.kill(signalName); } catch { /* already gone */ }
  }

  /** Stop the model server: politely, then firmly after ten seconds. */
  async function stop(reason = "idle") {
    const entry = child;
    if (!entry) return false;
    child = null;
    phase = "stopping";
    log(`stopping the model server (${reason})`);
    if (!entry.exited) {
      signalServer(entry, "SIGTERM");
      const ended = await Promise.race([
        new Promise((resolve) => { if (entry.exited) resolve(true); else entry.process?.once("exit", () => resolve(true)); }),
        new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 10_000); timer.unref?.(); }),
      ]);
      if (!ended) signalServer(entry, "SIGKILL");
    }
    phase = "idle";
    return true;
  }

  /** Called between polls: an idle model server is stopped, so idle means nothing running. */
  async function maybeStopIdle() {
    if (child && phase === "running" && now() - child.lastUsed > child.idleStopMs) await stop("idle");
  }

  function status() {
    return { state: phase, modelLoaded: Boolean(child && phase === "running"), model: child?.model ?? null, pid: child?.process?.pid ?? null };
  }

  return { ensure, touch, stop, maybeStopIdle, status, killNow: () => { if (child) signalServer(child, "SIGKILL"); } };
}

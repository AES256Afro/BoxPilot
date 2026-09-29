/**
 * The model server, as the agents runner keeps it (M37): started when a run needs it, stopped when
 * nothing has used it for a while, and always a child of the runner, so it lives in the runner's
 * cgroup and under the same hard caps (deploy/boxpilot-agents.service). Idle means no model at all:
 * no process, no memory held, 0% processor.
 *
 * Drivers:
 * - unsloth: `unsloth run --model <repo:quant> --api-only --disable-tools -H 127.0.0.1 -p <port>
 *   --context-length <n> --parallel 1 --threads <n>`, offline against the models the download
 *   operation put in the Hugging Face cache. It binds to loopback only; its JupyterLab and SSH are
 *   never started (they belong to Unsloth's container image, which BoxPilot does not use), and the
 *   unit's IPAddressDeny=any keeps everything but loopback out either way.
 * - external: a model server the owner already runs on this machine; never started or stopped here.
 * - fake: server/agents/fake-model.mjs, for tests, the demo and the real-systemd cap test.
 *
 * Unsloth prints a per-start API key ("API Key: sk-unsloth-..."); it is read from the child's
 * output, used on every request, and never logged or reported.
 */
import { spawn as spawnProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fakeModelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-model.mjs");
const keyPattern = /API Key:\s*(sk-[A-Za-z0-9_-]{8,200})/;

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

/** The command that serves this runtime's model on `port`. */
export function serverCommand(runtime, { port, runtimeDir, stateDir, node = process.execPath, fake = {} }) {
  if (runtime.driver === "fake") {
    return { command: node, args: [fakeModelPath, "--port", String(port), "--busy-threads", String(fake.busyThreads ?? 0), "--busy-ms", String(fake.busyMs ?? 0)], env: {} };
  }
  if (runtime.driver !== "unsloth") throw new ModelUnavailable(`The ${runtime.driver} runtime is not started by the runner`);
  if (!/^[A-Za-z0-9._/-]{1,160}:[A-Za-z0-9._-]{1,60}$/.test(runtime.model ?? "")) throw new ModelUnavailable("No model is chosen for agents", "no-model");
  return {
    command: path.join(runtimeDir, "bin", "unsloth"),
    args: ["run", "--model", runtime.model, "--api-only", "--disable-tools", "-H", "127.0.0.1", "-p", String(port),
      "--context-length", String(runtime.contextTokens ?? 8192), "--parallel", "1", "--threads", String(runtime.threads ?? 2)],
    env: {
      HF_HOME: path.join(stateDir, "hf"),
      HF_HUB_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK: "1",
      UNSLOTH_STUDIO_HOME: runtimeDir,
      HOME: stateDir,
    },
  };
}

export function createRuntime({
  spawn = spawnProcess,
  client,
  runtimeDir = process.env.BOXPILOT_AGENTS_RUNTIME ?? "/opt/boxpilot-agents/unsloth",
  stateDir = process.env.BOXPILOT_AGENTS_STATE ?? "/var/lib/boxpilot-agents",
  now = () => Date.now(),
  startTimeoutMs = 15 * 60_000,
  driverOverride = process.env.BOXPILOT_AGENTS_DRIVER_OVERRIDE ?? null,
  fake = { busyThreads: Number(process.env.BOXPILOT_AGENTS_FAKE_BUSY_THREADS ?? 0), busyMs: Number(process.env.BOXPILOT_AGENTS_FAKE_BUSY_MS ?? 0) },
  log = () => {},
  pollMs = 1_000,
} = {}) {
  let child = null;   // { process, spec, endpoint, apiKey, model, startedAt, lastUsed, idleStopMs }
  let phase = "idle";
  let starting = null;

  const specOf = (runtime) => `${runtime.driver}|${runtime.model ?? ""}|${runtime.contextTokens ?? ""}|${runtime.threads ?? ""}`;

  async function waitReady(entry, signal) {
    const deadline = now() + startTimeoutMs;
    while (now() < deadline) {
      if (signal?.aborted) throw new ModelUnavailable("The run stopped while the model was starting");
      if (entry.exited) throw new ModelUnavailable(`The model server stopped while starting${entry.tail.length ? `: ${entry.tail.slice(-3).join(" | ")}` : ""}`);
      if (entry.apiKey || entry.driver === "fake") {
        const models = await client.models(entry.endpoint, { apiKey: entry.apiKey, timeoutMs: 2_000 }).catch(() => null);
        if (models?.length) return models[0].name;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new ModelUnavailable(`The model server did not answer within ${Math.round(startTimeoutMs / 60_000)} minutes`);
  }

  async function start(runtime, signal) {
    await stop("switching");
    const port = await freePort();
    const { command, args, env } = serverCommand(runtime, { port, runtimeDir, stateDir, fake });
    const entry = { driver: runtime.driver, spec: specOf(runtime), endpoint: `http://127.0.0.1:${port}`, apiKey: null, model: null, startedAt: now(), lastUsed: now(), idleStopMs: runtime.idleStopMs ?? 600_000, tail: [], exited: false };
    phase = "starting";
    const started = now();
    let spawned;
    try {
      spawned = spawn(command, args, { env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      phase = "idle";
      throw new ModelUnavailable(`The model server could not be started: ${error.message}`);
    }
    entry.process = spawned;
    const read = (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const key = keyPattern.exec(line);
        if (key) entry.apiKey = key[1];
        // Kept for a failure message; the key never is.
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
      entry.model = await waitReady(entry, signal);
    } catch (error) {
      await stop("failed to start");
      throw error;
    }
    phase = "running";
    entry.loadMs = now() - started;
    return entry;
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

  /** Stop the model server: politely, then firmly after ten seconds. */
  async function stop(reason = "idle") {
    const entry = child;
    if (!entry) return false;
    child = null;
    phase = "stopping";
    log(`stopping the model server (${reason})`);
    if (!entry.exited) {
      entry.process?.kill("SIGTERM");
      const ended = await Promise.race([
        new Promise((resolve) => { if (entry.exited) resolve(true); else entry.process?.once("exit", () => resolve(true)); }),
        new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 10_000); timer.unref?.(); }),
      ]);
      if (!ended) entry.process?.kill("SIGKILL");
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

  return { ensure, touch, stop, maybeStopIdle, status, killNow: () => { child?.process?.kill("SIGKILL"); } };
}
